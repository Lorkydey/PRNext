//! Persistent Pages ISR. Only metadata lives in memory; HTML and data are streamed
//! into immutable files, then one SQLite row atomically publishes the pair.
use crate::{
    manifest::{Manifest, Prerendered, Revalidate, Route},
    pool::{
        DocumentRequest, DocumentRequestSource, HeaderValues, PageFailure, RenderedBody,
        RenderedResponse, WorkerConfig, WorkerPool, WorkerRequest,
    },
    routing::{decode_path, Params, RoutePattern},
};
use anyhow::{anyhow, bail, Context, Result};
use futures_core::Stream;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::AsyncWriteExt,
    sync::{watch, OwnedSemaphorePermit, Semaphore},
};

const MAX_FILE: usize = 16 * 1024 * 1024;
const MAX_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
const GENERATIONS: usize = 5;
const PATH_SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

#[derive(Clone)]
enum GenerationFailure {
    Dynamic,
    Failed(Option<Arc<PageFailure>>),
}
#[derive(Clone, Debug)]
pub struct PageGenerationError(pub Arc<PageFailure>);
impl std::fmt::Display for PageGenerationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Page generation failed")
    }
}
impl std::error::Error for PageGenerationError {}
type Outcome = std::result::Result<Arc<Page>, GenerationFailure>;
#[derive(Debug)]
pub struct PageDynamic;
impl std::fmt::Display for PageDynamic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("App route requires dynamic rendering")
    }
}
impl std::error::Error for PageDynamic {}
#[derive(Debug)]
struct Invalidated;
impl std::fmt::Display for Invalidated {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("route generation invalidated")
    }
}
impl std::error::Error for Invalidated {}

pub struct Invalidation {
    pub tags: Vec<String>,
    pub paths: Vec<String>,
    pub consumers: Vec<String>,
    pub all: bool,
    pub stale: bool,
    pub expire: Option<u64>,
}
impl Invalidation {
    fn matches(&self, tags: &[String], paths: &[String]) -> bool {
        self.all
            || tags.iter().any(|tag| self.tags.contains(tag))
            || paths
                .iter()
                .any(|path| self.paths.contains(path) || self.consumers.contains(path))
    }
}
#[derive(Clone, Copy, Default)]
struct SeedState {
    stale_at: Option<u64>,
    hard_at: Option<u64>,
}

type Flight = watch::Receiver<Option<Outcome>>;

struct Generation {
    _permit: OwnedSemaphorePermit,
    active: AtomicBool,
    method: &'static str,
    document_request: Mutex<Option<DocumentRequest>>,
}

struct GenerationRequest<'a> {
    method: &'static str,
    document: Option<DocumentRequestSource<'a>>,
}

#[derive(Default)]
struct Publication {
    revision: Option<i64>,
    external: bool,
    expected_html: Option<Option<String>>,
}

#[derive(Debug)]
pub struct PageBusy;
impl std::fmt::Display for PageBusy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("page regeneration queue full")
    }
}
impl std::error::Error for PageBusy {}

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    html: String,
    #[serde(default)]
    data: Option<String>,
    generated_at: u64,
    revalidate: Revalidate,
    status: u16,
    headers: BTreeMap<String, HeaderValues>,
    bytes: u64,
    #[serde(default)]
    app: bool,
    #[serde(default)]
    handler: bool,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    stale_at: Option<u64>,
    #[serde(default)]
    hard_at: Option<u64>,
    #[serde(default)]
    cache_version: Option<String>,
}

struct Files {
    html: PathBuf,
    data: Option<PathBuf>,
    retired: AtomicBool,
}
impl Files {
    fn remove(&self) {
        for file in std::iter::once(&self.html).chain(self.data.iter()) {
            let _ = std::fs::remove_file(file);
            let _ = std::fs::remove_file(gzip_name(file));
        }
    }
}
impl Drop for Files {
    fn drop(&mut self) {
        if self.retired.load(Ordering::Relaxed) {
            self.remove();
        }
    }
}

pub struct Page {
    record: Record,
    files: Arc<Files>,
}
impl Page {
    fn fresh(&self, now: u64) -> bool {
        if self.record.stale_at.is_some_and(|time| now >= time)
            || self.record.hard_at.is_some_and(|time| now >= time)
        {
            return false;
        }
        match self.record.revalidate {
            Revalidate::Never => true,
            Revalidate::Seconds(0) => false,
            Revalidate::Seconds(seconds) => {
                now < self
                    .record
                    .generated_at
                    .saturating_add(seconds.saturating_mul(1000))
            }
        }
    }
    pub fn cache_control(&self) -> String {
        match self.record.revalidate {
            Revalidate::Never => "public, max-age=0, s-maxage=31536000".into(),
            Revalidate::Seconds(0) => {
                "private, no-cache, no-store, max-age=0, must-revalidate".into()
            }
            Revalidate::Seconds(seconds) => {
                if seconds < 31536000 {
                    format!(
                        "public, max-age=0, s-maxage={seconds}, stale-while-revalidate={}",
                        31536000 - seconds
                    )
                } else {
                    format!("public, max-age=0, s-maxage={seconds}")
                }
            }
        }
    }
    pub fn is_handler(&self) -> bool {
        self.record.handler
    }
    pub fn handler_headers(&self) -> &BTreeMap<String, HeaderValues> {
        &self.record.headers
    }
    pub fn handler_status(&self) -> u16 {
        self.record.status
    }
    pub fn is_app(&self) -> bool {
        self.record.app
    }
    pub fn file(&self, data: bool) -> PathBuf {
        if data {
            self.files.data.as_ref().unwrap_or(&self.files.html).clone()
        } else {
            self.files.html.clone()
        }
    }
    pub fn handler_metadata(&self) -> Prerendered {
        let mut headers = self.record.headers.clone();
        headers
            .entry("etag".into())
            .or_insert_with(|| format!("W/\"{}-body\"", self.record.html).into());
        Prerendered {
            path: String::new(),
            file: String::new(),
            data_file: None,
            status: self.record.status,
            headers,
            revalidate: self.record.revalidate,
            generated_at: self.record.generated_at,
            tags: self.record.tags.clone(),
            paths: self.record.paths.clone(),
        }
    }
    pub fn metadata(&self, data: bool) -> Prerendered {
        let mut headers = self.record.headers.clone();
        headers.remove("cache-control");
        if data {
            headers.remove("location");
            headers.insert(
                "content-type".into(),
                if self.record.app {
                    "text/x-component; charset=utf-8"
                } else {
                    "application/json; charset=utf-8"
                }
                .into(),
            );
        }
        let suffix = if data { "data" } else { "html" };
        headers.insert(
            "etag".into(),
            format!("W/\"{}-{suffix}\"", self.record.html).into(),
        );
        Prerendered {
            path: String::new(),
            file: String::new(),
            data_file: None,
            status: if data && self.record.status != 404 {
                200
            } else {
                self.record.status
            },
            headers,
            revalidate: self.record.revalidate,
            generated_at: self.record.generated_at,
            tags: self.record.tags.clone(),
            paths: self.record.paths.clone(),
        }
    }
}

pub struct Selection {
    pub page: Arc<Page>,
    pub state: &'static str,
    pub fallback: bool,
}

pub struct PageCache {
    build_id: String,
    cache_id: String,
    dev: bool,
    dist: PathBuf,
    directory: PathBuf,
    routes: Vec<(Arc<Route>, RoutePattern)>,
    built: HashMap<String, Prerendered>,
    store: Mutex<Option<Store>>,
    flights: Mutex<HashMap<String, Flight>>,
    failures: Mutex<HashMap<String, tokio::time::Instant>>,
    dynamic: Mutex<HashSet<String>>,
    slots: Arc<Semaphore>,
    pool: WorkerPool,
    generation_timeout: Duration,
    external: bool,
    memory_budget: Option<u64>,
}
impl PageCache {
    pub fn new(
        project: &Path,
        dist: &Path,
        manifest: &Manifest,
        worker: WorkerConfig,
    ) -> Result<Option<Arc<Self>>> {
        if !manifest.routes.iter().any(|route| route.ssg) {
            return Ok(None);
        }
        let mut routes = manifest
            .routes
            .iter()
            .map(|route| {
                Ok((
                    Arc::new(route.clone()),
                    RoutePattern::parse(&route.pattern)?,
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        if routes.is_empty() {
            return Ok(None);
        }
        routes.sort_by(|a, b| b.1.specificity.cmp(&a.1.specificity));
        let built = manifest
            .prerendered
            .iter()
            .map(|page| {
                Ok((
                    format!("/{}", decode_path(&page.path)?.join("/")),
                    page.clone(),
                ))
            })
            .collect::<Result<HashMap<_, _>>>()?;
        Ok(Some(Arc::new(Self {
            cache_id: manifest
                .cache_id
                .clone()
                .or_else(|| manifest.build_id.clone())
                .context("SSG cache identifier missing")?,
            build_id: manifest
                .build_id
                .clone()
                .context("SSG build identifier missing")?,
            dist: dist.to_path_buf(),
            directory: project.join(".rustyx-cache/pages"),
            routes,
            built,
            store: Mutex::new(None),
            flights: Mutex::new(HashMap::new()),
            failures: Mutex::new(HashMap::new()),
            dynamic: Mutex::new(HashSet::new()),
            slots: Arc::new(Semaphore::new(GENERATIONS)),
            pool: WorkerPool::new(worker, 1).retire_after(Duration::from_secs(30)),
            generation_timeout: Duration::from_secs(60),
            dev: manifest.dev,
            external: manifest.config.cache_handler.is_some(),
            memory_budget: manifest.config.cache_max_memory_size,
        })))
    }
    pub fn build_id(&self) -> &str {
        &self.build_id
    }
    fn is_handler_path(&self, path: &str) -> bool {
        let parts = path
            .trim_matches('/')
            .split('/')
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        self.route(path, &parts).is_some_and(|(route, _)| {
            route.kind == crate::manifest::RouteKind::Api && route.router.as_deref() == Some("app")
        })
    }
    fn has_build_seed(&self, path: &str) -> bool {
        self.built
            .get(path)
            .is_some_and(|page| page.data_file.is_some() || self.is_handler_path(path))
    }
    fn is_app_path(&self, path: &str) -> bool {
        let parts = path
            .trim_matches('/')
            .split('/')
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        self.route(path, &parts)
            .is_some_and(|(route, _)| route.router.as_deref() == Some("app"))
    }
    async fn revision(self: &Arc<Self>, admission: Arc<Generation>) -> Result<i64> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let _admission = admission;
            let mut store = this
                .store
                .lock()
                .map_err(|_| anyhow!("page cache lock poisoned"))?;
            if store.is_none() {
                *store = Some(Store::open_with_budget(
                    &this.directory,
                    this.memory_budget,
                )?);
            }
            store.as_ref().unwrap().revision()
        })
        .await?
    }
    pub fn invalidate_with<T>(
        &self,
        invalidation: &Invalidation,
        operation: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        if !self.external
            && !self
                .routes
                .iter()
                .any(|(route, _)| route.ssg && route.router.as_deref() == Some("app"))
        {
            return operation();
        }
        let mut store = self
            .store
            .lock()
            .map_err(|_| anyhow!("page cache lock poisoned"))?;
        if store.is_none() {
            *store = Some(Store::open_with_budget(
                &self.directory,
                self.memory_budget,
            )?);
        }
        let seeds = self
            .built
            .iter()
            .filter(|(path, page)| {
                self.is_app_path(path) && invalidation.matches(&page.tags, &page.paths)
            })
            .take(MAX_ENTRIES + 1)
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        store
            .as_mut()
            .unwrap()
            .invalidate(&self.cache_id, invalidation, &seeds)?;
        // Keep the route revision lock across the data-cache commit. A fresh
        // route render cannot snapshot the new revision while reading old data.
        operation()
    }
    fn route(&self, path: &str, parts: &[String]) -> Option<(Arc<Route>, Params)> {
        self.routes
            .iter()
            .find_map(|(route, pattern)| {
                if pattern
                    .static_path()
                    .as_ref()
                    .is_some_and(|value| value == path)
                {
                    Some((route.clone(), Params::new()))
                } else {
                    pattern.matches(parts).map(|params| (route.clone(), params))
                }
            })
            .filter(|(route, _)| route.ssg && route.allows(path))
    }
    #[cfg(test)]
    async fn stored(self: &Arc<Self>, path: &str) -> Result<(Option<Arc<Page>>, u64, SeedState)> {
        self.stored_admitted(path, None).await
    }
    async fn stored_admitted(
        self: &Arc<Self>,
        path: &str,
        admission: Option<Arc<Generation>>,
    ) -> Result<(Option<Arc<Page>>, u64, SeedState)> {
        let this = self.clone();
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            let _admission = admission;
            this.stored_sync(&path)
        })
        .await?
    }
    fn stored_sync(&self, path: &str) -> Result<(Option<Arc<Page>>, u64, SeedState)> {
        let mut store = self
            .store
            .lock()
            .map_err(|_| anyhow!("page cache lock poisoned"))?;
        if store.is_none() && self.directory.join("index.sqlite3").exists() {
            *store = Some(Store::open_with_budget(
                &self.directory,
                self.memory_budget,
            )?);
        }
        match store.as_mut() {
            Some(store) => {
                // Seed invalidation only matters when falling back to the build.
                // A published generation already carries its own invalidation.
                if let Some(page) = store.get(&self.cache_id, path)? {
                    return Ok((Some(page), 0, SeedState::default()));
                }
                Ok((
                    None,
                    store.seed_watermark()?,
                    store.seed_state(&self.cache_id, path)?,
                ))
            }
            None => Ok((None, 0, SeedState::default())),
        }
    }
    async fn lookup(self: &Arc<Self>, path: &str) -> Result<Option<Arc<Page>>> {
        let this = self.clone();
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || this.lookup_sync(&path)).await?
    }
    fn lookup_sync(&self, path: &str) -> Result<Option<Arc<Page>>> {
        let (stored, seed_watermark, invalid) = self.stored_sync(path)?;
        if let Some(page) = stored {
            return Ok(Some(page));
        }
        let Some(page) = self.built.get(path) else {
            return Ok(None);
        };
        if seed_watermark > 0 && page.generated_at <= seed_watermark {
            return Ok(None);
        }
        let handler = self.is_handler_path(path);
        if page.data_file.is_none() && !handler {
            return Ok(None);
        }
        let html = crate::server::contained_file_sync(&self.dist, &page.file)?
            .context("SSG HTML file missing")?;
        let data_file = match &page.data_file {
            Some(data) => Some(
                crate::server::contained_file_sync(&self.dist, data)?
                    .context("SSG data file missing")?,
            ),
            None => None,
        };
        Ok(Some(Arc::new(Page {
            record: Record {
                html: format!("{}-{}", self.cache_id, page.file.replace('/', "-")),
                data: page.data_file.clone(),
                generated_at: page.generated_at,
                revalidate: page.revalidate,
                status: page.status,
                headers: if handler {
                    clean_handler_headers(page.headers.clone())?
                } else {
                    page.headers.clone()
                },
                bytes: 0,
                app: self.is_app_path(path),
                handler,
                tags: page.tags.clone(),
                paths: page.paths.clone(),
                stale_at: invalid.stale_at,
                hard_at: invalid.hard_at,
                cache_version: None,
            },
            files: Arc::new(Files {
                html,
                data: data_file,
                retired: AtomicBool::new(false),
            }),
        })))
    }

    fn external_kind(route: &Route) -> &'static str {
        if route.router.as_deref() != Some("app") {
            "PAGES"
        } else if route.kind == crate::manifest::RouteKind::Api {
            "APP_ROUTE"
        } else {
            "APP_PAGE"
        }
    }

    async fn external_rpc(
        &self,
        path: &str,
        route: &Route,
        mut operation: serde_json::Value,
    ) -> Result<RenderedResponse> {
        operation["key"] = format!("rustyx:{}:{path}", self.cache_id).into();
        operation["kind"] = Self::external_kind(route).into();
        let bytes = serde_json::to_vec(&operation)?;
        if bytes.len() > 128 * 1024 {
            bail!("incremental cache operation exceeds its metadata budget");
        }
        self.pool
            .request(
                WorkerRequest {
                    id: 0,
                    route_id: "__rustyx_incremental_cache".into(),
                    method: "POST".into(),
                    url: "http://rustyx.local/".into(),
                    original_url: None,
                    headers: BTreeMap::new(),
                    routing_request_headers: None,
                    routing_resolver: None,
                    body: bytes.into(),
                    params: Params::new(),
                    stream: true,
                    render_mode: Some("incremental-cache".into()),
                    revalidate_reason: None,
                    page_failure: None,
                    document_request: None,
                    middleware_matched: false,
                },
                None,
            )
            .await
            .map_err(|error| anyhow!("incremental cache worker failed: {error:?}"))
    }

    async fn external_invalidate(&self, path: &str, route: &Route) -> Result<()> {
        let tag = format!("_N_T_{}/page", path.trim_end_matches('/'));
        let reply = self
            .external_rpc(
                path,
                route,
                serde_json::json!({"op":"invalidate","tags":[tag]}),
            )
            .await?;
        if reply.status != 204 || reply.isr.is_some() {
            bail!("incremental cache invalidation failed");
        }
        crate::middleware::drain_control(reply.body).await
    }

    async fn external_set(
        &self,
        path: &str,
        route: &Route,
        record: &Record,
        files: &Files,
    ) -> Result<()> {
        let reply = self
            .external_rpc(
                path,
                route,
                serde_json::json!({
                    "op":"set", "htmlFile":files.html, "dataFile":files.data,
                    "status":record.status,"headers":record.headers,"revalidate":record.revalidate,
                    "tags":record.tags,"paths":record.paths,
                }),
            )
            .await?;
        if reply.status != 204 || reply.isr.is_some() {
            bail!("incremental cache publication failed");
        }
        crate::middleware::drain_control(reply.body).await
    }

    async fn external_lookup(
        self: &Arc<Self>,
        path: &str,
        route: Arc<Route>,
    ) -> Result<Option<Arc<Page>>> {
        let admission = Arc::new(Generation {
            _permit: self
                .slots
                .clone()
                .try_acquire_owned()
                .map_err(|_| PageBusy)?,
            active: AtomicBool::new(true),
            method: "GET",
            document_request: Mutex::new(None),
        });
        for _ in 0..2 {
            let revision = self.revision(admission.clone()).await?;
            let current = self.stored_admitted(path, Some(admission.clone())).await?.0;
            let known_version = current
                .as_ref()
                .filter(|page| page.record.revalidate != Revalidate::Seconds(0))
                .and_then(|page| page.record.cache_version.as_deref());
            let tags = current
                .as_ref()
                .map(|page| page.record.tags.clone())
                .unwrap_or_default();
            let mut paths = current
                .as_ref()
                .map(|page| page.record.paths.clone())
                .unwrap_or_default();
            for value in [format!("page:{path}"), format!("page:{}", route.pattern)] {
                if !paths.contains(&value) {
                    paths.push(value);
                }
            }
            let reply = self.external_rpc(path, &route, serde_json::json!({"op":"get","knownVersion":known_version,"tags":tags,"paths":paths})).await?;
            if reply.status == 204 && reply.isr.is_none() {
                crate::middleware::drain_control(reply.body).await?;
                // The external backend is authoritative. In particular, a build
                // seed cannot resurrect data removed by another instance.
                return Ok(None);
            }
            if reply.status == 304 && reply.isr.is_none() {
                let version = reply
                    .headers
                    .get("x-rustyx-cache-version")
                    .and_then(|header| header.values().first().map(String::as_str));
                if known_version.is_none() || version != known_version {
                    bail!("invalid unchanged incremental cache response");
                }
                crate::middleware::drain_control(reply.body).await?;
                let latest = self.stored_admitted(path, Some(admission.clone())).await?.0;
                if self.revision(admission.clone()).await? != revision
                    || latest.as_ref().map(|page| &page.record.html)
                        != current.as_ref().map(|page| &page.record.html)
                {
                    continue;
                }
                return Ok(latest);
            }
            let publication = Publication {
                revision: Some(revision),
                external: true,
                expected_html: Some(current.as_ref().map(|page| page.record.html.clone())),
            };
            match self
                .publish_reply(path, route.clone(), reply, admission.clone(), publication)
                .await
            {
                Ok(page) => return Ok(Some(page)),
                Err(error) if error.is::<Invalidated>() => continue,
                Err(error) => return Err(error),
            }
        }
        bail!("incremental cache changed during lookup")
    }
    pub async fn select(
        self: &Arc<Self>,
        path: &str,
        parts: &[String],
        blocking: bool,
    ) -> Result<Option<Selection>> {
        self.select_method(path, parts, blocking, "GET").await
    }
    pub async fn select_method(
        self: &Arc<Self>,
        path: &str,
        parts: &[String],
        blocking: bool,
        method: &'static str,
    ) -> Result<Option<Selection>> {
        self.select_request(path, parts, blocking, method, None)
            .await
    }
    pub async fn select_request(
        self: &Arc<Self>,
        path: &str,
        parts: &[String],
        blocking: bool,
        method: &'static str,
        document_request: Option<DocumentRequestSource<'_>>,
    ) -> Result<Option<Selection>> {
        let Some((route, params)) = self.route(path, parts) else {
            return Ok(None);
        };
        let app = route.router.as_deref() == Some("app");
        let method = if app && route.kind == crate::manifest::RouteKind::Api && method == "HEAD" {
            "HEAD"
        } else {
            "GET"
        };
        if app
            && (self.dev
                || route
                    .dynamic_paths
                    .as_ref()
                    .is_some_and(|paths| paths.contains(path))
                || self.dynamic.lock().unwrap().contains(path))
        {
            return Err(PageDynamic.into());
        }
        if self.dev {
            return Ok(Some(Selection {
                page: wait(self.begin_request(
                    path,
                    route,
                    params,
                    "stale",
                    true,
                    GenerationRequest {
                        method,
                        document: document_request,
                    },
                )?)
                .await?,
                state: "MISS",
                fallback: false,
            }));
        }
        let selected = if self.external {
            self.external_lookup(path, route.clone()).await?
        } else {
            self.lookup(path).await?
        };
        if let Some(page) = selected {
            if page.fresh(now_ms()) {
                return Ok(Some(Selection {
                    page,
                    state: "HIT",
                    fallback: false,
                }));
            }
            if page.record.revalidate == Revalidate::Seconds(0)
                || page.record.hard_at.is_some_and(|time| now_ms() >= time)
            {
                let flight = self.begin_request(
                    path,
                    route,
                    params,
                    "stale",
                    true,
                    GenerationRequest {
                        method,
                        document: document_request,
                    },
                )?;
                return Ok(Some(Selection {
                    page: wait(flight).await?,
                    state: "MISS",
                    fallback: false,
                }));
            }
            // A failed refresh does not poison the last good pair. Backoff only
            // bounds repeated failing application work; the old page stays readable.
            let _ = self.begin_request(
                path,
                route,
                params,
                "stale",
                false,
                GenerationRequest {
                    method,
                    document: document_request,
                },
            );
            return Ok(Some(Selection {
                page,
                state: "STALE",
                fallback: false,
            }));
        }
        let seeded = self.has_build_seed(path);
        if !seeded
            && app
            && (route.fallback.as_ref().and_then(serde_json::Value::as_str) == Some("ppr")
                || route.kind == crate::manifest::RouteKind::Api
                    && route.fallback.as_ref().and_then(serde_json::Value::as_str)
                        == Some("dynamic"))
        {
            return Err(PageDynamic.into());
        }
        if !seeded && route.fallback == Some(serde_json::Value::Bool(false)) {
            return Ok(None);
        }
        let fallback =
            !seeded && route.fallback == Some(serde_json::Value::Bool(true)) && !blocking;
        let flight = self.begin_request(
            path,
            route.clone(),
            params,
            "stale",
            true,
            GenerationRequest {
                method,
                document: document_request,
            },
        )?;
        if fallback {
            if let Some(file) = &route.fallback_file {
                let html = crate::server::contained_file(&self.dist, file)
                    .await?
                    .context("fallback file missing")?;
                let page = Arc::new(Page {
                    record: Record {
                        html: file.clone(),
                        data: None,
                        generated_at: now_ms(),
                        revalidate: Revalidate::Seconds(0),
                        status: 200,
                        headers: BTreeMap::from([(
                            "content-type".into(),
                            "text/html; charset=utf-8".into(),
                        )]),
                        bytes: 0,
                        app: false,
                        handler: false,
                        tags: Vec::new(),
                        paths: Vec::new(),
                        stale_at: None,
                        hard_at: None,
                        cache_version: None,
                    },
                    files: Arc::new(Files {
                        html: html.clone(),
                        data: None,
                        retired: AtomicBool::new(false),
                    }),
                });
                return Ok(Some(Selection {
                    page,
                    state: "MISS",
                    fallback: true,
                }));
            }
        }
        Ok(Some(Selection {
            page: wait(flight).await?,
            state: "MISS",
            fallback: false,
        }))
    }
    fn begin(
        self: &Arc<Self>,
        path: &str,
        route: Arc<Route>,
        params: Params,
        reason: &'static str,
        foreground: bool,
    ) -> Result<Flight> {
        self.begin_method(path, route, params, reason, foreground, "GET")
    }
    fn begin_method(
        self: &Arc<Self>,
        path: &str,
        route: Arc<Route>,
        params: Params,
        reason: &'static str,
        foreground: bool,
        method: &'static str,
    ) -> Result<Flight> {
        self.begin_request(
            path,
            route,
            params,
            reason,
            foreground,
            GenerationRequest {
                method,
                document: None,
            },
        )
    }
    fn begin_request(
        self: &Arc<Self>,
        path: &str,
        route: Arc<Route>,
        params: Params,
        reason: &'static str,
        foreground: bool,
        request: GenerationRequest<'_>,
    ) -> Result<Flight> {
        let mut flights = self.flights.lock().unwrap();
        if let Some(flight) = flights.get(path) {
            return Ok(flight.clone());
        }
        if !foreground
            && self
                .failures
                .lock()
                .unwrap()
                .get(path)
                .is_some_and(|until| *until > tokio::time::Instant::now())
        {
            bail!("page regeneration cooling down");
        }
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| PageBusy)?;
        let admission = Arc::new(Generation {
            _permit: permit,
            active: AtomicBool::new(true),
            method: request.method,
            document_request: Mutex::new(
                request
                    .document
                    .map(DocumentRequestSource::capture)
                    .transpose()?,
            ),
        });
        let (sender, receiver) = watch::channel(None);
        flights.insert(path.to_owned(), receiver.clone());
        let this = self.clone();
        let path = path.to_owned();
        tokio::spawn(async move {
            let outcome = tokio::time::timeout(
                this.generation_timeout,
                this.generate(&path, route, params, reason, admission.clone()),
            )
            .await
            .unwrap_or_else(|_| Err(anyhow!("page regeneration timed out")));
            admission.active.store(false, Ordering::Release);
            if outcome.is_err() {
                let mut failures = this.failures.lock().unwrap();
                failures.retain(|_, until| *until > tokio::time::Instant::now());
                if failures.len() < MAX_ENTRIES {
                    failures.insert(
                        path.clone(),
                        tokio::time::Instant::now() + Duration::from_secs(1),
                    );
                }
            } else {
                this.failures.lock().unwrap().remove(&path);
            }
            let outcome = outcome.map_err(|error| {
                tracing::warn!(%error, path, "page regeneration failed; retaining previous generation");
                if error.is::<PageDynamic>() { GenerationFailure::Dynamic }
                else { GenerationFailure::Failed(error.downcast_ref::<PageGenerationError>().map(|error| error.0.clone())) }
            });
            let mut flights = this.flights.lock().unwrap();
            sender.send_replace(Some(outcome));
            flights.remove(&path);
            drop(admission);
        });
        Ok(receiver)
    }
    pub async fn revalidate(
        self: &Arc<Self>,
        raw_path: &str,
        only_generated: bool,
    ) -> Result<bool> {
        if raw_path.contains(['?', '#']) || raw_path.starts_with("//") {
            bail!("revalidate requires an application pathname");
        }
        let parts = decode_path(raw_path)?;
        let path = format!("/{}", parts.join("/"));
        let Some((route, params)) = self.route(&path, &parts) else {
            if only_generated {
                return Ok(false);
            }
            bail!("path is not an SSG page");
        };
        let exists = self.has_build_seed(&path)
            || if self.external {
                self.external_lookup(&path, route.clone()).await?.is_some()
            } else {
                self.lookup(&path).await?.is_some()
            };
        if !exists && only_generated {
            return Ok(false);
        }
        if !exists
            && (route.fallback == Some(serde_json::Value::Bool(false))
                || route.kind == crate::manifest::RouteKind::Api
                    && route.router.as_deref() == Some("app")
                    && route.fallback.as_ref().and_then(serde_json::Value::as_str)
                        == Some("dynamic"))
        {
            bail!("path is excluded by static paths");
        }
        let current = self.flights.lock().unwrap().get(&path).cloned();
        if let Some(current) = current {
            let _ = wait(current).await;
        }
        // The on-demand render starts after any preceding render and its data
        // reads, rather than treating an older in-flight generation as fresh.
        wait(self.begin(&path, route, params, "on-demand", true)?).await?;
        Ok(true)
    }
    async fn generate(
        self: &Arc<Self>,
        path: &str,
        route: Arc<Route>,
        params: Params,
        reason: &str,
        admission: Arc<Generation>,
    ) -> Result<Arc<Page>> {
        let result = self
            .generate_once(
                path,
                route.clone(),
                params.clone(),
                reason,
                admission.clone(),
            )
            .await;
        if result
            .as_ref()
            .is_err_and(|error| error.is::<Invalidated>())
        {
            if self.external {
                self.external_invalidate(path, &route).await?;
            }
            let retry = self
                .generate_once(path, route.clone(), params, reason, admission)
                .await;
            if self.external && retry.as_ref().is_err_and(|error| error.is::<Invalidated>()) {
                self.external_invalidate(path, &route).await?;
            }
            retry
        } else {
            result
        }
    }
    async fn generate_once(
        self: &Arc<Self>,
        path: &str,
        route: Arc<Route>,
        params: Params,
        reason: &str,
        admission: Arc<Generation>,
    ) -> Result<Arc<Page>> {
        let app = route.router.as_deref() == Some("app");
        let revision = if app || self.external {
            Some(self.revision(admission.clone()).await?)
        } else {
            None
        };
        let parts = path
            .trim_start_matches('/')
            .split('/')
            .map(|part| percent_encoding::utf8_percent_encode(part, PATH_SEGMENT).to_string())
            .collect::<Vec<_>>();
        let document_request = admission.document_request.lock().unwrap().take();
        let reply = self
            .pool
            .request(
                WorkerRequest {
                    id: 0,
                    route_id: route.id.clone(),
                    method: admission.method.into(),
                    url: format!("http://rustyx.local/{}", parts.join("/")),
                    headers: BTreeMap::new(),
                    body: Default::default(),
                    params,
                    stream: true,
                    original_url: None,
                    routing_request_headers: None,
                    routing_resolver: None,
                    render_mode: Some("isr".into()),
                    revalidate_reason: Some(reason.into()),
                    page_failure: None,
                    document_request,
                    middleware_matched: false,
                },
                None,
            )
            .await
            .map_err(|error| anyhow!("maintenance worker failed: {error:?}"))?;
        if let Some(failure) = reply.page_failure {
            crate::middleware::drain_control(reply.body).await?;
            return Err(PageGenerationError(Arc::new(failure)).into());
        }
        self.publish_reply(
            path,
            route,
            reply,
            admission,
            Publication {
                revision,
                ..Default::default()
            },
        )
        .await
    }

    async fn publish_reply(
        self: &Arc<Self>,
        path: &str,
        route: Arc<Route>,
        reply: RenderedResponse,
        admission: Arc<Generation>,
        publication: Publication,
    ) -> Result<Arc<Page>> {
        let app = route.router.as_deref() == Some("app");
        let handler = app && route.kind == crate::manifest::RouteKind::Api;
        let meta = reply
            .isr
            .context("maintenance response lacks ISR metadata")?;
        if handler != (meta.kind.as_deref() == Some("route"))
            || meta.kind.as_deref().is_some_and(|kind| kind != "route")
        {
            bail!("ISR response kind does not match its route");
        }
        if meta.dynamic {
            if publication.external || !app || meta.html_length != 0 || meta.data_length != 0 {
                bail!("invalid dynamic bailout metadata");
            }
            match reply.body {
                RenderedBody::Buffered(bytes) if bytes.is_empty() => {}
                RenderedBody::Stream(mut stream) => {
                    if std::future::poll_fn(|cx| Pin::new(&mut stream).poll_next(cx))
                        .await
                        .is_some()
                    {
                        bail!("dynamic bailout unexpectedly included a body");
                    }
                }
                _ => bail!("dynamic bailout unexpectedly included a body"),
            }
            if self.built.contains_key(path)
                || self
                    .stored_admitted(path, Some(admission))
                    .await?
                    .0
                    .is_some()
            {
                bail!("static App route became dynamic during regeneration");
            }
            let mut dynamic = self.dynamic.lock().unwrap();
            if dynamic.len() < MAX_ENTRIES {
                dynamic.insert(path.to_owned());
            }
            return Err(PageDynamic.into());
        }
        if meta.html_length > MAX_FILE
            || meta.data_length > MAX_FILE
            || self.external && meta.html_length.saturating_add(meta.data_length) > MAX_FILE
            || if handler {
                meta.data_length != 0
                    || !(200..=599).contains(&reply.status)
                    || matches!(reply.status, 204 | 205 | 304) && meta.html_length != 0
            } else {
                meta.data_length == 0
                    || !(matches!(reply.status, 200 | 301 | 302 | 303 | 307 | 308 | 404)
                        || reply.status == 500 && route.error_status == Some(500))
            }
        {
            bail!("invalid ISR response metadata");
        }
        let generated_at = if publication.external {
            let timestamp = meta
                .last_modified
                .context("external cache timestamp missing")?;
            let version = meta
                .cache_version
                .as_deref()
                .context("external cache version missing")?;
            if timestamp < -1
                || timestamp > now_ms().saturating_add(60_000) as i64
                || version.len() != 64
                || !version.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                bail!("invalid external cache metadata");
            }
            timestamp.max(0) as u64
        } else {
            now_ms()
        };
        let directory = self.directory.join("files");
        tokio::fs::create_dir_all(&directory).await?;
        let generation = token()?;
        let html_name = format!(
            "{}-{generation}.{}",
            self.cache_id,
            if handler { "body" } else { "html" }
        );
        let data_name = (!handler).then(|| format!("{}-{generation}.json", self.cache_id));
        let files = Arc::new(Files {
            html: directory.join(&html_name),
            data: data_name.as_ref().map(|name| directory.join(name)),
            retired: AtomicBool::new(true),
        });
        write_pair(&files, reply.body, meta.html_length, meta.data_length).await?;
        let headers = if handler {
            clean_handler_headers(reply.headers)?
        } else {
            clean_headers(reply.headers)?
        };
        let mut record = Record {
            html: html_name,
            data: data_name,
            generated_at,
            revalidate: if self.dev {
                Revalidate::Seconds(0)
            } else {
                meta.revalidate
            },
            status: reply.status,
            headers,
            bytes: 0,
            app,
            handler,
            tags: crate::cache::associations(meta.tags, 1024, true)?,
            paths: crate::cache::associations(meta.paths, 8192, false)?,
            stale_at: None,
            hard_at: None,
            cache_version: if publication.external {
                meta.cache_version
            } else {
                None
            },
        };
        if self.external {
            for association in [format!("page:{path}"), format!("page:{}", route.pattern)] {
                if !record.paths.contains(&association) {
                    record.paths.push(association);
                }
            }
            record.paths = crate::cache::associations(record.paths, 8192, false)?;
            if !publication.external {
                if let Some(revision) = publication.revision {
                    if self.revision(admission.clone()).await? != revision {
                        return Err(Invalidated.into());
                    }
                }
                self.external_set(path, &route, &record, &files).await?;
            }
        }
        let this = self.clone();
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            let mut record = record;
            if record.revalidate == Revalidate::Seconds(0) {
                record.bytes = 0;
            } else {
                record.bytes = if handler && record.headers.contains_key("content-encoding") {
                    std::fs::metadata(&files.html)?.len()
                } else {
                    compress(&files.html)?
                };
                if let Some(data) = &files.data {
                    record.bytes += compress(data)?;
                }
            }
            let mut store = this
                .store
                .lock()
                .map_err(|_| anyhow!("page cache lock poisoned"))?;
            if store.is_none() {
                *store = Some(Store::open_with_budget(
                    &this.directory,
                    this.memory_budget,
                )?);
            }
            if !admission.active.load(Ordering::Acquire) {
                bail!("page generation expired before publication");
            }
            if let Some(revision) = publication.revision {
                if store.as_ref().unwrap().revision()? != revision {
                    return Err(Invalidated.into());
                }
            }
            if let Some(expected) = publication.expected_html {
                let current = store.as_mut().unwrap().get(&this.cache_id, &path)?;
                if current.as_ref().map(|page| page.record.html.clone()) != expected {
                    return Err(Invalidated.into());
                }
            }
            store
                .as_mut()
                .unwrap()
                .publish(&this.cache_id, &path, record, files)
        })
        .await?
    }
}

async fn wait(mut flight: Flight) -> Result<Arc<Page>> {
    tokio::time::timeout(Duration::from_secs(65), async {
        loop {
            if let Some(outcome) = flight.borrow_and_update().clone() {
                return outcome.map_err(|error| match error {
                    GenerationFailure::Dynamic => PageDynamic.into(),
                    GenerationFailure::Failed(Some(failure)) => PageGenerationError(failure).into(),
                    GenerationFailure::Failed(None) => anyhow!("Page regeneration failed"),
                });
            }
            flight
                .changed()
                .await
                .context("page regeneration interrupted")?;
        }
    })
    .await
    .context("page regeneration timed out")?
}

async fn write_pair(
    files: &Files,
    body: RenderedBody,
    html_length: usize,
    data_length: usize,
) -> Result<()> {
    let mut html = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&files.html)
        .await?;
    let mut data = match &files.data {
        Some(file) => Some(
            tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(file)
                .await?,
        ),
        None => None,
    };
    let mut consumed = 0usize;
    let mut write = async |bytes: &[u8]| -> Result<()> {
        if consumed
            .checked_add(bytes.len())
            .is_none_or(|length| length > html_length + data_length)
        {
            bail!("ISR response exceeds declared lengths");
        }
        let html_count = html_length.saturating_sub(consumed).min(bytes.len());
        if html_count > 0 {
            html.write_all(&bytes[..html_count]).await?;
        }
        if html_count < bytes.len() {
            data.as_mut()
                .context("unexpected data bytes for body-only response")?
                .write_all(&bytes[html_count..])
                .await?;
        }
        consumed += bytes.len();
        Ok(())
    };
    match body {
        RenderedBody::Buffered(bytes) => write(&bytes).await?,
        RenderedBody::Compact(_) => bail!("compact response cannot publish an ISR generation"),
        RenderedBody::Stream(mut stream) => {
            while let Some(bytes) =
                std::future::poll_fn(|cx| Pin::new(&mut stream).poll_next(cx)).await
            {
                write(&bytes?).await?;
            }
        }
    }
    if consumed != html_length + data_length {
        bail!("ISR response ended before declared lengths");
    }
    html.flush().await?;
    html.sync_all().await?;
    if let Some(data) = data.as_mut() {
        data.flush().await?;
        data.sync_all().await?;
    }
    Ok(())
}

fn clean_headers(
    headers: BTreeMap<String, HeaderValues>,
) -> Result<BTreeMap<String, HeaderValues>> {
    let mut result = BTreeMap::new();
    for (name, value) in headers {
        let name = name.to_ascii_lowercase();
        // SSG output cannot carry request-specific cookies or transport headers.
        if matches!(
            name.as_str(),
            "set-cookie"
                | "content-length"
                | "content-encoding"
                | "connection"
                | "transfer-encoding"
                | "keep-alive"
                | "upgrade"
                | "trailer"
                | "te"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "cache-control"
                | "etag"
                | "last-modified"
        ) {
            continue;
        }
        axum::http::HeaderName::try_from(name.as_str())?;
        let value = match value {
            HeaderValues::Single(value) => value,
            HeaderValues::Multiple(values) => values.join(", "),
        };
        axum::http::HeaderValue::try_from(value.as_str())?;
        result.insert(name, value.into());
    }
    Ok(result)
}
fn clean_handler_headers(
    headers: BTreeMap<String, HeaderValues>,
) -> Result<BTreeMap<String, HeaderValues>> {
    let connection = headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("connection"))
        .flat_map(|(_, values)| values.values())
        .flat_map(|value| value.split(','))
        .map(|value| value.trim().to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut result = BTreeMap::new();
    for (name, values) in headers {
        let name = axum::http::HeaderName::try_from(name)?;
        if crate::server::is_hop_header(&name)
            || name == axum::http::header::CONTENT_LENGTH
            || connection.contains(name.as_str())
        {
            continue;
        }
        for value in values.values() {
            axum::http::HeaderValue::try_from(value)?;
        }
        result.insert(name.to_string(), values);
    }
    Ok(result)
}
fn token() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| anyhow!("random source unavailable: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn gzip_name(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(".gz");
    name.into()
}
fn compress(file: &Path) -> Result<u64> {
    let metadata = std::fs::metadata(file)?;
    let gzip = gzip_name(file);
    let mut source = std::fs::File::open(file)?;
    let output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&gzip)?;
    let mut encoder = flate2::write::GzEncoder::new(output, flate2::Compression::fast());
    std::io::copy(&mut source, &mut encoder)?;
    let output = encoder.finish()?;
    let compressed = output.metadata()?.len();
    if compressed < metadata.len() {
        output.set_times(std::fs::FileTimes::new().set_modified(metadata.modified()?))?;
        output.sync_all()?;
        Ok(metadata.len() + compressed)
    } else {
        drop(output);
        std::fs::remove_file(gzip)?;
        Ok(metadata.len())
    }
}

struct Store {
    connection: Connection,
    directory: PathBuf,
    live: HashMap<String, Weak<Files>>,
    max_bytes: u64,
    max_entries: usize,
    touches: HashMap<(String, String), u64>,
}
impl Store {
    fn open_with_budget(directory: &Path, budget: Option<u64>) -> Result<Self> {
        let store = Self::open(directory)?;
        crate::cache::configure_memory(&store.connection, budget)?;
        Ok(store)
    }
    fn open(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory.join("files"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
        }
        let connection = Connection::open(directory.join("index.sqlite3"))?;
        connection.busy_timeout(Duration::from_secs(2))?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-1024; PRAGMA mmap_size=0; PRAGMA wal_autocheckpoint=128; PRAGMA journal_size_limit=2097152; PRAGMA max_page_count=8192;
            CREATE TABLE IF NOT EXISTS pages(build TEXT NOT NULL,path TEXT NOT NULL,record TEXT NOT NULL,bytes INTEGER NOT NULL,access INTEGER NOT NULL,PRIMARY KEY(build,path)); CREATE INDEX IF NOT EXISTS page_lru ON pages(access);
            CREATE TABLE IF NOT EXISTS page_meta(id INTEGER PRIMARY KEY CHECK(id=1), seed_before INTEGER NOT NULL); INSERT OR IGNORE INTO page_meta VALUES(1,0);
            CREATE TABLE IF NOT EXISTS route_meta(id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL); INSERT OR IGNORE INTO route_meta VALUES(1,0);
            CREATE TABLE IF NOT EXISTS route_seeds(build TEXT NOT NULL,path TEXT NOT NULL,stale_at INTEGER,hard_at INTEGER,PRIMARY KEY(build,path));")?;
        let store = Self {
            connection,
            directory: directory.join("files"),
            live: HashMap::new(),
            max_bytes: MAX_BYTES,
            max_entries: MAX_ENTRIES,
            touches: HashMap::new(),
        };
        store.cleanup_orphans()?;
        Ok(store)
    }
    fn cleanup_orphans(&self) -> Result<()> {
        let mut used = HashSet::new();
        let mut statement = self.connection.prepare("SELECT record FROM pages")?;
        for row in statement.query_map([], |row| row.get::<_, String>(0))? {
            let record: Record = serde_json::from_str(&row?)?;
            if record.revalidate == Revalidate::Seconds(0) {
                continue;
            }
            for file in std::iter::once(record.html).chain(record.data) {
                used.insert(format!("{file}.gz"));
                used.insert(file);
            }
        }
        for file in std::fs::read_dir(&self.directory)? {
            let file = file?;
            if !used.contains(&file.file_name().to_string_lossy().into_owned())
                && file.metadata()?.modified()?.elapsed().unwrap_or_default()
                    > Duration::from_secs(3600)
            {
                let _ = std::fs::remove_file(file.path());
            }
        }
        Ok(())
    }
    fn seed_watermark(&self) -> Result<u64> {
        let watermark: i64 = self.connection.query_row(
            "SELECT seed_before FROM page_meta WHERE id=1",
            [],
            |row| row.get(0),
        )?;
        Ok(watermark as u64)
    }
    fn revision(&self) -> Result<i64> {
        Ok(self.connection.query_row(
            "SELECT generation FROM route_meta WHERE id=1",
            [],
            |row| row.get(0),
        )?)
    }
    fn seed_state(&self, build: &str, path: &str) -> Result<SeedState> {
        Ok(self
            .connection
            .query_row(
                "SELECT stale_at,hard_at FROM route_seeds WHERE build=?1 AND path=?2",
                params![build, path],
                |row| {
                    Ok(SeedState {
                        stale_at: row.get::<_, Option<i64>>(0)?.map(|value| value as u64),
                        hard_at: row.get::<_, Option<i64>>(1)?.map(|value| value as u64),
                    })
                },
            )
            .optional()?
            .unwrap_or_default())
    }
    fn invalidate(
        &mut self,
        build: &str,
        invalidation: &Invalidation,
        seeds: &[String],
    ) -> Result<()> {
        let now = now_ms() as i64;
        let hard = if invalidation.stale {
            invalidation
                .expire
                .map(|duration| now.saturating_add(duration as i64))
        } else {
            Some(now)
        };
        let tags = serde_json::to_string(&invalidation.tags)?;
        let paths = serde_json::to_string(
            &invalidation
                .paths
                .iter()
                .chain(invalidation.consumers.iter())
                .collect::<Vec<_>>(),
        )?;
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        transaction.execute(
            "UPDATE route_meta SET generation=generation+1 WHERE id=1",
            [],
        )?;
        transaction.execute("UPDATE pages SET record=json_set(record,'$.stale_at',?1,'$.hard_at',CASE WHEN ?2 IS NULL THEN json_extract(record,'$.hard_at') WHEN json_extract(record,'$.hard_at') IS NULL THEN ?2 ELSE min(json_extract(record,'$.hard_at'),?2) END) WHERE json_extract(record,'$.app')=1 AND (?3 OR EXISTS(SELECT 1 FROM json_each(pages.record,'$.tags') a JOIN json_each(?4) b ON a.value=b.value) OR EXISTS(SELECT 1 FROM json_each(pages.record,'$.paths') a JOIN json_each(?5) b ON a.value=b.value))",params![now,hard,invalidation.all,tags,paths])?;
        for path in seeds {
            transaction.execute("INSERT INTO route_seeds(build,path,stale_at,hard_at) VALUES(?1,?2,?3,?4) ON CONFLICT(build,path) DO UPDATE SET stale_at=excluded.stale_at,hard_at=CASE WHEN excluded.hard_at IS NULL THEN route_seeds.hard_at WHEN route_seeds.hard_at IS NULL THEN excluded.hard_at ELSE min(route_seeds.hard_at,excluded.hard_at) END",params![build,path,now,hard])?;
        }
        let count: i64 =
            transaction.query_row("SELECT count(*) FROM route_seeds", [], |row| row.get(0))?;
        if count > MAX_ENTRIES as i64 {
            transaction.execute("DELETE FROM route_seeds", [])?;
            transaction.execute(
                "UPDATE page_meta SET seed_before=max(seed_before,?1) WHERE id=1",
                [now],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }
    fn files(&mut self, record: &Record) -> Result<Arc<Files>> {
        for name in std::iter::once(&record.html).chain(record.data.iter()) {
            if name.contains(['/', '\\']) || name.starts_with('.') {
                bail!("invalid persisted page file");
            }
        }
        self.live.retain(|_, files| files.strong_count() > 0);
        if let Some(files) = self.live.get(&record.html).and_then(Weak::upgrade) {
            return Ok(files);
        }
        let files = Arc::new(Files {
            html: self.directory.join(&record.html),
            data: record.data.as_ref().map(|name| self.directory.join(name)),
            retired: AtomicBool::new(false),
        });
        self.live
            .insert(record.html.clone(), Arc::downgrade(&files));
        Ok(files)
    }
    fn get(&mut self, build: &str, path: &str) -> Result<Option<Arc<Page>>> {
        let record = self
            .connection
            .prepare_cached("SELECT record FROM pages WHERE build=?1 AND path=?2")?
            .query_row(params![build, path], |row| row.get::<_, String>(0))
            .optional()?;
        let Some(record) = record else {
            return Ok(None);
        };
        let record: Record = serde_json::from_str(&record)?;
        let files = self.files(&record)?;
        if record.revalidate != Revalidate::Seconds(0)
            && (!files.html.is_file() || files.data.as_ref().is_some_and(|data| !data.is_file()))
        {
            let transaction = self
                .connection
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            transaction.execute(
                "DELETE FROM pages WHERE build=?1 AND path=?2",
                params![build, path],
            )?;
            transaction.execute(
                "UPDATE page_meta SET seed_before=max(seed_before,?1) WHERE id=1",
                [now_ms().max(record.generated_at) as i64],
            )?;
            transaction.commit()?;
            files.retired.store(true, Ordering::Relaxed);
            return Ok(None);
        }
        let key = (build.to_owned(), path.to_owned());
        let now = now_ms();
        if self
            .touches
            .get(&key)
            .is_none_or(|last| now.saturating_sub(*last) >= 30_000)
        {
            self.connection.execute(
                "UPDATE pages SET access=?3 WHERE build=?1 AND path=?2",
                params![build, path, now as i64],
            )?;
            if self.touches.len() >= MAX_ENTRIES {
                self.touches
                    .retain(|_, last| now.saturating_sub(*last) < 30_000);
            }
            if self.touches.len() < MAX_ENTRIES {
                self.touches.insert(key, now);
            }
        }
        Ok(Some(Arc::new(Page { record, files })))
    }
    fn publish(
        &mut self,
        build: &str,
        path: &str,
        record: Record,
        files: Arc<Files>,
    ) -> Result<Arc<Page>> {
        if record.bytes > self.max_bytes {
            bail!("page exceeds disk cache capacity");
        }
        let transaction = self
            .connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let previous = transaction
            .query_row(
                "SELECT record FROM pages WHERE build=?1 AND path=?2",
                params![build, path],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        transaction.execute("INSERT INTO pages(build,path,record,bytes,access) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(build,path) DO UPDATE SET record=excluded.record,bytes=excluded.bytes,access=excluded.access", params![build,path,serde_json::to_string(&record)?,record.bytes as i64,now_ms() as i64])?;
        transaction.execute(
            "DELETE FROM route_seeds WHERE build=?1 AND path=?2",
            params![build, path],
        )?;
        let mut retired = previous.into_iter().collect::<Vec<_>>();
        loop {
            let (count, bytes): (i64, i64) = transaction.query_row(
                "SELECT count(*),coalesce(sum(bytes),0) FROM pages",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if count <= self.max_entries as i64 && bytes <= self.max_bytes as i64 {
                break;
            }
            let (old_build, old_path, old_record): (String,String,String) = transaction.query_row("SELECT build,path,record FROM pages WHERE NOT(build=?1 AND path=?2) ORDER BY access,build,path LIMIT 1", params![build,path], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)))?;
            transaction.execute(
                "DELETE FROM pages WHERE build=?1 AND path=?2",
                params![old_build, old_path],
            )?;
            let evicted: Record = serde_json::from_str(&old_record)?;
            transaction.execute(
                "UPDATE page_meta SET seed_before=max(seed_before,?1) WHERE id=1",
                [now_ms().max(evicted.generated_at) as i64],
            )?;
            retired.push(old_record);
        }
        transaction.commit()?;
        files.retired.store(
            record.revalidate == Revalidate::Seconds(0),
            Ordering::Relaxed,
        );
        self.live
            .insert(record.html.clone(), Arc::downgrade(&files));
        for retired in retired {
            let old: Record = serde_json::from_str(&retired)?;
            self.files(&old)?.retired.store(true, Ordering::Relaxed);
        }
        Ok(Arc::new(Page { record, files }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(directory: &Path, name: &str) -> Arc<Files> {
        std::fs::create_dir_all(directory).unwrap();
        Arc::new(Files {
            html: directory.join(format!("{name}.html")),
            data: Some(directory.join(format!("{name}.json"))),
            retired: AtomicBool::new(true),
        })
    }
    fn record(files: &Files, revalidate: Revalidate) -> Record {
        Record {
            html: files.html.file_name().unwrap().to_str().unwrap().into(),
            data: files
                .data
                .as_ref()
                .map(|file| file.file_name().unwrap().to_str().unwrap().into()),
            generated_at: 1000,
            revalidate,
            status: 200,
            headers: BTreeMap::new(),
            bytes: 6,
            app: false,
            handler: false,
            tags: Vec::new(),
            paths: Vec::new(),
            stale_at: None,
            hard_at: None,
            cache_version: None,
        }
    }
    fn seeded(store: &mut Store, build: &str, path: &str, name: &str) -> Arc<Page> {
        let files = files(&store.directory, name);
        std::fs::write(&files.html, name).unwrap();
        std::fs::write(files.data.as_ref().unwrap(), format!("\"{name}\"")).unwrap();
        store
            .publish(build, path, record(&files, Revalidate::Never), files)
            .unwrap()
    }

    #[tokio::test]
    async fn pair_publication_is_atomic_failure_preserves_old_and_restart_is_build_scoped() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        let old = seeded(&mut store, "build-one", "/page", "first");
        let partial = files(&store.directory, "broken");
        assert!(
            write_pair(&partial, RenderedBody::Buffered(b"html{}".to_vec()), 8, 2)
                .await
                .is_err()
        );
        drop(partial);
        assert!(!store.directory.join("broken.html").exists());
        assert_eq!(
            std::fs::read_to_string(
                store
                    .get("build-one", "/page")
                    .unwrap()
                    .unwrap()
                    .file(false)
            )
            .unwrap(),
            "first"
        );
        let new = seeded(&mut store, "build-one", "/page", "second");
        // Readers holding an earlier generation retain a complete pair.
        assert_eq!(
            std::fs::read_to_string(old.file(true)).unwrap(),
            "\"first\""
        );
        let old_file = old.file(false);
        drop(old);
        assert!(!old_file.exists());
        drop(new);
        drop(store);
        let mut restarted = Store::open(directory.path()).unwrap();
        let page = restarted.get("build-one", "/page").unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(page.file(false)).unwrap(), "second");
        assert_eq!(
            std::fs::read_to_string(page.file(true)).unwrap(),
            "\"second\""
        );
        assert!(restarted.get("build-two", "/page").unwrap().is_none());
    }

    #[tokio::test]
    async fn declared_lengths_are_enforced_and_html_data_boundary_is_exact() {
        let directory = tempfile::tempdir().unwrap();
        let pair = files(directory.path(), "valid");
        write_pair(&pair, RenderedBody::Buffered(b"<p>\0\xff{}".to_vec()), 5, 2)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&pair.html).unwrap(), b"<p>\0\xff");
        assert_eq!(std::fs::read(pair.data.as_ref().unwrap()).unwrap(), b"{}");
        let extra = files(directory.path(), "extra");
        assert!(write_pair(
            &extra,
            RenderedBody::Buffered(b"html{}extra".to_vec()),
            4,
            2
        )
        .await
        .is_err());
        drop(extra);
        assert!(!directory.path().join("extra.json").exists());
    }

    #[test]
    fn ttl_headers_eviction_and_uncached_payload_lifetimes_are_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        store.max_entries = 1;
        store.max_bytes = 6;
        let first = seeded(&mut store, "one", "/a", "one");
        let second = seeded(&mut store, "two", "/b", "two");
        assert!(store.get("one", "/a").unwrap().is_none());
        assert!(first.file(false).exists());
        let old = first.file(false);
        drop(first);
        assert!(!old.exists());
        assert!(second.fresh(u64::MAX));
        assert!(!second.cache_control().contains("stale-while-revalidate"));
        let raw = files(&store.directory, "zero");
        std::fs::write(&raw.html, "html").unwrap();
        std::fs::write(raw.data.as_ref().unwrap(), "{}").unwrap();
        let zero = store
            .publish("two", "/b", record(&raw, Revalidate::Seconds(0)), raw)
            .unwrap();
        assert!(!zero.fresh(1000));
        assert!(zero.cache_control().contains("no-store"));
        let zero_file = zero.file(false);
        drop(zero);
        assert!(!zero_file.exists());
        // The persisted zero-TTL policy prevents a build seed from resurfacing;
        // its HTML and data bytes are never kept after the response.
        let policy = store.get("two", "/b").unwrap().unwrap();
        assert_eq!(policy.record.revalidate, Revalidate::Seconds(0));
        let timed = Page {
            record: Record {
                revalidate: Revalidate::Seconds(2),
                ..policy.record.clone()
            },
            files: policy.files.clone(),
        };
        assert!(timed.fresh(2999));
        assert!(!timed.fresh(3000));
        assert!(timed
            .cache_control()
            .contains("stale-while-revalidate=31535998"));
        let oversized = files(&store.directory, "large");
        let mut large = record(&oversized, Revalidate::Never);
        large.bytes = 7;
        assert!(store.publish("two", "/large", large, oversized).is_err());
        assert!(store.get("two", "/b").unwrap().is_some());
    }

    #[test]
    fn gzip_is_streamed_fresh_and_metadata_cannot_leak_cookies_or_transport_headers() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("page.html");
        std::fs::write(&file, "compressible ".repeat(20000)).unwrap();
        let size = compress(&file).unwrap();
        assert!(size > std::fs::metadata(&file).unwrap().len());
        assert_eq!(
            std::fs::metadata(&file).unwrap().modified().unwrap(),
            std::fs::metadata(gzip_name(&file))
                .unwrap()
                .modified()
                .unwrap()
        );
        let mut decoded = Vec::new();
        std::io::Read::read_to_end(
            &mut flate2::read::GzDecoder::new(std::fs::File::open(gzip_name(&file)).unwrap()),
            &mut decoded,
        )
        .unwrap();
        assert_eq!(decoded, std::fs::read(&file).unwrap());
        let headers = clean_headers(BTreeMap::from([
            ("Set-Cookie".into(), HeaderValues::Single("secret=1".into())),
            ("Content-Length".into(), HeaderValues::Single("999".into())),
            ("Location".into(), HeaderValues::Single("/target".into())),
        ]))
        .unwrap();
        assert_eq!(
            headers,
            BTreeMap::from([("location".into(), "/target".into())])
        );
        let pair = files(directory.path(), "redirect");
        let page = Page {
            record: Record {
                status: 307,
                headers,
                ..record(&pair, Revalidate::Never)
            },
            files: pair,
        };
        assert_eq!(page.metadata(false).status, 307);
        assert_eq!(page.metadata(true).status, 200);
        assert!(!page.metadata(true).headers.contains_key("location"));
    }

    fn fixture() -> (tempfile::TempDir, Arc<PageCache>, WorkerConfig, Manifest) {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("worker.mjs");
        std::fs::write(&script, r#"
          import {createInterface} from 'node:readline';
          import {appendFileSync,existsSync,readFileSync} from 'node:fs';
          const write=bytes=>new Promise((resolve,reject)=>process.stdout.write(bytes,error=>error?reject(error):resolve()));
          const frame=value=>write(JSON.stringify(value)+'\n');
          for await(const line of createInterface({input:process.stdin})) {
            const req=JSON.parse(line), id=req.id;
            appendFileSync('calls',JSON.stringify(req)+'\n');
            while(existsSync('hold')) await new Promise(resolve=>setTimeout(resolve,5));
            if(existsSync('fail')) {await frame({id,status:500,headers:{},body:''});continue;}
            const count=readFileSync('calls','utf8').trim().split('\n').length;
            const html=Buffer.from('<p>'+count+':'+req.url+'</p>'), data=Buffer.from(JSON.stringify({count,reason:req.revalidateReason}));
            const combined=Buffer.concat([html,data]);
            await frame({id,type:'head',status:200,headers:{'content-type':'text/html'},isr:{revalidate:req.url.endsWith('/zero')?0:false,htmlLength:html.length,dataLength:data.length}});
            for(let i=0;i<combined.length;i+=3){const bytes=combined.subarray(i,i+3);await frame({id,type:'chunk',length:bytes.length});await write(bytes);}
            await frame({id,type:'end'});
          }
        "#).unwrap();
        let manifest: Manifest = serde_json::from_value(serde_json::json!({"version":1,"buildId":"build-one","routes":[{"id":"page","pattern":"/[slug]","kind":"page","module":"server/page.cjs","ssg":true,"fallback":"blocking"}]})).unwrap();
        let worker = WorkerConfig {
            node: "node".into(),
            script,
            project: directory.path().into(),
            dist: directory.path().into(),
            cache: None,
        };
        let cache = PageCache::new(
            directory.path(),
            directory.path(),
            &manifest,
            worker.clone(),
        )
        .unwrap()
        .unwrap();
        (directory, cache, worker, manifest)
    }
    async fn select(cache: Arc<PageCache>, path: &str) -> Selection {
        cache
            .select(path, &decode_path(path).unwrap(), true)
            .await
            .unwrap()
            .unwrap()
    }

    #[tokio::test]
    async fn external_cache_controls_seeds_versions_misses_and_publication_races() {
        let (directory, original, worker, mut manifest) = fixture();
        drop(original);
        manifest.config.cache_handler = Some("server/handler.mjs".into());
        manifest.config.cache_max_memory_size = Some(0);
        std::fs::write(&worker.script, r#"
          import {createInterface} from 'node:readline';
          import {appendFileSync,existsSync,readFileSync,writeFileSync,unlinkSync} from 'node:fs';
          import {createHash} from 'node:crypto';
          const reply=value=>process.stdout.write(JSON.stringify(value)+'\n');
          for await(const line of createInterface({input:process.stdin})) {
            const request=JSON.parse(line), id=request.id;
            if(request.renderMode==='incremental-cache') {
              const op=JSON.parse(Buffer.from(request.body,'base64'));
              appendFileSync('operations',op.op+'\n');
              if(op.op==='get') {
                if(!existsSync('backend')) {reply({id,status:204,body:''});continue;}
                const value=JSON.parse(readFileSync('backend'));
                if(op.knownVersion===value.isr.cacheVersion) reply({id,status:304,headers:{'x-rustyx-cache-version':op.knownVersion},body:''});
                else reply({id,...value});
              } else if(op.op==='set') {
                while(existsSync('hold-set')) await new Promise(resolve=>setTimeout(resolve,5));
                const html=readFileSync(op.htmlFile),data=readFileSync(op.dataFile);
                const isr={revalidate:op.revalidate,htmlLength:html.length,dataLength:data.length,tags:op.tags,paths:op.paths,lastModified:Date.now(),cacheVersion:createHash('sha256').update(html).update(data).digest('hex')};
                writeFileSync('backend',JSON.stringify({status:op.status,headers:op.headers,isr,body:Buffer.concat([html,data]).toString('base64')}));
                reply({id,status:204,body:''});
              } else {if(existsSync('backend'))unlinkSync('backend');reply({id,status:204,body:''});}
              continue;
            }
            const count=existsSync('renders')?Number(readFileSync('renders'))+1:1;
            writeFileSync('renders',String(count));
            const html=Buffer.from('<p>'+count+'</p>'),data=Buffer.from(JSON.stringify({count}));
            reply({id,status:200,headers:{},isr:{revalidate:false,htmlLength:html.length,dataLength:data.length},body:Buffer.concat([html,data]).toString('base64')});
          }
        "#).unwrap();
        std::fs::write(directory.path().join("seed.html"), "obsolete-seed").unwrap();
        std::fs::write(directory.path().join("seed.json"), "{}").unwrap();
        manifest.prerendered.push(Prerendered {
            path: "/seed".into(),
            file: "seed.html".into(),
            data_file: Some("seed.json".into()),
            status: 200,
            headers: BTreeMap::new(),
            revalidate: Revalidate::Never,
            generated_at: 1,
            tags: Vec::new(),
            paths: Vec::new(),
        });
        let cache = PageCache::new(directory.path(), directory.path(), &manifest, worker)
            .unwrap()
            .unwrap();
        assert_eq!(select(cache.clone(), "/seed").await.state, "MISS");
        let second = select(cache.clone(), "/seed").await;
        let third = select(cache.clone(), "/seed").await;
        assert_eq!(
            second.page.file(false),
            third.page.file(false),
            "unchanged external versions reuse immutable local files"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("renders")).unwrap(),
            "1"
        );
        std::fs::remove_file(directory.path().join("backend")).unwrap();
        let fresh = select(cache.clone(), "/seed").await;
        assert_eq!(fresh.state, "MISS");
        assert_eq!(
            std::fs::read_to_string(fresh.page.file(true)).unwrap(),
            "{\"count\":2}"
        );

        std::fs::write(directory.path().join("hold-set"), "").unwrap();
        let running = tokio::spawn({
            let cache = cache.clone();
            async move { cache.revalidate("/seed", false).await }
        });
        for _ in 0..200 {
            if std::fs::read_to_string(directory.path().join("operations"))
                .unwrap()
                .lines()
                .filter(|line| *line == "set")
                .count()
                == 3
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        cache
            .invalidate_with(
                &Invalidation {
                    tags: Vec::new(),
                    paths: vec!["page:/seed".into()],
                    consumers: Vec::new(),
                    all: false,
                    stale: false,
                    expire: None,
                },
                || Ok(()),
            )
            .unwrap();
        std::fs::remove_file(directory.path().join("hold-set")).unwrap();
        assert!(running.await.unwrap().unwrap());
        assert_eq!(
            std::fs::read_to_string(directory.path().join("renders")).unwrap(),
            "4"
        );
        assert!(std::fs::read_to_string(directory.path().join("operations"))
            .unwrap()
            .contains("invalidate\n"));
        assert_eq!(
            std::fs::read_to_string(select(cache.clone(), "/seed").await.page.file(true)).unwrap(),
            "{\"count\":4}"
        );
        let guard = cache.store.lock().unwrap();
        let cache_size: i64 = guard
            .as_ref()
            .unwrap()
            .connection
            .query_row("PRAGMA cache_size", [], |row| row.get(0))
            .unwrap();
        assert_eq!(cache_size, 0);
    }

    #[tokio::test]
    async fn cold_failure_preserves_private_error_for_coalesced_readers_without_retention_or_replay(
    ) {
        let (directory, cache, worker, _) = fixture();
        let source = std::fs::read_to_string(&worker.script).unwrap().replace(
            "{id,status:500,headers:{},body:''}",
            "{id,type:'head',status:500,headers:{},pageFailure:{name:'RangeError',message:'PRIVATE_GSP_ERROR',stack:'PRIVATE_STACK',statusCode:503,code:'E_GSP'}});await frame({id,type:'end'}",
        );
        std::fs::write(&worker.script, source).unwrap();
        std::fs::write(directory.path().join("fail"), "").unwrap();
        let parts = decode_path("/broken").unwrap();
        let (first, second) = tokio::join!(
            cache.select("/broken", &parts, true),
            cache.select("/broken", &parts, true)
        );
        let first = first.err().expect("first generation fails");
        let second = second.err().expect("coalesced generation fails");
        let first_info = &first.downcast_ref::<PageGenerationError>().unwrap().0;
        let second_info = &second.downcast_ref::<PageGenerationError>().unwrap().0;
        assert!(Arc::ptr_eq(first_info, second_info));
        assert_eq!(first_info.name, "RangeError");
        assert_eq!(first_info.message, "PRIVATE_GSP_ERROR");
        assert_eq!(first_info.status_code, Some(503));
        assert_eq!(first_info.code, Some(serde_json::json!("E_GSP")));
        assert!(cache.lookup("/broken").await.unwrap().is_none());
        assert_eq!(
            std::fs::read_to_string(directory.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        let weak = Arc::downgrade(first_info);
        drop(first);
        drop(second);
        assert!(
            weak.upgrade().is_none(),
            "completed failures retain no error summary"
        );
        std::fs::remove_file(directory.path().join("fail")).unwrap();
        assert_eq!(select(cache, "/broken").await.state, "MISS");
        assert_eq!(
            std::fs::read_to_string(directory.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn document_request_belongs_to_first_generation_only_and_is_bounded_after_cache_lookup() {
        let (directory, cache, _, _) = fixture();
        let uri: axum::http::Uri = "/one?injected=rule".parse().unwrap();
        let method = axum::http::Method::GET;
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("cookie", "visitor=first".parse().unwrap());
        let original = "/docs/alias/one?visible=private";
        let source = DocumentRequestSource {
            uri: &uri,
            method: &method,
            headers: &headers,
            original_url: Some(original),
        };
        let (route, params) = cache.route("/one", &decode_path("/one").unwrap()).unwrap();
        let first = cache
            .begin_request(
                "/one",
                route.clone(),
                params.clone(),
                "stale",
                true,
                GenerationRequest {
                    method: "GET",
                    document: Some(source),
                },
            )
            .unwrap();
        let second_headers = axum::http::HeaderMap::from_iter([(
            "cookie".parse().unwrap(),
            "visitor=second".parse().unwrap(),
        )]);
        let second = cache
            .begin_request(
                "/one",
                route,
                params,
                "stale",
                true,
                GenerationRequest {
                    method: "GET",
                    document: Some(DocumentRequestSource {
                        headers: &second_headers,
                        ..source
                    }),
                },
            )
            .unwrap();
        let (first, second) = tokio::join!(wait(first), wait(second));
        assert!(Arc::ptr_eq(&first.unwrap(), &second.unwrap()));
        let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
        assert_eq!(calls.lines().count(), 1);
        let first: serde_json::Value = serde_json::from_str(calls.lines().next().unwrap()).unwrap();
        assert_eq!(first["url"], "http://rustyx.local/one");
        assert_eq!(first["headers"], serde_json::json!({}));
        assert_eq!(first["documentRequest"]["url"], "/one?injected=rule");
        assert_eq!(first["documentRequest"]["originalUrl"], original);
        assert_eq!(
            first["documentRequest"]["headers"]["cookie"],
            "visitor=first"
        );
        let mut huge = axum::http::HeaderMap::new();
        huge.insert("x-huge", "x".repeat(64 * 1024).parse().unwrap());
        let source = DocumentRequestSource {
            headers: &huge,
            ..source
        };
        let hit = cache
            .select_request(
                "/one",
                &decode_path("/one").unwrap(),
                true,
                "GET",
                Some(source),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(hit.state, "HIT");
        let failure = cache
            .select_request(
                "/other",
                &decode_path("/other").unwrap(),
                true,
                "GET",
                Some(source),
            )
            .await
            .err()
            .unwrap();
        assert!(failure.is::<crate::pool::DocumentRequestTooLarge>());
        assert_eq!(cache.slots.available_permits(), GENERATIONS);
        cache.revalidate("/one", false).await.unwrap();
        let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
        assert_eq!(calls.lines().count(), 2);
        let next: serde_json::Value = serde_json::from_str(calls.lines().last().unwrap()).unwrap();
        assert!(next.get("documentRequest").is_none());
    }

    #[tokio::test]
    async fn artifact_namespace_changes_even_when_public_build_id_is_constant() {
        let (directory, original, worker, mut manifest) = fixture();
        drop(original);
        manifest.cache_id = Some("artifact-one".into());
        let first = PageCache::new(
            directory.path(),
            directory.path(),
            &manifest,
            worker.clone(),
        )
        .unwrap()
        .unwrap();
        let selected = select(first.clone(), "/same").await;
        assert_eq!(selected.state, "MISS");
        let first_file = selected.page.file(true);
        drop(selected);
        drop(first);
        let restart = PageCache::new(
            directory.path(),
            directory.path(),
            &manifest,
            worker.clone(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            select(restart.clone(), "/same").await.page.file(true),
            first_file
        );
        drop(restart);
        manifest.cache_id = Some("artifact-two".into());
        let second = PageCache::new(directory.path(), directory.path(), &manifest, worker)
            .unwrap()
            .unwrap();
        assert_eq!(second.build_id(), "build-one");
        let selected = select(second, "/same").await;
        assert_eq!(selected.state, "MISS");
        assert_ne!(selected.page.file(true), first_file);
        assert!(std::fs::read_to_string(selected.page.file(true))
            .unwrap()
            .contains("\"count\":2"));
    }

    #[tokio::test]
    async fn cold_fills_coalesce_and_failed_on_demand_keeps_last_good_without_replay() {
        let (directory, cache, worker, manifest) = fixture();
        std::fs::write(directory.path().join("hold"), "").unwrap();
        let mut tasks = Vec::new();
        for _ in 0..8 {
            let cache = cache.clone();
            tasks.push(tokio::spawn(async move { select(cache, "/same").await }));
        }
        for _ in 0..200 {
            if directory.path().join("calls").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(directory.path().join("calls").exists());
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(
            std::fs::read_to_string(directory.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        std::fs::remove_file(directory.path().join("hold")).unwrap();
        for task in tasks {
            let selected = task.await.unwrap();
            assert!(std::fs::read_to_string(selected.page.file(true))
                .unwrap()
                .contains("\"count\":1"));
        }
        assert_eq!(select(cache.clone(), "/same").await.state, "HIT");
        std::fs::write(directory.path().join("fail"), "").unwrap();
        assert!(cache.revalidate("/same", false).await.is_err());
        assert!(
            std::fs::read_to_string(select(cache.clone(), "/same").await.page.file(true))
                .unwrap()
                .contains("\"count\":1")
        );
        std::fs::remove_file(directory.path().join("fail")).unwrap();
        assert!(cache.revalidate("/same", false).await.unwrap());
        let fresh = select(cache.clone(), "/same").await;
        assert!(std::fs::read_to_string(fresh.page.file(true))
            .unwrap()
            .contains("on-demand"));
        let reopened = PageCache::new(directory.path(), directory.path(), &manifest, worker)
            .unwrap()
            .unwrap();
        assert_eq!(select(reopened, "/same").await.state, "HIT");
        let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
        assert_eq!(calls.lines().count(), 3);
        for line in calls.lines() {
            let call: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(call["headers"], serde_json::json!({}));
            assert_eq!(call["method"], "GET");
            assert_eq!(call["renderMode"], "isr");
        }
    }

    #[tokio::test]
    async fn zero_ttl_and_dev_recompute_and_only_generated_skips_unknown_paths() {
        let (directory, cache, worker, mut manifest) = fixture();
        let first = select(cache.clone(), "/zero").await;
        let first_file = first.page.file(false);
        drop(first);
        let second = select(cache.clone(), "/zero").await;
        assert!(std::fs::read_to_string(second.page.file(true))
            .unwrap()
            .contains("\"count\":2"));
        assert!(!first_file.exists());
        assert!(!cache.revalidate("/unknown", true).await.unwrap());
        assert!(cache.revalidate("/x?q=private", false).await.is_err());
        manifest.dev = true;
        manifest.routes[0].fallback = Some(serde_json::Value::Bool(false));
        let dev = PageCache::new(directory.path(), directory.path(), &manifest, worker)
            .unwrap()
            .unwrap();
        let one = select(dev.clone(), "/unseeded").await;
        let two = select(dev, "/unseeded").await;
        assert_ne!(
            std::fs::read(one.page.file(true)).unwrap(),
            std::fs::read(two.page.file(true)).unwrap()
        );
        assert!(two.page.cache_control().contains("no-store"));
    }

    #[tokio::test]
    async fn eviction_and_missing_runtime_files_never_revive_an_obsolete_build_seed() {
        let (directory, original, worker, mut manifest) = fixture();
        drop(original);
        let dist = std::fs::canonicalize(directory.path()).unwrap();
        std::fs::write(directory.path().join("seed.html"), "original build seed").unwrap();
        std::fs::write(directory.path().join("seed.json"), r#"{"count":0}"#).unwrap();
        manifest.routes[0].fallback = Some(serde_json::Value::Bool(false));
        manifest.prerendered.push(Prerendered {
            path: "/seed".into(),
            file: "seed.html".into(),
            data_file: Some("seed.json".into()),
            status: 200,
            headers: BTreeMap::new(),
            revalidate: Revalidate::Never,
            generated_at: 1,
            tags: Vec::new(),
            paths: Vec::new(),
        });
        let cache = PageCache::new(directory.path(), &dist, &manifest, worker.clone())
            .unwrap()
            .unwrap();
        assert_eq!(select(cache.clone(), "/seed").await.state, "HIT");
        cache.revalidate("/seed", false).await.unwrap();
        assert!(
            std::fs::read_to_string(select(cache.clone(), "/seed").await.page.file(true))
                .unwrap()
                .contains("\"count\":1")
        );
        {
            let mut guard = cache.store.lock().unwrap();
            let store = guard.as_mut().unwrap();
            store.max_entries = 1;
            seeded(store, "build-one", "/other", "other");
            assert!(store.get("build-one", "/seed").unwrap().is_none());
            assert!(store.seed_watermark().unwrap() > 0);
        }
        let restarted = PageCache::new(directory.path(), directory.path(), &manifest, worker)
            .unwrap()
            .unwrap();
        let regenerated = select(restarted.clone(), "/seed").await;
        assert_eq!(regenerated.state, "MISS");
        assert!(std::fs::read_to_string(regenerated.page.file(true))
            .unwrap()
            .contains("\"count\":2"));
        std::fs::remove_file(regenerated.page.file(false)).unwrap();
        drop(regenerated);
        let repaired = select(restarted, "/seed").await;
        assert_eq!(repaired.state, "MISS");
        assert!(std::fs::read_to_string(repaired.page.file(true))
            .unwrap()
            .contains("\"count\":3"));
    }

    #[tokio::test]
    async fn data_and_revalidation_respect_non_ssg_and_api_route_precedence() {
        let (directory, original, worker, mut manifest) = fixture();
        drop(original);
        for (path, kind, router) in [
            ("/account", crate::manifest::RouteKind::Page, None),
            ("/api", crate::manifest::RouteKind::Api, None),
            (
                "/app",
                crate::manifest::RouteKind::Page,
                Some("app".to_owned()),
            ),
        ] {
            manifest.routes.push(Route {
                id: path.into(),
                pattern: path.into(),
                kind,
                module: "server/other.cjs".into(),
                router,
                fallback: None,
                ssg: false,
                fallback_file: None,
                allowed_paths: None,
                dynamic_paths: None,
                cache_config: None,
                internal: false,
                error_status: None,
            });
        }
        let cache = PageCache::new(directory.path(), directory.path(), &manifest, worker)
            .unwrap()
            .unwrap();
        for path in ["/account", "/api", "/app"] {
            assert!(cache
                .select(path, &decode_path(path).unwrap(), true)
                .await
                .unwrap()
                .is_none());
            assert!(cache.revalidate(path, false).await.is_err());
            assert!(!cache.revalidate(path, true).await.unwrap());
        }
        assert!(!directory.path().join("calls").exists());
        assert_eq!(select(cache, "/ordinary").await.state, "MISS");
    }

    fn handler_fixture() -> (tempfile::TempDir, Arc<PageCache>, WorkerConfig, Manifest) {
        let (directory, original, worker, mut manifest) = fixture();
        drop(original);
        manifest.routes[0].kind = crate::manifest::RouteKind::Api;
        manifest.routes[0].router = Some("app".into());
        std::fs::write(&worker.script,r#"
            import {createInterface} from 'node:readline';
            import {appendFileSync,readFileSync,existsSync} from 'node:fs';
            const write=bytes=>new Promise((resolve,reject)=>process.stdout.write(bytes,error=>error?reject(error):resolve()));
            const frame=value=>write(JSON.stringify(value)+'\n');
            for await(const line of createInterface({input:process.stdin})) {
                const req=JSON.parse(line),id=req.id;
                appendFileSync('calls',JSON.stringify(req)+'\n');
                while(existsSync('hold')) await new Promise(resolve=>setTimeout(resolve,5));
                if(existsSync('fail')) {await frame({id,status:500,headers:{},body:''});continue;}
                if(existsSync('dynamic')) {await frame({id,status:200,headers:{},body:'',isr:{kind:'route',dynamic:true,revalidate:0,htmlLength:0,dataLength:0}});continue;}
                const count=readFileSync('calls','utf8').trim().split('\n').length;
                const body=req.method==='HEAD'?Buffer.alloc(0):Buffer.from([0,255,128,count,13,10]);
                await frame({id,type:'head',status:req.url.endsWith('/returned-error')?500:req.method==='HEAD'?202:201,headers:{'content-type':'application/octet-stream','cache-control':'private, no-store','set-cookie':['cached='+count,'second=yes'],'connection':'x-private','x-private':'never-forward','content-length':'999'},isr:{kind:'route',revalidate:false,htmlLength:body.length,dataLength:0,tags:['handler'],paths:['page:'+new URL(req.url).pathname,'layout:/']}});
                if(body.length) {await frame({id,type:'chunk',length:body.length});await write(body);}
                await frame({id,type:'end'});
            }
        "#).unwrap();
        let cache = PageCache::new(
            directory.path(),
            directory.path(),
            &manifest,
            worker.clone(),
        )
        .unwrap()
        .unwrap();
        (directory, cache, worker, manifest)
    }
    #[tokio::test]
    async fn handler_binary_headers_persist_without_dummy_data_and_invalidate_atomically() {
        let (directory, cache, worker, manifest) = handler_fixture();
        let selected = select(cache.clone(), "/binary").await;
        assert_eq!(selected.state, "MISS");
        assert!(selected.page.is_handler());
        assert_eq!(
            std::fs::read(selected.page.file(false)).unwrap(),
            [0, 255, 128, 1, 13, 10]
        );
        assert!(selected.page.files.data.is_none());
        assert!(selected.page.record.data.is_none());
        assert_eq!(
            selected.page.handler_headers()["set-cookie"].values(),
            ["cached=1", "second=yes"]
        );
        assert_eq!(
            selected.page.handler_headers()["cache-control"].first(),
            Some("private, no-store")
        );
        for header in ["connection", "x-private", "content-length"] {
            assert!(!selected.page.handler_headers().contains_key(header));
        }
        assert_eq!(select(cache.clone(), "/binary").await.state, "HIT");
        let initial_file = selected.page.file(false);
        drop(selected);
        drop(cache);
        let restarted = PageCache::new(directory.path(), directory.path(), &manifest, worker)
            .unwrap()
            .unwrap();
        let selected = select(restarted.clone(), "/binary").await;
        assert_eq!(selected.page.file(false), initial_file);
        restarted
            .invalidate_with(&invalidation(&["handler"], &[], false), || Ok(()))
            .unwrap();
        let replacement = select(restarted.clone(), "/binary").await;
        assert_eq!(replacement.state, "MISS");
        assert_eq!(
            std::fs::read(replacement.page.file(false)).unwrap(),
            [0, 255, 128, 2, 13, 10]
        );
        assert_ne!(replacement.page.file(false), selected.page.file(false));
        assert!(
            selected.page.file(false).exists(),
            "previous response still holds its generation"
        );
        std::fs::write(directory.path().join("fail"), "").unwrap();
        assert!(restarted.revalidate("/binary", false).await.is_err());
        assert_eq!(
            select(restarted, "/binary").await.page.file(false),
            replacement.page.file(false)
        );
        let calls = std::fs::read_to_string(directory.path().join("calls")).unwrap();
        let first: serde_json::Value = serde_json::from_str(calls.lines().next().unwrap()).unwrap();
        assert_eq!(first["method"], "GET");
        assert_eq!(first["url"], "http://rustyx.local/binary");
        assert_eq!(first["headers"], serde_json::json!({}));
    }
    #[tokio::test]
    async fn handler_head_and_get_share_one_generation_using_the_cold_trigger_method() {
        let (directory, cache, _, _) = handler_fixture();
        let head = cache
            .select_method("/head", &["head".into()], true, "HEAD")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(head.page.handler_status(), 202);
        assert!(std::fs::read(head.page.file(false)).unwrap().is_empty());
        let later_get = select(cache.clone(), "/head").await;
        assert_eq!(later_get.state, "HIT");
        assert_eq!(later_get.page.handler_status(), 202);
        assert_eq!(later_get.page.file(false), head.page.file(false));
        let get = select(cache.clone(), "/get").await;
        assert_eq!(get.page.handler_status(), 201);
        assert!(!std::fs::read(get.page.file(false)).unwrap().is_empty());
        let later_head = cache
            .select_method("/get", &["get".into()], true, "HEAD")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(later_head.state, "HIT");
        assert_eq!(later_head.page.handler_status(), 201);
        assert_eq!(later_head.page.file(false), get.page.file(false));
        assert_eq!(
            std::fs::read_to_string(directory.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            2
        );
    }
    #[tokio::test]
    async fn dynamic_handler_fallback_keeps_existing_generations_without_caching_unknown_paths() {
        let (directory, original, worker, mut manifest) = handler_fixture();
        let persisted = select(original.clone(), "/persisted")
            .await
            .page
            .file(false);
        drop(original);
        let dist = std::fs::canonicalize(directory.path()).unwrap();
        std::fs::write(dist.join("seed.body"), [0, 255, 42]).unwrap();
        manifest.routes[0].fallback = Some(serde_json::json!("dynamic"));
        manifest.routes[0].dynamic_paths = Some(HashSet::from(["/bad".into()]));
        manifest.prerendered.push(Prerendered {
            path: "/seed".into(),
            file: "seed.body".into(),
            data_file: None,
            status: 201,
            headers: BTreeMap::new(),
            revalidate: Revalidate::Never,
            generated_at: now_ms(),
            tags: vec!["seed".into()],
            paths: vec!["page:/seed".into()],
        });
        let cache = PageCache::new(directory.path(), &dist, &manifest, worker)
            .unwrap()
            .unwrap();
        assert_eq!(select(cache.clone(), "/seed").await.state, "HIT");
        assert_eq!(
            select(cache.clone(), "/persisted").await.page.file(false),
            persisted
        );
        for path in ["/bad", "/unknown"] {
            let error = cache
                .select(path, &decode_path(path).unwrap(), true)
                .await
                .err()
                .unwrap();
            assert!(error.is::<PageDynamic>());
            assert!(!cache.revalidate(path, true).await.unwrap());
            assert!(cache.revalidate(path, false).await.is_err());
        }
        assert_eq!(
            std::fs::read_to_string(directory.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        cache
            .invalidate_with(&invalidation(&["seed"], &[], false), || Ok(()))
            .unwrap();
        let regenerated = select(cache.clone(), "/seed").await;
        assert_eq!(regenerated.state, "MISS");
        assert_eq!(
            std::fs::read(regenerated.page.file(false)).unwrap(),
            [0, 255, 128, 2, 13, 10]
        );
        assert!(cache.revalidate("/seed", true).await.unwrap());
        let selected = select(cache.clone(), "/seed").await;
        std::fs::remove_file(selected.page.file(false)).unwrap();
        drop(selected);
        assert!(cache.lookup("/seed").await.unwrap().is_none());
        assert!(cache.revalidate("/seed", true).await.unwrap());
        assert_eq!(
            std::fs::read(select(cache.clone(), "/seed").await.page.file(false)).unwrap(),
            [0, 255, 128, 4, 13, 10]
        );

        for app in [false, true] {
            let (directory, original, worker, mut manifest) =
                if app { app_fixture() } else { fixture() };
            drop(original);
            manifest.routes[0].fallback = Some(serde_json::json!("dynamic"));
            let cache = PageCache::new(directory.path(), directory.path(), &manifest, worker)
                .unwrap()
                .unwrap();
            assert!(cache.revalidate("/on-demand", false).await.unwrap());
            assert_eq!(select(cache, "/unknown").await.state, "MISS");
        }
    }
    #[tokio::test]
    async fn runtime_handler_responses_cache_returned_errors_while_thrown_failures_do_not_publish()
    {
        let (directory, cache, _, _) = handler_fixture();
        let first = select(cache.clone(), "/returned-error").await;
        assert_eq!(first.page.handler_status(), 500);
        assert_eq!(select(cache.clone(), "/returned-error").await.state, "HIT");
        std::fs::write(directory.path().join("fail"), "").unwrap();
        assert!(cache.revalidate("/returned-error", false).await.is_err());
        assert_eq!(
            select(cache, "/returned-error").await.page.file(false),
            first.page.file(false)
        );
    }

    #[test]
    fn handler_headers_preserve_encoded_bytes_and_cookies_but_drop_connection_fields() {
        let headers = clean_handler_headers(BTreeMap::from([
            ("Content-Encoding".into(), "gzip".into()),
            ("Cache-Control".into(), "private, no-store".into()),
            (
                "Set-Cookie".into(),
                HeaderValues::Multiple(vec!["a=1".into(), "b=2".into()]),
            ),
            ("Connection".into(), "X-Internal, keep-alive".into()),
            ("X-Internal".into(), "private".into()),
        ]))
        .unwrap();
        assert_eq!(headers["content-encoding"].first(), Some("gzip"));
        assert_eq!(headers["set-cookie"].values().len(), 2);
        assert!(!headers.contains_key("connection"));
        assert!(!headers.contains_key("x-internal"));
    }

    fn app_fixture() -> (tempfile::TempDir, Arc<PageCache>, WorkerConfig, Manifest) {
        let (directory, cache, worker, mut manifest) = fixture();
        drop(cache);
        manifest.routes[0].router = Some("app".into());
        let source=std::fs::read_to_string(&worker.script).unwrap()
            .replace("if(existsSync('fail'))", "if(existsSync('dynamic')) {await frame({id,status:200,headers:{},body:'',isr:{dynamic:true,revalidate:0,htmlLength:0,dataLength:0}});continue;} if(existsSync('fail'))")
            .replace("dataLength:data.length", "dataLength:data.length,tags:['products'],paths:['page:'+new URL(req.url).pathname,'layout:/']");
        std::fs::write(&worker.script, source).unwrap();
        let cache = PageCache::new(
            directory.path(),
            directory.path(),
            &manifest,
            worker.clone(),
        )
        .unwrap()
        .unwrap();
        (directory, cache, worker, manifest)
    }
    fn invalidation(tags: &[&str], paths: &[&str], stale: bool) -> Invalidation {
        Invalidation {
            tags: tags.iter().map(|value| (*value).into()).collect(),
            paths: paths.iter().map(|value| (*value).into()).collect(),
            consumers: Vec::new(),
            all: false,
            stale,
            expire: None,
        }
    }
    async fn calls(directory: &Path, count: usize) {
        for _ in 0..300 {
            if std::fs::read_to_string(directory.join("calls"))
                .unwrap_or_default()
                .lines()
                .count()
                >= count
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("maintenance call did not start");
    }

    #[test]
    fn route_invalidation_preserves_unrelated_pages_and_persists_seed_deadlines() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        for (path, app, tags) in [
            ("a", true, vec!["products".to_owned()]),
            ("b", true, vec![]),
            ("c", true, vec![]),
            ("pages", false, vec!["products".to_owned()]),
        ] {
            let files = files(&store.directory, path);
            std::fs::write(&files.html, "html").unwrap();
            std::fs::write(files.data.as_ref().unwrap(), "data").unwrap();
            let mut record = record(&files, Revalidate::Never);
            record.app = app;
            record.tags = tags;
            record.paths = vec![format!("page:/{path}"), "layout:/".into()];
            store
                .publish("build", &format!("/{path}"), record, files)
                .unwrap();
        }
        let revision = store.revision().unwrap();
        let mut invalid = invalidation(&["products"], &[], true);
        invalid.consumers.push("page:/b".into());
        store
            .invalidate("build", &invalid, &["/seed".into()])
            .unwrap();
        assert!(store.revision().unwrap() > revision);
        for path in ["/a", "/b"] {
            let page = store.get("build", path).unwrap().unwrap();
            assert!(!page.fresh(now_ms()));
            assert!(page.record.hard_at.is_none());
        }
        for path in ["/c", "/pages"] {
            assert!(store.get("build", path).unwrap().unwrap().fresh(now_ms()));
        }
        invalid.expire = Some(1);
        store
            .invalidate("build", &invalid, &["/seed".into()])
            .unwrap();
        let seed = store.seed_state("build", "/seed").unwrap();
        assert!(seed.hard_at.is_some());
        let deadline = seed.hard_at;
        drop(store);
        let mut store = Store::open(directory.path()).unwrap();
        assert_eq!(
            store.seed_state("build", "/seed").unwrap().hard_at,
            deadline
        );
        assert!(store
            .get("build", "/a")
            .unwrap()
            .unwrap()
            .file(false)
            .exists());
        assert!(store
            .seed_state("other-build", "/seed")
            .unwrap()
            .hard_at
            .is_none());
    }

    #[tokio::test]
    async fn tagged_build_seeds_expire_then_publish_one_new_html_flight_pair() {
        let (directory, original, worker, mut manifest) = app_fixture();
        drop(original);
        let dist = std::fs::canonicalize(directory.path()).unwrap();
        std::fs::write(dist.join("seed.html"), "build html").unwrap();
        std::fs::write(dist.join("seed.rsc"), "build Flight").unwrap();
        manifest.prerendered.push(Prerendered {
            path: "/seed".into(),
            file: "seed.html".into(),
            data_file: Some("seed.rsc".into()),
            status: 200,
            headers: BTreeMap::new(),
            revalidate: Revalidate::Never,
            generated_at: 1,
            tags: vec!["products".into()],
            paths: vec!["page:/seed".into(), "layout:/".into()],
        });
        let cache = PageCache::new(directory.path(), &dist, &manifest, worker)
            .unwrap()
            .unwrap();
        assert_eq!(select(cache.clone(), "/seed").await.state, "HIT");
        cache
            .invalidate_with(&invalidation(&["products"], &[], false), || Ok(()))
            .unwrap();
        let next = select(cache.clone(), "/seed").await;
        assert_eq!(next.state, "MISS");
        assert!(next.page.is_app());
        assert_eq!(
            next.page.metadata(true).headers["content-type"],
            "text/x-component; charset=utf-8".into()
        );
        assert_ne!(
            next.page.metadata(false).headers["etag"],
            next.page.metadata(true).headers["etag"]
        );
        assert!(std::fs::read_to_string(next.page.file(true))
            .unwrap()
            .contains("count"));
        std::fs::write(directory.path().join("hold"), "").unwrap();
        cache
            .invalidate_with(&invalidation(&[], &["page:/seed"], true), || Ok(()))
            .unwrap();
        let stale = select(cache.clone(), "/seed").await;
        assert_eq!(stale.state, "STALE");
        calls(directory.path(), 2).await;
        assert_eq!(
            std::fs::read_to_string(stale.page.file(true)).unwrap(),
            std::fs::read_to_string(next.page.file(true)).unwrap()
        );
        std::fs::remove_file(directory.path().join("hold")).unwrap();
        let flight = cache.flights.lock().unwrap().get("/seed").cloned().unwrap();
        wait(flight).await.unwrap();
        assert_eq!(select(cache, "/seed").await.state, "HIT");
    }

    #[tokio::test]
    async fn cache_invalidation_during_static_render_fences_publication_and_retries_once() {
        let (directory, cache, _, _) = app_fixture();
        std::fs::write(directory.path().join("hold"), "").unwrap();
        let pending = tokio::spawn({
            let cache = cache.clone();
            async move { select(cache, "/race").await }
        });
        calls(directory.path(), 1).await;
        cache
            .invalidate_with(&invalidation(&["products"], &[], false), || Ok(()))
            .unwrap();
        std::fs::remove_file(directory.path().join("hold")).unwrap();
        let result = pending.await.unwrap();
        assert!(std::fs::read_to_string(result.page.file(true))
            .unwrap()
            .contains("\"count\":2"));
        assert_eq!(
            std::fs::read_to_string(directory.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            2
        );
        assert_eq!(select(cache, "/race").await.state, "HIT");
    }

    #[tokio::test]
    async fn automatic_bailouts_skip_repeated_probes_but_static_regressions_keep_last_good() {
        let (directory, cache, _, _) = app_fixture();
        std::fs::write(directory.path().join("dynamic"), "").unwrap();
        for _ in 0..2 {
            assert!(cache
                .select("/dynamic", &["dynamic".into()], true)
                .await
                .err()
                .unwrap()
                .is::<PageDynamic>());
        }
        assert_eq!(
            std::fs::read_to_string(directory.path().join("calls"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        std::fs::remove_file(directory.path().join("dynamic")).unwrap();
        let good = select(cache.clone(), "/stable").await;
        let bytes = std::fs::read(good.page.file(true)).unwrap();
        std::fs::write(directory.path().join("dynamic"), "").unwrap();
        assert!(cache.revalidate("/stable", false).await.is_err());
        let after = select(cache, "/stable").await;
        assert_eq!(after.state, "HIT");
        assert_eq!(std::fs::read(after.page.file(true)).unwrap(), bytes);
    }

    #[tokio::test]
    async fn allowed_paths_and_known_dynamic_paths_apply_before_static_generation() {
        let (directory, cache, worker, mut manifest) = app_fixture();
        drop(cache);
        manifest.routes[0].allowed_paths =
            Some(HashSet::from(["/allowed".into(), "/known".into()]));
        manifest.routes[0].dynamic_paths = Some(HashSet::from(["/known".into()]));
        let cache = PageCache::new(directory.path(), directory.path(), &manifest, worker)
            .unwrap()
            .unwrap();
        assert!(cache
            .select("/denied", &["denied".into()], true)
            .await
            .unwrap()
            .is_none());
        assert!(cache
            .select("/known", &["known".into()], true)
            .await
            .err()
            .unwrap()
            .is::<PageDynamic>());
        assert!(!directory.path().join("calls").exists());
        assert_eq!(select(cache, "/allowed").await.state, "MISS");
        let route:Route=serde_json::from_value(serde_json::json!({"id":"a","pattern":"/[slug]","kind":"page","module":"server/a.cjs","allowedPaths":["/caf%C3%A9"]})).unwrap();
        assert!(route.allows("/café"));
        assert!(!route.allows("/cafe"));
    }
    #[test]
    fn embedded_nul_and_empty_route_tags_are_exact_invalidation_tokens() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::open(directory.path()).unwrap();
        for (name, tag) in [
            ("a", "tag\0a"),
            ("b", "tag\0b"),
            ("prefix", "tag"),
            ("empty", ""),
        ] {
            let files = files(&store.directory, name);
            std::fs::write(&files.html, "html").unwrap();
            std::fs::write(files.data.as_ref().unwrap(), "data").unwrap();
            let mut record = record(&files, Revalidate::Never);
            record.app = true;
            record.tags = vec![tag.into()];
            store
                .publish("build", &format!("/{name}"), record, files)
                .unwrap();
        }
        store
            .invalidate("build", &invalidation(&["tag\0a"], &[], false), &[])
            .unwrap();
        assert!(!store.get("build", "/a").unwrap().unwrap().fresh(now_ms()));
        for path in ["/b", "/prefix", "/empty"] {
            assert!(
                store.get("build", path).unwrap().unwrap().fresh(now_ms()),
                "unrelated tag invalidated: {path}"
            );
        }
        store
            .invalidate("build", &invalidation(&["tag", ""], &[], false), &[])
            .unwrap();
        assert!(store.get("build", "/b").unwrap().unwrap().fresh(now_ms()));
        for path in ["/prefix", "/empty"] {
            assert!(!store.get("build", path).unwrap().unwrap().fresh(now_ms()));
        }
    }
    #[tokio::test]
    async fn timed_out_generation_retains_blocking_admission_and_cannot_publish_late() {
        let (directory, mut cache, _, _) = fixture();
        Arc::get_mut(&mut cache).unwrap().generation_timeout = Duration::from_secs(1);
        select(cache.clone(), "/warm").await;
        let (locked, ready) = tokio::sync::oneshot::channel();
        let (release, unblock) = std::sync::mpsc::channel();
        let blocker = std::thread::spawn({
            let cache = cache.clone();
            move || {
                let guard = cache.store.lock().unwrap();
                locked.send(()).unwrap();
                unblock.recv().unwrap();
                drop(guard);
            }
        });
        ready.await.unwrap();
        let (route, params) = cache.route("/late", &["late".into()]).unwrap();
        let flight = cache.begin("/late", route, params, "stale", true).unwrap();
        calls(directory.path(), 2).await;
        assert!(wait(flight).await.is_err());
        assert_eq!(
            cache.slots.available_permits(),
            GENERATIONS - 1,
            "blocking publication must retain its admission after async timeout"
        );
        let others = cache
            .slots
            .clone()
            .acquire_many_owned((GENERATIONS - 1) as u32)
            .await
            .unwrap();
        let (route, params) = cache.route("/overflow", &["overflow".into()]).unwrap();
        assert!(cache
            .begin("/overflow", route, params, "stale", true)
            .err()
            .unwrap()
            .is::<PageBusy>());
        release.send(()).unwrap();
        tokio::task::spawn_blocking(move || blocker.join().unwrap())
            .await
            .unwrap();
        drop(others);
        for _ in 0..200 {
            if cache.slots.available_permits() == GENERATIONS {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(cache.slots.available_permits(), GENERATIONS);
        assert!(cache.stored("/late").await.unwrap().0.is_none());
        assert_eq!(select(cache, "/warm").await.state, "HIT");
    }
}
