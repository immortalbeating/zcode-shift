
use crate::quota;
use crate::zcrypto;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

pub const BILLING_PREVIEW_URL: &str = "https://zcode.z.ai/api/v1/zcode-plan/billing/preview";
pub const BILLING_CLAIM_URL: &str = "https://zcode.z.ai/api/v1/zcode-plan/billing/claim";
pub const MARKETING_TOUCH_URL: &str = "https://zcode.z.ai/api/v1/marketing/touch?seq=0";
pub const CLIENT_CONFIGS_URL: &str = "https://zcode.z.ai/api/v1/client/configs";

const CLAIM_TIMEOUT_SECS: u64 = 25;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClaimGrant {
    pub name: String,
    pub units: f64,
    pub period: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ClaimPlan {
    pub plan_id: String,
    pub name: String,
    pub description: String,
    pub priority: i64,
    pub grants: Vec<String>,
    #[serde(default)]
    pub grant_items: Vec<ClaimGrant>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptchaConfig {
    pub enabled: bool,
    pub region: String,
    pub prefix: String,
    pub scene_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOutcome {
    pub account_id: String,
    pub account_name: String,
    pub plan_id: String,
    pub plan_name: String,
    pub starts_at: Option<i64>,
    pub ends_at: Option<i64>,
    pub server_time: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimError {
    pub code: i64,
    pub message: String,
    pub next_at: Option<i64>,
}

impl From<String> for ClaimError {
    fn from(message: String) -> Self {
        ClaimError {
            code: -1,
            message,
            next_at: None,
        }
    }
}

fn claim_error(code: i64, body: &Value) -> ClaimError {
    let next_at = if code == 1005 {
        body.pointer("/data/plan/ends_at")
            .and_then(|x| x.as_i64())
            .map(|s| s * 1000)
    } else {
        None
    };
    ClaimError {
        code,
        message: failure_message(code, body),
        next_at,
    }
}

pub fn failure_payload(
    account_id: &str,
    account_name: &str,
    plan_id: &str,
    plan_name: &str,
    err: &ClaimError,
) -> Value {
    serde_json::json!({
        "ok": false,
        "accountId": account_id,
        "accountName": account_name,
        "planId": plan_id,
        "planName": plan_name,
        "code": err.code,
        "nextAt": err.next_at,
        "message": err.message,
    })
}

fn claim_token(creds: &Value, config: Option<&Value>, secret: &str) -> Result<String, String> {
    let jwt = creds
        .get("zcodejwttoken")
        .and_then(|v| v.as_str())
        .and_then(|v| decrypt_credential(v, secret));
    if let Some(t) = jwt.filter(|t| t.trim().len() > 20) {
        return Ok(t);
    }
    if let Some(t) = quota::zai_billing_token(creds, config, secret) {
        return Ok(t);
    }
    Err(crate::i18n::tr("err.claim.no_jwt"))
}

fn decrypt_credential(v: &str, secret: &str) -> Option<String> {
    if zcrypto::is_encrypted(v) {
        zcrypto::decrypt_with_secret(v, secret).ok()
    } else {
        Some(v.to_string())
    }
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(CLAIM_TIMEOUT_SECS))
        .build()
}

pub const EVENT_REPORT_URL: &str = "https://zcode.z.ai/api/v1/event/report";
pub const ACTIVATION_EVENTS: [&str; 2] = ["app_launch", "app_daily_active"];
const SCREEN_RESOLUTION: &str = "2560x1440";
const ACTIVATION_TIMEOUT_SECS: u64 = 10;

pub(crate) fn telemetry_user_id(home: &Path, creds: &Value) -> Option<String> {
    let secret = zcrypto::default_secret(home);
    let provider = creds
        .get("oauth:active_provider")
        .and_then(|v| v.as_str())
        .and_then(|v| decrypt_credential(v, &secret))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "zai".to_string());
    let raw = creds
        .get(format!("oauth:{provider}:user_info"))?
        .as_str()?;
    let plain = decrypt_credential(raw, &secret)?;
    let info: Value = serde_json::from_str(&plain).ok()?;
    let pick = |k: &str| {
        info.get(k)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    pick("id").or_else(|| pick("user_id")).map(String::from)
}

fn activation_event_body(element: &str, event_id: &str, user_id: &str, mid: &str) -> Value {
    serde_json::json!({
        "event_id": event_id,
        "client_timezone": quota::client_timezone(),
        "client_language": quota::ZCODE_LANG,
        "element_name": element,
        "event_region": "app",
        "event_type": "view",
        "event_text": "",
        "event_extra_detail": {},
        "user_id": user_id,
        "screen_resolution": SCREEN_RESOLUTION,
        "app_version": quota::zcode_app_version(),
        "device_os_category": device_os_category(),
        "device_os_version": quota::os_version().unwrap_or_default(),
        "device_mid": mid,
        "mac_id": "",
        "marketing_params": "{}",
    })
}

fn device_os_category() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    }
}

pub fn report_activation_events(user_id: &str, device_mid: &str) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout(Duration::from_secs(ACTIVATION_TIMEOUT_SECS))
        .build();
    for element in ACTIVATION_EVENTS {
        let body = activation_event_body(
            element,
            &uuid::Uuid::new_v4().to_string(),
            user_id,
            device_mid,
        );
        let resp = agent
            .post(EVENT_REPORT_URL)
            .set("Content-Type", "application/json")
            .send_json(body)
            .map_err(|e| {
                crate::i18n::trf("err.claim.activate_req", &[("e", http_err("", e).trim())])
            })?
            .into_string()
            .map_err(|e| crate::i18n::trf("err.claim.activate_req", &[("e", &e.to_string())]))?;
        let v: Value = serde_json::from_str(&resp).unwrap_or(Value::String(resp));
        let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
        if code != 0 {
            return Err(failure_message(code, &v));
        }
    }
    Ok(())
}

pub fn preview_plans(
    home: &Path,
    creds: &Value,
    config: Option<&Value>,
    device_mid: Option<String>,
) -> Result<Vec<ClaimPlan>, String> {
    preview_plans_detailed(home, creds, config, device_mid).map_err(|error| error.message)
}

pub fn preview_plans_detailed(
    home: &Path, creds: &Value, config: Option<&Value>, device_mid: Option<String>,
) -> Result<Vec<ClaimPlan>, ClaimError> {
    let secret = zcrypto::default_secret(home);
    let token = claim_token(creds, config, &secret)?;
    let url = format!(
        "{BILLING_PREVIEW_URL}?app_version={}&platform={}",
        quota::zcode_app_version(),
        quota::client_platform()
    );
    let plans = preview_once(&url, &token, device_mid.clone())?;
    let marketing = marketing_plans(&token, device_mid)?;
    Ok(merge_plans(plans, marketing))
}

fn marketing_plans(token: &str, mid: Option<String>) -> Result<Vec<ClaimPlan>, ClaimError> {
    let mut req = agent().get(MARKETING_TOUCH_URL);
    for (k, v) in quota::zai_billing_headers_with_mid(token, mid) {
        req = req.set(&k, &v);
    }
    let resp = req
        .set("X-Client-Language", "zh-CN")
        .set("X-ZCode-App-Version", &quota::zcode_app_version())
        .call()
        .map_err(|e| request_error("Marketing campaign discovery failed", e))?
        .into_string()
        .map_err(|e| format!("Marketing campaign discovery failed: {e}"))?;
    let body: Value = serde_json::from_str(&resp)
        .map_err(|e| format!("Marketing campaign discovery returned invalid JSON: {e}"))?;
    if body.get("code").and_then(Value::as_i64).is_some_and(|code| code != 0) {
        return Err(claim_error(body["code"].as_i64().unwrap(), &body));
    }
    parse_marketing_plans(&body).map_err(Into::into)
}

fn merge_plans(preview: Vec<ClaimPlan>, marketing: Vec<ClaimPlan>) -> Vec<ClaimPlan> {
    let mut seen = std::collections::HashSet::new();
    let mut plans: Vec<_> = preview.into_iter().chain(marketing)
        .filter(|plan| seen.insert(plan.plan_id.clone()))
        .collect();
    plans.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.plan_id.cmp(&b.plan_id)));
    plans
}

// Marketing copy has appeared as both strings and structured text objects.
fn marketing_text(value: Option<&Value>) -> String {
    fn text(value: &Value, depth: usize) -> Option<&str> {
        if depth > 4 { return None; }
        value.as_str().or_else(|| {
            ["text", "content", "value"].iter()
                .find_map(|key| value.get(key).and_then(|v| text(v, depth + 1)))
        })
    }
    value.and_then(|v| text(v, 0)).unwrap_or_default().trim().to_string()
}

fn parse_marketing_plans(body: &Value) -> Result<Vec<ClaimPlan>, String> {
    if body.get("code").and_then(Value::as_i64) != Some(0) {
        return Err(format!("Marketing campaign discovery failed: {}",
            failure_message(body.get("code").and_then(Value::as_i64).unwrap_or(-1), body)));
    }
    let deliveries = body.pointer("/data/deliveries").and_then(Value::as_array)
        .ok_or_else(|| "Marketing campaign discovery: expected data.deliveries array".to_string())?;
    let mut plans = Vec::new();
    for delivery in deliveries {
        let position = match delivery.get("resource_position").and_then(Value::as_str) {
            Some("popup") => "popup",
            Some("banner") => "banner",
            _ => continue,
        };
        let resource = delivery.get(position).ok_or_else(||
            format!("Marketing campaign discovery: missing {position} resource"))?;
        let buttons = resource.get("buttons").and_then(Value::as_array).ok_or_else(||
            format!("Marketing campaign discovery: expected {position}.buttons array"))?;
        for button in buttons {
            let action = &button["action"];
            if action.get("type").and_then(Value::as_str) != Some("claim_zcode_plan") {
                continue;
            }
            let plan_id = action.pointer("/args/plan_id").and_then(Value::as_str)
                .map(str::trim).filter(|id| !id.is_empty())
                .ok_or_else(|| "Marketing campaign discovery: claim_zcode_plan missing plan_id".to_string())?;
            let name = marketing_text(resource.get("title"));
            if let Some(plan) = resource.pointer("/background/args/zcode_plan")
                .and_then(parse_plan).filter(|plan| plan.plan_id == plan_id) {
                plans.push(plan);
                continue;
            }
            plans.push(ClaimPlan {
                plan_id: plan_id.to_string(),
                name: if name.is_empty() { plan_id.to_string() } else { name },
                description: marketing_text(resource.get("description")),
                priority: 0,
                grants: Vec::new(),
                grant_items: Vec::new(),
            });
        }
    }
    Ok(merge_plans(Vec::new(), plans))
}

fn http_err(prefix: &str, e: ureq::Error) -> String {
    if let ureq::Error::Status(code, resp) = e {
        let body = resp.into_string().unwrap_or_default();
        let msg = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| ["msg", "message", "error"]
                .iter()
                .find_map(|k| v.get(k).and_then(|x| x.as_str()).map(String::from)))
            .unwrap_or_default();
        return format!("{prefix} HTTP {code}: {msg}");
    }
    format!("{prefix} {e}")
}

fn preview_once(url: &str, token: &str, mid: Option<String>) -> Result<Vec<ClaimPlan>, ClaimError> {
    let mut req = agent().get(url);
    for (k, v) in quota::zai_billing_headers_with_mid(token, mid) {
        req = req.set(&k, &v);
    }
    let resp = req
        .call()
        .map_err(|e| request_error(&crate::i18n::tr("err.claim.preview_req"), e))?
        .into_string()
        .map_err(|e| crate::i18n::trf("err.http.read", &[("e", &e.to_string())]))?;
    let v: Value = serde_json::from_str(&resp).unwrap_or(Value::String(resp));
    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        return Err(claim_error(code, &v));
    }
    let plans = v
        .pointer("/data/plans")
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<ClaimPlan> = plans.iter().filter_map(parse_plan).collect();
    out.sort_by(|a, b| b.priority.cmp(&a.priority).then(a.plan_id.cmp(&b.plan_id)));
    Ok(out)
}

pub fn submit_claim(
    home: &Path,
    creds: &Value,
    config: Option<&Value>,
    plan_id: &str,
    captcha_param: &str,
    captcha_region: Option<&str>,
    device_mid: Option<String>,
) -> Result<Value, ClaimError> {
    if captcha_param.trim().is_empty() {
        return Err(crate::i18n::tr("err.claim.no_captcha").into());
    }
    let secret = zcrypto::default_secret(home);
    let token = claim_token(creds, config, &secret)?;
    let mut req = agent().post(BILLING_CLAIM_URL);
    for (k, v) in quota::zai_billing_headers_with_mid(&token, device_mid) {
        req = req.set(&k, &v);
    }
    req = req.set("X-Aliyun-Captcha-Verify-Param", captcha_param.trim());
    if let Some(r) = captcha_region.filter(|r| !r.trim().is_empty()) {
        req = req.set("X-Aliyun-Captcha-Verify-Region", r.trim());
    }
    let resp = req
        .send_json(serde_json::json!({ "plan_id": plan_id }))
        .map_err(claim_request_error)?
        .into_string()
        .map_err(|e| ClaimError {
            code: -1,
            message: crate::i18n::trf("err.http.read", &[("e", &e.to_string())]),
            next_at: None,
        })?;
    let v: Value = serde_json::from_str(&resp).unwrap_or(Value::String(resp));
    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        return Err(claim_error(code, &v));
    }
    Ok(v)
}

fn claim_request_error(error: ureq::Error) -> ClaimError {
    request_error(&crate::i18n::tr("err.claim.claim_req"), error)
}

fn request_error(prefix: &str, error: ureq::Error) -> ClaimError {
    let (code, next_at) = match &error {
        ureq::Error::Status(code, response) => {
            let next = response.header("Retry-After").and_then(|header| retry_after_at(header, chrono::Utc::now().timestamp_millis()));
            (*code as i64, next)
        }
        _ => (-1, None),
    };
    ClaimError { code, next_at, message: http_err(prefix, error) }
}

fn retry_after_at(header: &str, now: i64) -> Option<i64> {
    header.parse::<i64>().ok().filter(|seconds| *seconds >= 0)
        .and_then(|seconds| seconds.checked_mul(1000))
        .and_then(|delay| now.checked_add(delay))
        .or_else(|| chrono::DateTime::parse_from_rfc2822(header).ok().map(|time| time.timestamp_millis()))
}

pub fn fetch_captcha_config() -> Result<CaptchaConfig, String> {
    let url = format!("{CLIENT_CONFIGS_URL}?app_version={}&platform={}",
        quota::zcode_app_version(), quota::client_platform());
    let mut req = agent().get(&url);
    for (k, v) in quota::zai_billing_headers("") {
        req = req.set(&k, &v);
    }
    let resp = req
        .call()
        .map_err(|e| crate::i18n::trf("err.claim.config_req", &[("e", &e.to_string())]))?
        .into_string()
        .map_err(|e| crate::i18n::trf("err.http.read", &[("e", &e.to_string())]))?;
    let v: Value = serde_json::from_str(&resp).unwrap_or(Value::String(resp));
    if v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1) != 0 {
        return Err(crate::i18n::tr("err.claim.config_unavailable"));
    }
    let c = v.pointer("/data/configs/captcha").cloned().unwrap_or(Value::Null);
    let s = |k: &str| c.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
    Ok(CaptchaConfig {
        enabled: c.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false),
        region: s("region"),
        prefix: s("prefix"),
        scene_id: s("sceneId"),
    })
}

fn str_field<'a>(e: &'a Value, snake: &str, camel: &str) -> Option<&'a str> {
    e.get(snake)
        .and_then(|v| v.as_str())
        .or_else(|| e.get(camel).and_then(|v| v.as_str()))
}

fn num_field(e: &Value, snake: &str, camel: &str) -> Option<f64> {
    e.get(snake)
        .and_then(|v| v.as_f64())
        .or_else(|| e.get(camel).and_then(|v| v.as_f64()))
}

fn parse_plan(p: &Value) -> Option<ClaimPlan> {
    let plan_id = str_field(p, "plan_id", "planId")?.trim().to_string();
    if plan_id.is_empty() {
        return None;
    }
    let grant_items: Vec<ClaimGrant> = p
        .get("entitlements")
        .and_then(|e| e.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|e| {
                    str_field(e, "meter", "meter") == Some("model_usage")
                        && str_field(e, "unit_type", "unitType") == Some("token")
                        && str_field(e, "show_name", "showName")
                            .map(|s| !s.trim().is_empty())
                            .unwrap_or(false)
                })
                .map(|e| ClaimGrant {
                    name: str_field(e, "show_name", "showName").unwrap_or("").to_string(),
                    units: num_field(e, "grant_units", "grantUnits").unwrap_or(0.0),
                    period: str_field(e, "period", "period").unwrap_or("one_time").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let grants = grant_items
        .iter()
        .map(|g| {
            let period_cn = match g.period.as_str() {
                "daily" => "每日",
                "weekly" => "每周",
                "monthly" => "每月",
                _ => "一次性",
            };
            format!("{} · {} Token（{period_cn}）", g.name, fmt_units(g.units))
        })
        .collect();
    Some(ClaimPlan {
        name: p.get("name").and_then(|s| s.as_str()).unwrap_or("").trim().to_string(),
        description: p
            .get("description")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        priority: p.get("priority").and_then(|x| x.as_i64()).unwrap_or(0),
        plan_id,
        grants,
        grant_items,
    })
}

fn fmt_units(n: f64) -> String {
    let trim = |x: f64| {
        let r = (x * 10.0).round() / 10.0;
        if (r - r.trunc()).abs() < f64::EPSILON {
            format!("{}", r.trunc() as i64)
        } else {
            format!("{r:.1}")
        }
    };
    if n >= 1e8 {
        format!("{}亿", trim(n / 1e8))
    } else if n >= 1e4 {
        format!("{}万", trim(n / 1e4))
    } else {
        format!("{}", n.round() as i64)
    }
}

pub fn failure_message(code: i64, body: &Value) -> String {
    let server_msg = ["msg", "message"]
        .iter()
        .find_map(|k| body.get(k).and_then(|x| x.as_str()).map(String::from))
        .unwrap_or_default();
    let base = crate::i18n::tr(match code {
        1001 => "claim.fail.1001",
        1002 => "claim.fail.1002",
        1003 => "claim.fail.1003",
        1004 => "claim.fail.1004",
        1005 => "claim.fail.1005",
        3001 => "claim.fail.3001",
        3007 => "claim.fail.3007",
        401 => "claim.fail.401",
        _ => "claim.fail.generic",
    });
    if server_msg.is_empty() {
        base
    } else {
        crate::i18n::trf("claim.fail.with_server", &[("base", &base), ("server_msg", &server_msg)])
    }
}

#[cfg(test)]
mod marketing_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn http_failure_preserves_status_and_retry_after() {
        let response = ureq::Response::new(429, "Too Many Requests", "").unwrap();
        let failure = claim_request_error(ureq::Error::Status(429, response));
        assert_eq!(failure.code, 429);
        assert_eq!(retry_after_at("12", 1_000), Some(13_000));
        assert_eq!(retry_after_at("Wed, 21 Oct 2015 07:28:00 GMT", 0), Some(1445412480000));
        for header in ["-1", "unknown", "9223372036854775807"] { assert_eq!(retry_after_at(header, 1_000), None); }
    }

    #[test]
    fn extracts_only_claim_actions_and_structured_copy() {
        let body = json!({"code": 0, "data": {"deliveries": [
            {"campaign_id": "c1", "resource_position": "popup", "popup": {
                "title": {"text": {"value": " Activity "}},
                "description": {"content": " Details "},
                "buttons": [
                    {"action": {"type": "open_url", "args": {"plan_id": "unsafe"}}},
                    {"action": {"type": "unknown", "args": {"plan_id": "unknown"}}},
                    {"action": {"type": "claim_zcode_plan", "args": {"plan_id": " p1 "}}}
                ]}},
            {"resource_position": "banner", "banner": {"title": "Duplicate", "buttons": [
                {"action": {"type": "claim_zcode_plan", "args": {"plan_id": "p1"}}}
            ]}}
        ]}});
        let plans = parse_marketing_plans(&body).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].plan_id, "p1");
        assert_eq!(plans[0].name, "Activity");
        assert_eq!(plans[0].description, "Details");
    }

    #[test]
    fn preview_metadata_wins_and_result_is_sorted() {
        let preview = parse_plan(&json!({"plan_id": "p1", "name": "Billing", "priority": 5,
            "entitlements": [{"meter": "model_usage", "unit_type": "token",
                "show_name": "Tokens", "grant_units": 100}]})).unwrap();
        let mut marketing = preview.clone();
        marketing.name = "Campaign".to_string();
        marketing.grant_items.clear();
        let mut other = marketing.clone();
        other.plan_id = "p2".to_string();
        other.priority = 0;
        let plans = merge_plans(vec![preview.clone()], vec![other, marketing]);
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0], preview);
    }

    #[test]
    fn schema_failures_are_not_treated_as_no_campaigns() {
        for body in [
            json!({"code": 0, "data": {}}),
            json!({"code": 0, "data": {"deliveries": {}}}),
            json!({"code": 0, "data": {"deliveries": [{"resource_position": "popup"}]}}),
            json!({"code": 0, "data": {"deliveries": [{"resource_position": "banner",
                "banner": {"buttons": [{"action": {"type": "claim_zcode_plan", "args": {}}}]}}]}}),
        ] {
            assert!(parse_marketing_plans(&body).is_err());
        }
        assert!(parse_marketing_plans(&json!({"code": 0, "data": {"deliveries": []}})).unwrap().is_empty());
    }

    #[test]
    fn banner_plan_metadata_must_match_claim_action() {
        let mut body = json!({"code": 0, "data": {"deliveries": [{
            "resource_position": "banner", "banner": {
                "title": "Fallback",
                "background": {"args": {"zcode_plan": {"plan_id": "p1", "name": "Actual plan",
                    "entitlements": [{"meter": "model_usage", "unit_type": "token",
                        "show_name": "Tokens", "grant_units": 500}]}}},
                "buttons": [{"action": {"type": "claim_zcode_plan", "args": {"plan_id": "p1"}}}],
                "success_popup": {"buttons": [{"action": {"type": "claim_zcode_plan", "args": {"plan_id": "success-only"}}}]}
            }
        }]}});
        let plans = parse_marketing_plans(&body).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].name, "Actual plan");
        assert_eq!(plans[0].grant_items[0].units, 500.0);
        body["data"]["deliveries"][0]["banner"]["background"]["args"]["zcode_plan"]["plan_id"] = json!("other");
        let plans = parse_marketing_plans(&body).unwrap();
        assert_eq!(plans[0].plan_id, "p1");
        assert_eq!(plans[0].name, "Fallback");
        assert!(plans[0].grant_items.is_empty());
    }
}
