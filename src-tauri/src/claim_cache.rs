use crate::{claim, store};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(10);

#[derive(Default)]
struct Entry {
    binding: String,
    generation: u64,
    fetched: Option<Instant>,
    plans: Vec<claim::ClaimPlan>,
}

#[derive(Default)]
struct PreviewCache(Mutex<HashMap<String, Entry>>);

impl PreviewCache {
    fn read(&self, account: &str, binding: &str, force: bool,
        fetch: impl FnOnce() -> Result<Vec<claim::ClaimPlan>, claim::ClaimError>) -> Result<(Vec<claim::ClaimPlan>, bool), claim::ClaimError> {
        let generation = {
            let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
            if entries.len() >= 128 && !entries.contains_key(account) { entries.clear(); }
            let entry = entries.entry(account.into()).or_default();
            if entry.binding != binding {
                entry.binding = binding.into();
                entry.generation = entry.generation.wrapping_add(1);
                entry.fetched = None;
                entry.plans.clear();
            }
            if !force && entry.fetched.is_some_and(|at| at.elapsed() < TTL) {
                return Ok((entry.plans.clone(), true));
            }
            entry.generation
        };
        let plans = fetch()?;
        let mut entries = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = entries.get_mut(account) {
            // A result started before a claim/account change must not repopulate the cache.
            if entry.generation == generation && entry.binding == binding {
                entry.fetched = Some(Instant::now());
                entry.plans = plans.clone();
            }
        }
        Ok((plans, false))
    }

    fn invalidate(&self, account: &str) {
        if let Some(entry) = self.0.lock().unwrap_or_else(|e| e.into_inner()).get_mut(account) {
            entry.generation = entry.generation.wrapping_add(1);
            entry.fetched = None;
            entry.plans.clear();
        }
    }
}

fn cache() -> &'static PreviewCache {
    static CACHE: OnceLock<PreviewCache> = OnceLock::new();
    CACHE.get_or_init(PreviewCache::default)
}

pub fn preview(paths: &store::Paths, account: &store::Account, mid: &str, force: bool)
    -> Result<(Vec<claim::ClaimPlan>, bool), claim::ClaimError> {
    let binding = format!("{:x}", Sha256::digest(serde_json::to_vec(
        &(&account.credentials, &account.config, mid)).map_err(|_| "Invalid account data".to_string())?));
    cache().read(&account.id, &binding, force, || claim::preview_plans_detailed(
        &paths.home, &account.credentials, account.config.as_ref(), Some(mid.into())))
}

pub fn invalidate(account: &str) { cache().invalidate(account); }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cached_results_are_bound_to_account_credentials_and_force_refresh() {
        let cache = PreviewCache::default();
        assert!(!cache.read("a", "credential-and-device-A", false, || Ok(vec![])).unwrap().1);
        assert!(cache.read("a", "credential-and-device-A", false, || panic!("cache miss")).unwrap().1);
        assert!(!cache.read("a", "credential-and-device-B", false, || Ok(vec![])).unwrap().1);
        assert!(!cache.read("a", "credential-and-device-B", true, || Ok(vec![])).unwrap().1);
        assert!(!cache.read("b", "credential-and-device-B", false, || Ok(vec![])).unwrap().1);
    }
    #[test]
    fn invalidation_prevents_inflight_stale_query_from_becoming_cached() {
        let cache = PreviewCache::default();
        cache.read("a", "key", false, || { cache.invalidate("a"); Ok(vec![]) }).unwrap();
        assert!(!cache.read("a", "key", false, || Ok(vec![])).unwrap().1);
        cache.invalidate("a");
        assert!(!cache.read("a", "key", false, || Ok(vec![])).unwrap().1);
    }
}
