use axum::http::{HeaderMap, Uri};
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct I18n {
    pub locales: Vec<String>,
    pub default_locale: String,
    #[serde(default = "enabled")]
    pub locale_detection: bool,
    #[serde(default)]
    pub domains: Vec<Domain>,
}
fn enabled() -> bool {
    true
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Domain {
    pub domain: String,
    pub default_locale: String,
    #[serde(default)]
    pub locales: Vec<String>,
    #[serde(default)]
    pub http: bool,
}
pub enum Resolution {
    Redirect(String),
    Rewrite(String),
}
impl I18n {
    pub fn validate(&self) -> anyhow::Result<()> {
        use anyhow::ensure;
        use std::collections::HashSet;
        let valid_locale = |value: &str| {
            !value.is_empty()
                && value.len() <= 64
                && value.as_bytes()[0].is_ascii_alphabetic()
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        };
        ensure!(
            !self.locales.is_empty()
                && self.locales.len() <= 100
                && self.locales.iter().all(|locale| valid_locale(locale))
                && self
                    .locales
                    .iter()
                    .map(|locale| locale.to_ascii_lowercase())
                    .collect::<HashSet<_>>()
                    .len()
                    == self.locales.len()
                && self.locales.contains(&self.default_locale),
            "invalid i18n locales"
        );
        ensure!(self.domains.len() <= 100, "too many i18n domains");
        let mut hosts = HashSet::new();
        let mut defaults = HashSet::new();
        for domain in &self.domains {
            ensure!(
                !domain.domain.is_empty()
                    && domain.domain.len() <= 256
                    && domain
                        .domain
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric()
                            || matches!(byte, b'.' | b'-' | b':'))
                    && domain.domain.parse::<axum::http::uri::Authority>().is_ok()
                    && hosts.insert(domain.domain.to_ascii_lowercase())
                    && self.locales.contains(&domain.default_locale)
                    && defaults.insert(&domain.default_locale)
                    && domain.locales.len() <= 100
                    && domain
                        .locales
                        .iter()
                        .all(|locale| self.locales.contains(locale)),
                "invalid i18n domain"
            );
        }
        Ok(())
    }

    pub fn locale(&self, value: &str) -> Option<&str> {
        self.locales
            .iter()
            .find(|locale| locale.eq_ignore_ascii_case(value))
            .map(String::as_str)
    }
    fn cookie_locale<'a>(&'a self, headers: &HeaderMap) -> Option<&'a str> {
        if let Some(cookie) = headers.get("cookie").and_then(|v| v.to_str().ok()) {
            for entry in cookie.split(';') {
                if let Some(value) = entry.trim().strip_prefix("NEXT_LOCALE=") {
                    if let Some(locale) = self.locale(value) {
                        return Some(locale);
                    }
                }
            }
        }
        None
    }
    fn accepted_locale<'a>(&'a self, headers: &HeaderMap) -> Option<&'a str> {
        let value = headers.get("accept-language")?.to_str().ok()?;
        let mut choices: Vec<_> = value
            .split(',')
            .take(100)
            .filter_map(|entry| {
                let mut parts = entry.trim().split(';');
                let language = parts.next()?.trim();
                let weight = parts
                    .find_map(|part| part.trim().strip_prefix("q="))
                    .map(|value| value.parse::<f32>().unwrap_or(0.0))
                    .unwrap_or(1.0);
                if !(0.0 < weight && weight <= 1.0) {
                    return None;
                }
                let locale = self.locale(language).or_else(|| {
                    self.locales
                        .iter()
                        .find(|locale| {
                            let lower = locale.to_ascii_lowercase();
                            language == "*"
                                || lower
                                    .strip_prefix(&language.to_ascii_lowercase())
                                    .is_some_and(|suffix| suffix.starts_with('-'))
                        })
                        .map(String::as_str)
                })?;
                Some((locale, weight))
            })
            .collect();
        choices.sort_by(|a, b| b.1.total_cmp(&a.1));
        choices.first().map(|(locale, _)| *locale)
    }
    pub fn resolve(
        &self,
        uri: &Uri,
        headers: &HeaderMap,
        base: &str,
        data: bool,
    ) -> Option<Resolution> {
        let path = if base.is_empty() {
            uri.path()
        } else {
            uri.path()
                .strip_prefix(base)
                .filter(|rest| rest.is_empty() || rest.starts_with('/'))?
        };
        let path = if path.is_empty() { "/" } else { path };
        let host = headers
            .get("host")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        let domain = self
            .domains
            .iter()
            .find(|value| value.domain.eq_ignore_ascii_case(host));
        let default = domain
            .map(|value| value.default_locale.as_str())
            .unwrap_or(&self.default_locale);
        let first = path.trim_start_matches('/').split('/').next().unwrap_or("");
        let explicit = self.locale(first);
        let rest = explicit.map(|_| &path[first.len() + 1..]).unwrap_or(path);
        let rest = if rest.is_empty() { "/" } else { rest };
        let suffix = uri
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default();
        if !data && path == "/" && self.locale_detection {
            let accepted = self.accepted_locale(headers);
            let preferred = if domain.is_some() {
                default
            } else {
                self.cookie_locale(headers).or(accepted).unwrap_or(default)
            };
            let target_domain = self.domains.iter().find(|value| {
                Some(value.default_locale.as_str()) == accepted
                    || value
                        .locales
                        .iter()
                        .any(|locale| Some(locale.as_str()) == accepted)
            });
            if let Some(target) = target_domain.filter(|value| {
                domain.is_some()
                    && (!value.domain.eq_ignore_ascii_case(host)
                        || Some(value.default_locale.as_str()) != accepted)
            }) {
                let target_locale = accepted.unwrap_or(default);
                let prefix = if target_locale == target.default_locale {
                    String::new()
                } else {
                    format!("/{target_locale}")
                };
                return Some(Resolution::Redirect(format!(
                    "{}://{}/{}",
                    if target.http { "http" } else { "https" },
                    target.domain,
                    prefix.trim_start_matches('/')
                )));
            }
            if preferred != default {
                return Some(Resolution::Redirect(format!("{base}/{preferred}{suffix}")));
            }
        }
        // Locale routes do not create aliases for framework assets, public files or APIs.
        if explicit.is_none()
            && (path.starts_with("/_")
                || path.starts_with("/api/")
                || path == "/api"
                || path
                    .rsplit('/')
                    .next()
                    .is_some_and(|last| last.contains('.')))
        {
            return None;
        }
        let locale = explicit.unwrap_or(default);
        let localized = if locale == self.default_locale {
            rest.to_owned()
        } else {
            format!("/{locale}{}", if rest == "/" { "" } else { rest })
        };
        let target = format!("{base}{localized}{suffix}");
        (target
            != uri
                .path_and_query()
                .map(|value| value.as_str())
                .unwrap_or("/"))
        .then_some(Resolution::Rewrite(target))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negotiation_and_domains_are_native_and_do_not_rewrite_assets() {
        let config: I18n = serde_json::from_value(serde_json::json!({"locales":["en","fr"],"defaultLocale":"en","domains":[{"domain":"en.test","defaultLocale":"en"},{"domain":"fr.test","defaultLocale":"fr","http":true}]})).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("host", "en.test".parse().unwrap());
        headers.insert("accept-language", "fr;q=0.9,en;q=0.5".parse().unwrap());
        assert!(
            matches!(config.resolve(&"/".parse().unwrap(),&headers,"",false),Some(Resolution::Redirect(value)) if value=="http://fr.test/")
        );
        headers.insert("cookie", "NEXT_LOCALE=en".parse().unwrap());
        headers.insert("host", "unknown.test".parse().unwrap());
        assert!(config
            .resolve(&"/".parse().unwrap(), &headers, "", false)
            .is_none());
        headers.insert("host", "fr.test".parse().unwrap());
        assert!(
            matches!(config.resolve(&"/docs/article?x=1".parse().unwrap(),&headers,"/docs",false),Some(Resolution::Rewrite(value)) if value=="/docs/fr/article?x=1")
        );
        assert!(config
            .resolve(
                &"/docs/_prnext/assets/a.js".parse().unwrap(),
                &headers,
                "/docs",
                false
            )
            .is_none());
    }
}
