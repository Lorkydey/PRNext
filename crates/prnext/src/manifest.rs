use crate::routing::RoutePattern;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Component, Path},
};

#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    pub version: u32,
    #[serde(default, rename = "buildId")]
    pub build_id: Option<String>,
    #[serde(default, rename = "cacheId")]
    pub cache_id: Option<String>,
    #[serde(default, rename = "previewModeId")]
    pub preview_mode_id: Option<String>,
    #[serde(default)]
    pub config: NativeConfig,
    #[serde(default, rename = "customRoutes")]
    pub custom_routes: Option<crate::custom_routes::CustomRoutes>,
    #[serde(default)]
    pub middleware: Option<crate::middleware::MiddlewareManifest>,
    #[serde(default, rename = "pagesErrors")]
    pub pages_errors: PagesErrors,
    #[serde(default, rename = "appNotFound")]
    pub app_not_found: Option<String>,
    #[serde(default)]
    pub dev: bool,
    pub routes: Vec<Route>,
    #[serde(default)]
    pub prerendered: Vec<Prerendered>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeConfig {
    #[serde(default)]
    pub deployment_id: Option<String>,
    #[serde(default, deserialize_with = "retained_assets")]
    pub retained_assets: BTreeMap<String, u64>,
    #[serde(default)]
    pub worker_preload: Option<WorkerPreload>,
    #[serde(default)]
    pub worker_memory: Option<crate::pool::MemoryPolicy>,
    #[serde(default)]
    pub static_only: bool,
    #[serde(default)]
    pub static_fallback: bool,
    #[serde(default)]
    pub worker_retirement: crate::retirement::Overrides,
    #[serde(default)]
    pub i18n: Option<crate::i18n::I18n>,
    #[serde(default)]
    pub cache_handler: Option<String>,
    #[serde(default)]
    pub cache_max_memory_size: Option<u64>,
    #[serde(default)]
    pub server_actions: ServerActionsConfig,
    #[serde(default)]
    pub trailing_slash: bool,
    #[serde(default)]
    pub skip_trailing_slash_redirect: bool,
    #[serde(default, alias = "skipProxyUrlNormalize")]
    pub skip_middleware_url_normalize: bool,
    #[serde(default)]
    pub images: crate::images::ImageConfig,
    #[serde(default = "enabled")]
    pub compress: bool,
    #[serde(default = "enabled")]
    pub powered_by_header: bool,
    #[serde(default)]
    pub base_path: String,
    #[serde(default)]
    pub asset_prefix: String,
    #[serde(default)]
    pub asset_base: String,
}
fn retained_assets<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<BTreeMap<String, u64>, D::Error> {
    let source = BTreeMap::<String, u64>::deserialize(deserializer)?;
    if source.len() > 1024 {
        return Err(serde::de::Error::custom(
            "too many retained deployment assets",
        ));
    }
    let mut result = BTreeMap::new();
    for (name, expires) in source {
        if name.len() > 240
            || name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
        {
            return Err(serde::de::Error::custom(
                "invalid retained deployment asset name",
            ));
        }
        let key = if cfg!(windows) {
            name.to_ascii_lowercase()
        } else {
            name
        };
        result
            .entry(key)
            .and_modify(|value: &mut u64| *value = (*value).min(expires))
            .or_insert(expires);
    }
    Ok(result)
}
fn enabled() -> bool {
    true
}
impl Default for NativeConfig {
    fn default() -> Self {
        Self {
            deployment_id: None,
            retained_assets: BTreeMap::new(),
            worker_preload: None,
            worker_memory: None,
            static_only: false,
            static_fallback: false,
            worker_retirement: crate::retirement::Overrides::default(),
            i18n: None,
            cache_handler: None,
            cache_max_memory_size: None,
            server_actions: ServerActionsConfig::default(),
            trailing_slash: false,
            skip_trailing_slash_redirect: false,
            skip_middleware_url_normalize: false,
            images: crate::images::ImageConfig::default(),
            compress: true,
            powered_by_header: true,
            base_path: String::new(),
            asset_prefix: String::new(),
            asset_base: String::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerPreload {
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerActionsConfig {
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    #[serde(default = "action_body_limit")]
    pub body_size_limit: usize,
}
fn action_body_limit() -> usize {
    1024 * 1024
}
impl Default for ServerActionsConfig {
    fn default() -> Self {
        Self {
            allowed_origins: Vec::new(),
            body_size_limit: action_body_limit(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RouteKind {
    Page,
    Api,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PagesErrors {
    pub not_found: Option<String>,
    pub server_error: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Route {
    pub id: String,
    pub pattern: String,
    pub kind: RouteKind,
    pub module: String,
    #[serde(default)]
    pub router: Option<String>,
    #[serde(default, rename = "htmlOnly")]
    pub html_only: bool,
    #[serde(default)]
    pub fallback: Option<serde_json::Value>,
    #[serde(default)]
    pub ssg: bool,
    #[serde(default, rename = "fallbackFile")]
    pub fallback_file: Option<String>,
    #[serde(default, rename = "allowedPaths", deserialize_with = "path_set")]
    pub allowed_paths: Option<HashSet<String>>,
    #[serde(default, rename = "dynamicPaths", deserialize_with = "path_set")]
    pub dynamic_paths: Option<HashSet<String>>,
    #[serde(default, rename = "cacheConfig")]
    pub cache_config: Option<serde_json::Value>,
    #[serde(default)]
    pub internal: bool,
    #[serde(default, rename = "errorStatus")]
    pub error_status: Option<u16>,
}

fn path_set<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<HashSet<String>>, D::Error> {
    Option::<Vec<String>>::deserialize(deserializer)?
        .map(|paths| {
            paths
                .into_iter()
                .map(|path| {
                    crate::routing::decode_path(&path)
                        .map(|parts| format!("/{}", parts.join("/")))
                        .map_err(serde::de::Error::custom)
                })
                .collect()
        })
        .transpose()
}
impl Route {
    pub(crate) fn compiled_pattern(&self) -> Result<RoutePattern> {
        if self.html_only {
            let parts = crate::routing::decode_path(&self.pattern)?;
            RoutePattern::parse(&format!("/{}", parts.join("/")))
        } else {
            RoutePattern::parse(&self.pattern)
        }
    }
    pub fn max_duration(&self) -> Option<std::time::Duration> {
        self.cache_config
            .as_ref()?
            .get("maxDuration")?
            .as_u64()
            .map(std::time::Duration::from_secs)
    }
    pub fn allows(&self, path: &str) -> bool {
        self.allowed_paths
            .as_ref()
            .is_none_or(|paths| paths.contains(path))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Revalidate {
    #[default]
    Never,
    Seconds(u64),
}

impl Serialize for Revalidate {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Never => serializer.serialize_bool(false),
            Self::Seconds(seconds) => serializer.serialize_u64(*seconds),
        }
    }
}

impl<'de> Deserialize<'de> for Revalidate {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        match serde_json::Value::deserialize(deserializer)? {
            serde_json::Value::Bool(false) => Ok(Self::Never),
            serde_json::Value::Number(value) => value
                .as_u64()
                .filter(|value| *value <= i64::MAX as u64 / 1000)
                .map(Self::Seconds)
                .ok_or_else(|| serde::de::Error::custom("invalid revalidate seconds")),
            _ => Err(serde::de::Error::custom(
                "revalidate must be false or a nonnegative integer",
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct Prerendered {
    pub path: String,
    pub file: String,
    #[serde(default = "ok_status")]
    pub status: u16,
    #[serde(default)]
    pub headers: BTreeMap<String, crate::pool::HeaderValues>,
    #[serde(default, rename = "dataFile")]
    pub data_file: Option<String>,
    #[serde(default)]
    pub revalidate: Revalidate,
    #[serde(default, rename = "generatedAt")]
    pub generated_at: u64,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub paths: Vec<String>,
}

fn ok_status() -> u16 {
    200
}

impl Manifest {
    pub async fn load(dist: &Path) -> Result<Self> {
        let file = dist.join("manifest.json");
        let bytes = tokio::fs::read(&file)
            .await
            .with_context(|| format!("cannot read {}; run `prnext build` first", file.display()))?;
        let manifest: Self =
            serde_json::from_slice(&bytes).context("invalid PRNext build manifest")?;
        manifest.validate()?;
        crate::build_output::validate(dist, &manifest).await?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<()> {
        if let Some(policy) = self.config.worker_memory {
            policy.validate()?;
        }
        if self.config.static_only
            && (self.dev
                || !self.routes.is_empty()
                || self.middleware.is_some()
                || self.custom_routes.is_some()
                || self.config.cache_handler.is_some())
        {
            bail!("Static adapters cannot declare a development server, render routes, middleware or cache handlers");
        }
        if self.config.static_fallback && !self.config.static_only {
            bail!("staticFallback requires the static adapter");
        }
        if let Some(i18n) = &self.config.i18n {
            i18n.validate()?;
        }
        if self
            .config
            .cache_max_memory_size
            .is_some_and(|bytes| bytes > 1024 * 1024 * 1024)
        {
            bail!("cacheMaxMemorySize exceeds 1 GiB");
        }
        if self.config.cache_handler.as_ref().is_some_and(|file| {
            !file.starts_with("server/")
                || file.len() > 4096
                || file.contains(['\\', '\0'])
                || Path::new(file)
                    .components()
                    .any(|part| !matches!(part, Component::Normal(_)))
        }) {
            bail!("invalid cacheHandler module path");
        }
        let actions = &self.config.server_actions;
        if actions.body_size_limit == 0
            || actions.body_size_limit > 8 * 1024 * 1024
            || actions.allowed_origins.len() > 128
            || actions.allowed_origins.iter().any(|origin| {
                origin.is_empty()
                    || origin.len() > 256
                    || !origin.is_ascii()
                    || origin
                        .bytes()
                        .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
                    || origin.contains(['/', '\\', '@', '?', '#'])
            })
        {
            bail!("invalid serverActions configuration in manifest");
        }
        if self.version != 1 {
            bail!("unsupported manifest version {}", self.version);
        }
        if self
            .preview_mode_id
            .as_ref()
            .is_some_and(|id| id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            bail!("previewModeId must be a random 32-character hexadecimal build identifier");
        }
        let base = &self.config.base_path;
        if base.len() > 4096
            || !base.is_ascii()
            || base.bytes().any(|value| value.is_ascii_control())
            || (!base.is_empty()
                && (!base.starts_with('/')
                    || base.ends_with('/')
                    || base.contains(['?', '#', '\\'])
                    || base.chars().any(char::is_whitespace)
                    || base
                        .split('/')
                        .skip(1)
                        .any(|part| part.is_empty() || part == "." || part == "..")))
        {
            bail!("invalid basePath in manifest");
        }
        if let Some(middleware) = &self.middleware {
            middleware.validate()?;
        }
        if [&self.build_id, &self.cache_id].into_iter().any(|id| {
            id.as_ref().is_some_and(|id| {
                id.is_empty()
                    || id.len() > 128
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
        }) {
            bail!("invalid build/cache identifier");
        }
        let mut ids = HashSet::new();
        let mut shapes = HashSet::new();
        // Index the closed document set once, rather than scanning every
        // artifact for every generateStaticParams entry.
        let html_documents = if self.routes.iter().any(|route| route.html_only) {
            self.prerendered
                .iter()
                .map(|page| {
                    Ok((
                        format!("/{}", crate::routing::decode_path(&page.path)?.join("/")),
                        page,
                    ))
                })
                .collect::<Result<std::collections::HashMap<_, _>>>()?
        } else {
            std::collections::HashMap::new()
        };
        for route in &self.routes {
            if let Some(value) = route
                .cache_config
                .as_ref()
                .and_then(|config| config.get("maxDuration"))
            {
                if value
                    .as_u64()
                    .is_none_or(|seconds| !(1..=300).contains(&seconds))
                {
                    bail!("invalid route maxDuration");
                }
            }
            if route.id.is_empty() || !ids.insert(&route.id) {
                bail!("empty or duplicate route id: {}", route.id);
            }
            let pattern = route.compiled_pattern()?;
            if route.html_only {
                if self.dev
                    || route.kind != RouteKind::Page
                    || route.router.as_deref() != Some("app")
                    || !route.ssg
                    || route.internal
                    || route.fallback_file.is_some()
                    || route
                        .dynamic_paths
                        .as_ref()
                        .is_some_and(|paths| !paths.is_empty())
                    || route
                        .cache_config
                        .as_ref()
                        .and_then(|config| config.get("runtime"))
                        .is_some_and(|runtime| runtime.as_str() != Some("nodejs"))
                    || pattern.static_path().is_none()
                        && (route.allowed_paths.is_none()
                            || route.fallback.as_ref() != Some(&serde_json::Value::Bool(false)))
                {
                    bail!(
                        "HTML-only routes require strictly prerendered public App pages: {}",
                        route.pattern
                    );
                }
                let expected: Vec<String> = match pattern.static_path() {
                    Some(path) => vec![path],
                    None => route
                        .allowed_paths
                        .as_ref()
                        .unwrap()
                        .iter()
                        .cloned()
                        .collect(),
                };
                for path in expected {
                    // static_path and allowedPaths are already decoded. A
                    // second decode would turn literal %2F/%25 into another URL.
                    let parts = path
                        .trim_matches('/')
                        .split('/')
                        .filter(|part| !part.is_empty())
                        .map(str::to_owned)
                        .collect::<Vec<_>>();
                    if pattern.matches(&parts).is_none() {
                        bail!("HTML-only allowed path does not match its route: {path}");
                    }
                    let page = html_documents.get(&path).with_context(|| {
                        format!("HTML-only route lacks prerendered document: {path}")
                    })?;
                    if page.data_file.is_some() || page.revalidate != Revalidate::Never {
                        bail!("HTML-only documents cannot expose Flight or ISR: {path}");
                    }
                }
            }
            if !shapes.insert(pattern.shape) {
                bail!("conflicting route pattern: {}", route.pattern);
            }
            validate_relative_file(&route.module)?;
            if route
                .error_status
                .is_some_and(|status| !matches!(status, 404 | 500))
                || route.error_status.is_some()
                    && (route.kind != RouteKind::Page || route.router.as_deref() == Some("app"))
            {
                bail!("invalid Pages error route: {}", route.id);
            }
            if let Some(file) = &route.fallback_file {
                validate_relative_file(file)?;
            }
            if route.ssg
                && (!(route.kind == RouteKind::Page
                    || route.kind == RouteKind::Api && route.router.as_deref() == Some("app"))
                    || self.build_id.is_none())
            {
                bail!("SSG routes require a build identifier and a page or App API route");
            }
        }
        for (id, app, status) in [
            (&self.pages_errors.not_found, false, Some(404)),
            (&self.pages_errors.server_error, false, Some(500)),
            (&self.pages_errors.error, false, None),
            (&self.app_not_found, true, None),
        ] {
            if let Some(id) = id {
                let route = self
                    .routes
                    .iter()
                    .find(|route| &route.id == id)
                    .context("unknown error route identifier")?;
                if route.kind != RouteKind::Page
                    || (route.router.as_deref() == Some("app")) != app
                    || route.error_status != status
                    || status.is_none() && !route.internal
                {
                    bail!("invalid error route descriptor: {id}");
                }
            }
        }
        let mut paths = HashSet::new();
        for page in &self.prerendered {
            let decoded = crate::routing::decode_path(&page.path)?;
            if !paths.insert(format!("/{}", decoded.join("/"))) {
                bail!("duplicate prerendered path: {}", page.path);
            }
            validate_relative_file(&page.file)?;
            if let Some(file) = &page.data_file {
                validate_relative_file(file)?;
            }
            if !(200..=599).contains(&page.status) {
                bail!("invalid prerendered response status: {}", page.status);
            }
        }
        Ok(())
    }
}

pub fn validate_relative_file(file: &str) -> Result<()> {
    if file.is_empty()
        || file.contains('\\')
        || Path::new(file)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        bail!("build file must be a relative path without traversal: {file}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_accepts_new_fields_but_rejects_ambiguous_routes() {
        let source = r#"{"version":1,"extra":true,"routes":[{"id":"a","pattern":"/[id]","kind":"page","module":"server/a.cjs","client":"/a.js"},{"id":"b","pattern":"/[name]","kind":"page","module":"server/b.cjs"}]}"#;
        let mut manifest: Manifest = serde_json::from_str(source).unwrap();
        assert!(manifest.validate().is_err());
        manifest.routes.pop();
        assert!(manifest.validate().is_ok());
    }

    #[test]
    fn manifest_files_cannot_escape_build_directory() {
        for file in [
            "../secret",
            "/tmp/secret",
            "server/../../secret",
            "server\\secret",
            "",
        ] {
            assert!(validate_relative_file(file).is_err());
        }
        assert!(validate_relative_file("server/home.cjs").is_ok());
    }

    #[test]
    fn html_only_manifest_requires_closed_static_documents_without_flight_or_isr() {
        let source = serde_json::json!({"version":1,"buildId":"html-test","routes":[{
            "id":"html","pattern":"/html/[slug]","kind":"page","router":"app","module":"server/html.cjs",
            "htmlOnly":true,"ssg":true,"fallback":false,"allowedPaths":["/html/one"]
        }],"prerendered":[{"path":"/html/one","file":"prerendered/one.html","revalidate":false}]});
        let check = |value: serde_json::Value| {
            serde_json::from_value::<Manifest>(value)
                .unwrap()
                .validate()
        };
        check(source.clone()).unwrap();
        for (key, value) in [
            ("ssg", serde_json::json!(false)),
            ("router", serde_json::json!("pages")),
            ("kind", serde_json::json!("api")),
            ("fallback", serde_json::json!("blocking")),
            ("allowedPaths", serde_json::json!(null)),
            ("internal", serde_json::json!(true)),
            (
                "fallbackFile",
                serde_json::json!("prerendered/fallback.html"),
            ),
        ] {
            let mut changed = source.clone();
            changed["routes"][0][key] = value;
            assert!(check(changed).is_err(), "{key}");
        }
        for (key, value) in [
            ("dataFile", serde_json::json!("prerendered/one.rsc")),
            ("revalidate", serde_json::json!(60)),
        ] {
            let mut changed = source.clone();
            changed["prerendered"][0][key] = value;
            assert!(check(changed).is_err(), "{key}");
        }
        let mut changed = source.clone();
        changed["dev"] = true.into();
        assert!(check(changed).is_err());
        let mut changed = source.clone();
        changed["prerendered"] = serde_json::json!([]);
        assert!(check(changed).is_err());
        // The native must retain compatibility with ordinary/older manifests.
        let mut changed = source.clone();
        changed["routes"][0]
            .as_object_mut()
            .unwrap()
            .remove("htmlOnly");
        changed["prerendered"][0]["dataFile"] = serde_json::json!("prerendered/one.rsc");
        check(changed).unwrap();
    }

    #[test]
    fn html_only_closure_decodes_each_path_exactly_once() {
        for (pattern, allowed, artifact) in [
            ("/guide/café", None, "/guide/caf%C3%A9"),
            ("/guide/caf%C3%A9", None, "/guide/café"),
            ("/guide/[slug]", Some("/guide/caf%C3%A9"), "/guide/café"),
            ("/guide/[slug]", Some("/guide/%252F"), "/guide/%252F"),
            ("/guide/[slug]", Some("/guide/%2525"), "/guide/%2525"),
        ] {
            let route = serde_json::json!({"id":"html","pattern":pattern,"kind":"page","router":"app","module":"server/html.cjs","htmlOnly":true,"ssg":true,"fallback":false,"allowedPaths":allowed.map(|path|vec![path])});
            let manifest:Manifest=serde_json::from_value(serde_json::json!({"version":1,"buildId":"html-path","routes":[route],"prerendered":[{"path":artifact,"file":"html.html"}]})).unwrap();
            manifest
                .validate()
                .unwrap_or_else(|error| panic!("{pattern} {artifact}: {error}"));
            let compiled = manifest.routes[0].compiled_pattern().unwrap();
            assert!(compiled
                .matches(&crate::routing::decode_path(artifact).unwrap())
                .is_some());
        }
    }
}
