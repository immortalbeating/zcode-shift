use serde::Serialize;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

const RELEASE_API: &str = "https://api.github.com/repos/immortalbeating/zcode-shift/releases/latest";
const RELEASE_BASE: &str = "https://github.com/immortalbeating/zcode-shift/releases/tag/";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyTestResult { reachable: bool, elapsed_ms: u64 }

#[tauri::command]
pub async fn test_auth_proxy(url: String) -> Result<ProxyTestResult, String> {
    let normalized = crate::oauth::parse_proxy_url(&url).map_err(|_| "invalid_proxy".to_string())?;
    let authority = normalized.split_once("://").ok_or("invalid_proxy")?.1.to_string();
    tauri::async_runtime::spawn_blocking(move || probe_proxy(&authority)).await
        .map_err(|_| "proxy_test_failed".to_string())
}

fn probe_proxy(authority: &str) -> ProxyTestResult {
    let start = Instant::now();
    let deadline = start + Duration::from_secs(3);
    // DNS resolution can block independently of socket timeouts; bound the wait for it.
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let address = authority.to_string();
    std::thread::spawn(move || {
        let addresses = address.to_socket_addrs().map(|a| a.take(8).collect::<Vec<_>>());
        let _ = tx.send(addresses);
    });
    let mut reachable = false;
    if let Ok(Ok(addresses)) = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        for address in addresses {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() { break; }
            if TcpStream::connect_timeout(&address, remaining).is_ok() { reachable = true; break; }
        }
    }
    ProxyTestResult { reachable, elapsed_ms: start.elapsed().as_millis().min(u64::MAX as u128) as u64 }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    status: &'static str,
    current_version: String,
    latest_version: Option<String>,
    release_url: Option<String>,
}

fn stable_version(tag: &str) -> Option<[u64; 3]> {
    let version = tag.strip_prefix('v')?;
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3 { return None; }
    let mut result = [0; 3];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) || (part.len() > 1 && part.starts_with('0')) { return None; }
        result[i] = part.parse().ok()?;
    }
    Some(result)
}

fn unpublished() -> UpdateCheck {
    UpdateCheck { status: "unpublished", current_version: env!("CARGO_PKG_VERSION").into(), latest_version: None, release_url: None }
}

fn http_failure(status: u16) -> Result<UpdateCheck, String> {
    if status == 404 { Ok(unpublished()) } else { Err("update_http_failed".into()) }
}

fn interpret_release(value: &serde_json::Value) -> Result<UpdateCheck, String> {
    if value.get("draft").and_then(|v| v.as_bool()) != Some(false)
        || value.get("prerelease").and_then(|v| v.as_bool()) != Some(false) {
        return Err("invalid_release".into());
    }
    let tag = value.get("tag_name").and_then(|v| v.as_str()).ok_or("invalid_release")?;
    let latest = stable_version(tag).ok_or("invalid_release")?;
    let current = stable_version(&format!("v{}", env!("CARGO_PKG_VERSION"))).ok_or("invalid_current_version")?;
    Ok(UpdateCheck {
        status: if latest > current { "available" } else { "current" },
        current_version: env!("CARGO_PKG_VERSION").into(), latest_version: Some(tag.into()),
        release_url: Some(format!("{RELEASE_BASE}{tag}")),
    })
}

#[tauri::command]
pub async fn check_updates() -> Result<UpdateCheck, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let agent = ureq::AgentBuilder::new().redirects(0).timeout_connect(Duration::from_secs(3))
            .timeout_read(Duration::from_secs(5)).timeout_write(Duration::from_secs(5)).build();
        match agent.get(RELEASE_API).set("User-Agent", "zcode-shift-update-check").call() {
            Ok(response) => {
                let value: serde_json::Value = response.into_json().map_err(|_| "update_parse_failed".to_string())?;
                interpret_release(&value)
            }
            Err(ureq::Error::Status(status, _)) => http_failure(status),
            Err(_) => Err("update_network_failed".into()),
        }
    }).await.map_err(|_| "update_check_failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_and_release_url_are_strict() {
        assert!(stable_version("v1.2.3").is_some());
        for tag in ["1.2.3", "v1.2.3-beta", "v01.2.3", "v1.2.3/evil"] { assert!(stable_version(tag).is_none()); }
        let result = interpret_release(&serde_json::json!({"draft":false,"prerelease":false,"tag_name":"v999.0.0","html_url":"https://evil.example"})).unwrap();
        assert_eq!(result.status, "available");
        assert_eq!(result.release_url.as_deref(), Some("https://github.com/immortalbeating/zcode-shift/releases/tag/v999.0.0"));
        assert!(interpret_release(&serde_json::json!({"draft":true,"prerelease":false,"tag_name":"v1.0.0"})).is_err());
        assert_eq!(http_failure(404).unwrap().status, "unpublished");
        assert!(http_failure(500).is_err());
    }
    #[test]
    fn loopback_port_probe() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(probe_proxy(&listener.local_addr().unwrap().to_string()).reachable);
    }
}
