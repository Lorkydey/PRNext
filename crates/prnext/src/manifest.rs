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
fn enabled() -> bool {
    true
}
impl Default for NativeConfig {
    fn default() -> Self {
        Self {
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
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<()> {
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
            || actions.body_size_limit > crate::pool::MAX_BODY_BYTES
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
        for route in &self.routes {
            if route.id.is_empty() || !ids.insert(&route.id) {
                bail!("empty or duplicate route id: {}", route.id);
            }
            let pattern = RoutePattern::parse(&route.pattern)?;
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
}
