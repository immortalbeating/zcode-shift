use std::time::Duration;
use crate::store::{Paths, Settings};

pub(crate) fn validate_url(url: Option<&str>) -> Result<String, String> {
    let url = url.map(str::trim).filter(|s| !s.is_empty())
        .ok_or_else(|| "service_proxy_need_url".to_string())?;
    if !url.to_ascii_lowercase().starts_with("http://") {
        return Err("service_proxy_http_required".into());
    }
    let normalized = crate::oauth::parse_proxy_url(url)
        .map_err(|_| "service_proxy_invalid_url".to_string())?;
    ureq::Proxy::new(&normalized).map_err(|_| "service_proxy_invalid_url".to_string())?;
    Ok(normalized)
}

pub(crate) fn proxy_url(paths: &Paths) -> Result<Option<String>, String> {
    let contents = match std::fs::read_to_string(paths.settings_file()) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("service_proxy_settings_failed".into()),
    };
    let settings: Settings = serde_json::from_str(&contents)
        .map_err(|_| "service_proxy_settings_failed".to_string())?;
    if settings.service_proxy_on.unwrap_or(false) {
        Ok(Some(validate_url(settings.service_proxy())?))
    } else {
        Ok(None)
    }
}

fn agent_with_url(url: Option<&str>, timeout: Duration) -> Result<ureq::Agent, String> {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10)).timeout(timeout);
    if let Some(url) = url {
        builder = builder.proxy(ureq::Proxy::new(url).map_err(|_| "service_proxy_invalid_url".to_string())?);
    }
    Ok(builder.build())
}

#[cfg(test)]
fn agent_for(settings: &Settings, timeout: Duration) -> Result<ureq::Agent, String> {
    let url = if settings.service_proxy_on.unwrap_or(false) {
        Some(validate_url(settings.service_proxy())?)
    } else { None };
    agent_with_url(url.as_deref(), timeout)
}

pub(crate) fn agent(timeout: Duration) -> Result<ureq::Agent, String> {
    let url = proxy_url(&Paths::detect())?;
    agent_with_url(url.as_deref(), timeout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn settings_read_fails_closed_and_normalizes_enabled_route() {
        let home = std::env::temp_dir().join(format!("zcode-service-proxy-{}", uuid::Uuid::new_v4()));
        let paths = Paths { home: home.clone() };
        assert_eq!(proxy_url(&paths).unwrap(), None);
        std::fs::create_dir_all(paths.store_dir()).unwrap();
        std::fs::write(paths.settings_file(), "{").unwrap();
        assert_eq!(proxy_url(&paths).unwrap_err(), "service_proxy_settings_failed");
        std::fs::write(paths.settings_file(), r#"{"service_proxy_on":true,"auth_proxy_url":" "}"#).unwrap();
        assert_eq!(proxy_url(&paths).unwrap_err(), "service_proxy_need_url");
        std::fs::write(paths.settings_file(), r#"{"service_proxy_on":true,"auth_proxy_url":" HTTP://LOCALHOST:7897 "}"#).unwrap();
        assert_eq!(proxy_url(&paths).unwrap().as_deref(), Some("http://localhost:7897"));
        std::fs::write(paths.settings_file(), r#"{"service_proxy_on":false,"auth_proxy_url":"socks5://localhost:7897"}"#).unwrap();
        assert_eq!(proxy_url(&paths).unwrap(), None);
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn default_off_and_independent_of_auth_switch() {
        let mut s = Settings::default();
        s.auth_proxy_url = Some("http://127.0.0.1:1234".into());
        s.auth_proxy_on = Some(true);
        assert_eq!(s.service_proxy(), None);
        s.auth_proxy_on = Some(false);
        s.service_proxy_on = Some(true);
        assert_eq!(s.service_proxy(), Some("http://127.0.0.1:1234"));
        assert_eq!(s.auth_proxy(), None);
    }

    #[test]
    fn validates_proxy_url() {
        assert_eq!(validate_url(None).unwrap_err(), "service_proxy_need_url");
        assert_eq!(validate_url(Some("socks5://localhost:7897")).unwrap_err(), "service_proxy_http_required");
        assert_eq!(validate_url(Some("http://localhost:0")).unwrap_err(), "service_proxy_invalid_url");
        assert_eq!(validate_url(Some(" HTTP://LOCALHOST:7897 ")).unwrap(), "http://localhost:7897");
    }

    #[test]
    fn disabled_agent_ignores_saved_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut bytes = [0; 4096];
            let count = socket.read(&mut bytes).unwrap();
            let request = String::from_utf8_lossy(&bytes[..count]).into_owned();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").unwrap();
            request
        });
        let settings = Settings { auth_proxy_on: Some(true), auth_proxy_url: Some("socks5://localhost:1".into()), ..Settings::default() };
        let response = agent_for(&settings, Duration::from_secs(3)).unwrap().get(&format!("http://{address}/direct-test")).call().unwrap();
        assert_eq!(response.into_string().unwrap(), "ok");
        assert!(server.join().unwrap().starts_with("GET /direct-test HTTP/1.1"));
    }

    #[test]
    fn enabled_agent_sends_request_to_loopback_proxy() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
            let mut bytes = [0; 4096];
            let count = socket.read(&mut bytes).unwrap();
            let request = String::from_utf8_lossy(&bytes[..count]).into_owned();
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").unwrap();
            request
        });
        let settings = Settings { service_proxy_on: Some(true), auth_proxy_url: Some(format!("http://{address}")), ..Settings::default() };
        let response = agent_for(&settings, Duration::from_secs(3)).unwrap().get("http://example.invalid/proxy-test").call().unwrap();
        assert_eq!(response.into_string().unwrap(), "ok");
        assert!(server.join().unwrap().starts_with("GET http://example.invalid/proxy-test HTTP/1.1"));
    }
}
