//! Public URLs use a fixed configured origin, or explicitly trusted transport peers.
//! Never use a client supplied forwarding header as proof of proxy identity.
use anyhow::{bail, ensure, Result};
use axum::{
    extract::{ConnectInfo, Request},
    http::{header, uri::Authority, HeaderMap, HeaderValue},
};
use serde::Deserialize;
use std::net::{IpAddr, SocketAddr};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub public_origin: Option<String>,
    #[serde(default)]
    pub trusted_proxies: Vec<String>,
}

#[derive(Clone)]
struct Network {
    address: IpAddr,
    bits: u32,
}
impl Network {
    fn parse(value: &str) -> Result<Self> {
        let (address, bits) = value
            .split_once('/')
            .map_or((value, None), |(a, b)| (a, Some(b)));
        let address: IpAddr = address.parse()?;
        let maximum = if address.is_ipv4() { 32 } else { 128 };
        let bits = match bits {
            Some(bits) => {
                ensure!(
                    !bits.is_empty()
                        && bits.bytes().all(|b| b.is_ascii_digit())
                        && (bits == "0" || !bits.starts_with('0')),
                    "invalid proxy CIDR prefix"
                );
                bits.parse::<u32>()?
            }
            None => maximum,
        };
        ensure!(bits <= maximum, "invalid proxy CIDR prefix");
        if let IpAddr::V6(address) = address {
            if let Some(mapped) = address.to_ipv4_mapped() {
                ensure!(
                    bits >= 96,
                    "mapped IPv4 proxy ranges require a prefix of at least 96 bits"
                );
                return Ok(Self {
                    address: IpAddr::V4(mapped),
                    bits: bits - 96,
                });
            }
        }
        Ok(Self { address, bits })
    }
    fn contains(&self, peer: IpAddr) -> bool {
        match (self.address, peer.to_canonical()) {
            (IpAddr::V4(a), IpAddr::V4(b)) => {
                self.bits == 0
                    || u32::from(a) >> (32 - self.bits) == u32::from(b) >> (32 - self.bits)
            }
            (IpAddr::V6(a), IpAddr::V6(b)) => {
                self.bits == 0
                    || u128::from(a) >> (128 - self.bits) == u128::from(b) >> (128 - self.bits)
            }
            _ => false,
        }
    }
}

pub(crate) struct Policy {
    fixed: Option<String>,
    trusted: Vec<Network>,
}
#[derive(Clone)]
struct PublicOrigin(String);

fn authority(value: &str) -> Result<Authority> {
    let parsed: Authority = value.parse()?;
    ensure!(
        !value.is_empty()
            && !value.contains(['@', ',', '\\', '#', '?', '%'])
            && !value.ends_with(':')
            && !value.bytes().any(|b| b.is_ascii_whitespace())
            && !parsed.host().is_empty(),
        "invalid public host"
    );
    ensure!(
        parsed.port().is_none() || parsed.port_u16().is_some(),
        "invalid public port"
    );
    Ok(parsed)
}
fn single<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>> {
    let mut values = headers.get_all(name).iter();
    let value = values.next().map(|v| v.to_str()).transpose()?;
    ensure!(
        values.next().is_none() && value.is_none_or(|v| !v.contains(',')),
        "ambiguous proxy header"
    );
    Ok(value)
}

impl Policy {
    pub fn new(config: &Config) -> Result<Self> {
        ensure!(
            config.trusted_proxies.len() <= 32,
            "too many trusted proxy ranges"
        );
        let fixed = config
            .public_origin
            .as_ref()
            .map(|source| -> Result<String> {
                let parsed = reqwest::Url::parse(source)?;
                ensure!(
                    matches!(parsed.scheme(), "http" | "https")
                        && parsed.username().is_empty()
                        && parsed.password().is_none()
                        && parsed.path() == "/"
                        && parsed.query().is_none()
                        && parsed.fragment().is_none()
                        && !source.chars().any(|c| c.is_whitespace() || c == '\\'),
                    "server.publicOrigin must be an HTTP(S) origin"
                );
                Ok(parsed.origin().ascii_serialization())
            })
            .transpose()?;
        Ok(Self {
            fixed,
            trusted: config
                .trusted_proxies
                .iter()
                .map(|value| Network::parse(value))
                .collect::<Result<_>>()?,
        })
    }

    fn trusts_peer(&self, request: &Request) -> bool {
        request
            .extensions()
            .get::<super::branch_resolver::Probe>()
            .is_some()
            || request
                .extensions()
                .get::<ConnectInfo<SocketAddr>>()
                .is_some_and(|ConnectInfo(peer)| {
                    self.trusted
                        .iter()
                        .any(|network| network.contains(peer.ip()))
                })
    }

    // An internal loopback connection must not promote the original client's
    // forwarding metadata. Gate it at the public listener using that listener's
    // real transport peer and the selected generation's origin policy.
    pub fn prepare_proxy(&self, request: &mut Request) -> Result<()> {
        if self.fixed.is_none() && self.trusts_peer(request) {
            if let Some(host) = single(request.headers(), "x-forwarded-host")? {
                authority(host)?;
            }
            if let Some(scheme) = single(request.headers(), "x-forwarded-proto")? {
                ensure!(
                    matches!(scheme, "http" | "https"),
                    "invalid forwarded protocol"
                );
            }
        } else {
            request.headers_mut().remove("x-forwarded-host");
            request.headers_mut().remove("x-forwarded-proto");
        }
        // Only the bounded host/protocol pair is supported across these hops.
        for name in [
            "forwarded",
            "x-forwarded-port",
            "x-forwarded-for",
            "x-forwarded-server",
        ] {
            request.headers_mut().remove(name);
        }
        Ok(())
    }

    pub fn apply(&self, request: &mut Request, fallback: &str) -> Result<()> {
        let host = single(request.headers(), "host")?.unwrap_or(fallback);
        authority(host)?;
        let trusted = self.trusts_peer(request);
        let origin = if let Some(origin) = &self.fixed {
            origin.clone()
        } else if trusted {
            let host = single(request.headers(), "x-forwarded-host")?.unwrap_or(host);
            authority(host)?;
            let scheme = single(request.headers(), "x-forwarded-proto")?.unwrap_or("http");
            ensure!(
                matches!(scheme, "http" | "https"),
                "invalid forwarded protocol"
            );
            format!("{scheme}://{host}")
        } else {
            format!("http://{host}")
        };
        let parsed: axum::http::Uri = origin.parse()?;
        let public_host = parsed
            .authority()
            .ok_or_else(|| anyhow::anyhow!("missing public authority"))?
            .as_str();
        // Applications receive only normalized origin headers. RFC Forwarded,
        // client IP chains and forwarding ports are deliberately not trusted.
        for name in [
            "forwarded",
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-forwarded-port",
            "x-forwarded-for",
            "x-forwarded-server",
        ] {
            request.headers_mut().remove(name);
        }
        request
            .headers_mut()
            .insert(header::HOST, HeaderValue::from_str(public_host)?);
        request
            .headers_mut()
            .insert("x-forwarded-host", HeaderValue::from_str(public_host)?);
        request.headers_mut().insert(
            "x-forwarded-proto",
            HeaderValue::from_static(if parsed.scheme_str() == Some("https") {
                "https"
            } else {
                "http"
            }),
        );
        request.extensions_mut().insert(PublicOrigin(origin));
        Ok(())
    }

    pub fn url(&self, request: &Request) -> Result<String> {
        let Some(PublicOrigin(origin)) = request.extensions().get::<PublicOrigin>() else {
            bail!("public origin was not established at ingress")
        };
        Ok(format!(
            "{origin}{}",
            request
                .uri()
                .path_and_query()
                .map_or("/", |path| path.as_str())
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    fn request() -> Request {
        Request::builder()
            .uri("/path?q=1")
            .header("host", "internal:3030")
            .header("x-forwarded-host", "attacker.test")
            .header("x-forwarded-proto", "https")
            .header("forwarded", "host=attacker.test;proto=https")
            .body(Body::empty())
            .unwrap()
    }
    #[test]
    fn untrusted_headers_cannot_spoof_public_urls_or_action_hosts() {
        let policy = Policy::new(&Config::default()).unwrap();
        let mut request = request();
        policy.apply(&mut request, "fallback").unwrap();
        assert_eq!(
            policy.url(&request).unwrap(),
            "http://internal:3030/path?q=1"
        );
        assert_eq!(request.headers()["x-forwarded-host"], "internal:3030");
        assert!(!request.headers().contains_key("forwarded"));
    }
    #[test]
    fn fixed_origin_dominates_hosts_and_trusted_peer_must_be_real() {
        let fixed = Policy::new(&Config {
            public_origin: Some("https://PUBLIC.test:443/".into()),
            trusted_proxies: vec![],
        })
        .unwrap();
        let mut req = request();
        fixed.apply(&mut req, "fallback").unwrap();
        assert_eq!(fixed.url(&req).unwrap(), "https://public.test/path?q=1");
        let policy = Policy::new(&Config {
            public_origin: None,
            trusted_proxies: vec!["127.0.0.0/8".into(), "::1/128".into()],
        })
        .unwrap();
        let mut req = request();
        req.extensions_mut()
            .insert(ConnectInfo("127.0.0.1:4".parse::<SocketAddr>().unwrap()));
        policy.apply(&mut req, "fallback").unwrap();
        assert_eq!(policy.url(&req).unwrap(), "https://attacker.test/path?q=1");
        let mut req = request();
        req.extensions_mut()
            .insert(ConnectInfo("192.0.2.1:4".parse::<SocketAddr>().unwrap()));
        policy.apply(&mut req, "fallback").unwrap();
        assert_eq!(policy.url(&req).unwrap(), "http://internal:3030/path?q=1");
    }
    #[test]
    fn internal_hops_preserve_the_original_peer_trust_decision_for_http_and_websocket() {
        for websocket in [false, true] {
            for (outer, trusted, expected) in [
                (
                    Some("192.0.2.10:4"),
                    vec!["127.0.0.1"],
                    "http://internal:3030/path?q=1",
                ),
                (None, vec!["127.0.0.1"], "http://internal:3030/path?q=1"),
                (
                    Some("192.0.2.10:4"),
                    vec!["127.0.0.1", "192.0.2.0/24"],
                    "https://attacker.test/path?q=1",
                ),
            ] {
                let policy = Policy::new(&Config {
                    public_origin: None,
                    trusted_proxies: trusted.into_iter().map(str::to_owned).collect(),
                })
                .unwrap();
                let mut req = request();
                if websocket {
                    req.headers_mut()
                        .insert(header::UPGRADE, HeaderValue::from_static("websocket"));
                    req.headers_mut()
                        .insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
                }
                if let Some(outer) = outer {
                    req.extensions_mut()
                        .insert(ConnectInfo(outer.parse::<SocketAddr>().unwrap()));
                }
                policy.prepare_proxy(&mut req).unwrap();
                assert!(!req.headers().contains_key("forwarded"));
                assert_eq!(req.headers().contains_key(header::UPGRADE), websocket);
                // The extra internal connection is trusted, but must not grant
                // its trust to metadata discarded at the original listener.
                req.extensions_mut()
                    .insert(ConnectInfo("127.0.0.1:5".parse::<SocketAddr>().unwrap()));
                policy.apply(&mut req, "fallback").unwrap();
                assert_eq!(policy.url(&req).unwrap(), expected);
            }
        }
    }
    #[test]
    fn proxy_ingress_uses_fixed_origin_and_rejects_only_trusted_ambiguous_metadata() {
        for fixed in [None, Some("https://canonical.test".to_owned())] {
            for trusted in [false, true] {
                let policy = Policy::new(&Config {
                    public_origin: fixed.clone(),
                    trusted_proxies: if trusted {
                        vec!["127.0.0.1".into()]
                    } else {
                        vec![]
                    },
                })
                .unwrap();
                for name in ["x-forwarded-host", "x-forwarded-proto"] {
                    let mut req = request();
                    req.extensions_mut()
                        .insert(ConnectInfo("127.0.0.1:4".parse::<SocketAddr>().unwrap()));
                    req.headers_mut()
                        .append(name, HeaderValue::from_static("invalid,duplicate"));
                    if trusted && fixed.is_none() {
                        assert!(policy.prepare_proxy(&mut req).is_err());
                    } else {
                        policy.prepare_proxy(&mut req).unwrap();
                        assert!(!req.headers().contains_key("x-forwarded-host"));
                        assert!(!req.headers().contains_key("x-forwarded-proto"));
                        policy.apply(&mut req, "fallback").unwrap();
                        assert_eq!(
                            policy.url(&req).unwrap(),
                            if fixed.is_some() {
                                "https://canonical.test/path?q=1"
                            } else {
                                "http://internal:3030/path?q=1"
                            }
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn ambiguous_or_invalid_trusted_headers_fail_closed() {
        let policy = Policy::new(&Config {
            public_origin: None,
            trusted_proxies: vec!["::1".into()],
        })
        .unwrap();
        for (name, value) in [
            ("x-forwarded-host", "good.test, bad.test"),
            ("x-forwarded-host", "user@good.test"),
            ("x-forwarded-proto", "javascript"),
            ("x-forwarded-proto", "https,http"),
        ] {
            let mut req = request();
            req.extensions_mut()
                .insert(ConnectInfo("[::1]:4".parse::<SocketAddr>().unwrap()));
            req.headers_mut()
                .insert(name, HeaderValue::from_static(value));
            assert!(policy.apply(&mut req, "fallback").is_err());
        }
        for value in ["::1/129", "127.0.0.1/33", "0.0.0.0/01", "localhost", "*"] {
            assert!(Network::parse(value).is_err());
        }
        assert!(Network::parse("::/0")
            .unwrap()
            .contains("2001:db8::1".parse().unwrap()));
        assert!(Network::parse("127.0.0.1")
            .unwrap()
            .contains("::ffff:127.0.0.1".parse().unwrap()));
        assert!(Network::parse("::ffff:127.0.0.1/128")
            .unwrap()
            .contains("127.0.0.1".parse().unwrap()));
        assert!(Network::parse("::ffff:127.0.0.1/95").is_err());
    }
}
