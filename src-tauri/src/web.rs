use crate::{files::http_url, model::Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;
use url::{Host, Url};

const MAX_HTML: usize = 10 * 1024 * 1024;

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_broadcast()
                || ip.is_documentation()
                || a == 0
                || a >= 240
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && (18..=19).contains(&b)))
        }
        IpAddr::V6(ip) => {
            let segments = ip.segments();
            // Transition ranges can embed a private IPv4 destination, so fail closed.
            segments[0] & 0xe000 == 0x2000
                && !(segments[0] == 0x2001 && segments[1] < 0x0200)
                && !(segments[0] == 0x2001 && segments[1] == 0x0db8)
                && segments[0] != 0x2002
                && !(segments[0] == 0x3fff && segments[1] < 0x1000)
        }
    }
}

fn check_addresses(addresses: Vec<SocketAddr>) -> Result<Vec<SocketAddr>> {
    if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
        return Err(
            "公開Webページのみ取り込めます。ローカル・プライベート宛てには接続しません".into(),
        );
    }
    Ok(addresses)
}

async fn public_addresses(url: &Url) -> Result<Vec<SocketAddr>> {
    let port = url.port_or_known_default().ok_or("URLのポートが不正です")?;
    let addresses = match url.host().ok_or("URLにホスト名がありません")? {
        Host::Ipv4(ip) => vec![SocketAddr::new(ip.into(), port)],
        Host::Ipv6(ip) => vec![SocketAddr::new(ip.into(), port)],
        Host::Domain(host) => tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| "Webページのホスト名を解決できません")?
            .collect(),
    };
    check_addresses(addresses)
}

async fn fetch(input: &str) -> Result<Value> {
    let mut url = http_url(input)?;
    for redirects in 0..=5 {
        let addresses = public_addresses(&url).await?;
        // A second DNS lookup or a proxy could bypass the address check.
        // Redirects need the same check before sending the next request.
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(
                url.host_str().ok_or("URLにホスト名がありません")?,
                &addresses,
            )
            .build()
            .map_err(|e| e.to_string())?;
        let response = client
            .get(url.clone())
            .header("User-Agent", concat!("Gradia/", env!("CARGO_PKG_VERSION")))
            .send()
            .await
            .map_err(|_| "ページに接続できません")?;
        if response.status().is_redirection() {
            if redirects == 5 {
                return Err("ページの転送回数が多すぎます".into());
            }
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or("ページの転送先が不正です")?;
            url = http_url(
                url.join(location)
                    .map_err(|_| "ページの転送先が不正です")?
                    .as_str(),
            )?;
            continue;
        }
        let response = response.error_for_status().map_err(|e| {
            format!(
                "ページを取得できません（HTTP {}）",
                e.status().map_or(0, |s| s.as_u16())
            )
        })?;
        let mime = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !mime.contains("text/html") && !mime.contains("application/xhtml") {
            return Err("HTMLページのURLを指定してください".into());
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "ページの受信が中断されました")?;
            if chunk.len() > MAX_HTML - bytes.len() {
                return Err("ページが10 MBを超えています".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let html =
            String::from_utf8(bytes).map_err(|_| "初版はUTF-8のWebページに対応しています")?;
        return Ok(json!({"html": html, "url": url.as_str()}));
    }
    unreachable!()
}

pub async fn fetch_public_page(url: &str) -> Result<Value> {
    tokio::time::timeout(Duration::from_secs(60), fetch(url))
        .await
        .map_err(|_| "ページの取得がタイムアウトしました".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_private_special_and_transition_addresses() {
        for ip in [
            "0.0.0.0",
            "10.0.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.1.1",
            "100.64.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "64:ff9b::7f00:1",
            "2001::1",
            "2001:db8::1",
            "2002:7f00:1::1",
            "3fff::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "accepted {ip}");
        }
        for ip in [
            "1.1.1.1",
            "8.8.8.8",
            "192.30.255.112",
            "2606:4700:4700::1111",
        ] {
            assert!(public_ip(ip.parse().unwrap()), "rejected {ip}");
        }
    }

    #[test]
    fn rejects_a_host_with_any_private_dns_answer() {
        assert!(check_addresses(vec![]).is_err());
        assert!(check_addresses(vec![
            "1.1.1.1:443".parse().unwrap(),
            "127.0.0.1:443".parse().unwrap()
        ])
        .is_err());
    }

    #[tokio::test]
    async fn refuses_loopback_before_opening_a_connection() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/private", listener.local_addr().unwrap());
        assert!(fetch_public_page(&url).await.is_err());
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        assert!(fetch_public_page("http://localhost/private").await.is_err());
    }

    #[tokio::test]
    async fn rejects_redirects_to_private_and_non_http_targets() {
        let source = Url::parse("https://example.org/article").unwrap();
        for target in [
            "http://127.1/private",
            "http://[::ffff:127.0.0.1]/",
            "file:///C:/Windows/win.ini",
            "https://user:pass@example.org/",
        ] {
            let redirect = source.join(target).unwrap();
            if let Ok(url) = http_url(redirect.as_str()) {
                assert!(public_addresses(&url).await.is_err());
            }
        }
    }
}
