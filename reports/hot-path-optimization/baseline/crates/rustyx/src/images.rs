//! Bounded, disk-backed image optimization. Cached hits never start JavaScript.
use anyhow::{anyhow, bail, Result};
use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderMap, Response, StatusCode},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Cursor,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::AsyncReadExt,
    sync::{OwnedSemaphorePermit, Semaphore},
};

const MAX_PIXELS: u64 = 40_000_000;
const MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ENTRIES: u64 = 4096;
const TIMEOUT: Duration = Duration::from_secs(30);
#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ImageConfig {
    pub device_sizes: Vec<u32>,
    pub image_sizes: Vec<u32>,
    pub qualities: Vec<u8>,
    pub formats: Vec<String>,
    pub path: String,
    pub unoptimized: bool,
    pub loader: String,
    #[serde(rename = "minimumCacheTTL")]
    pub minimum_cache_ttl: u64,
    pub maximum_disk_cache_size: u64,
    pub maximum_redirects: usize,
    pub maximum_response_body: usize,
    #[serde(rename = "dangerouslyAllowLocalIP")]
    pub dangerously_allow_local_ip: bool,
    #[serde(rename = "dangerouslyAllowSVG")]
    pub dangerously_allow_svg: bool,
    pub content_security_policy: String,
    pub content_disposition_type: String,
    pub domains: Vec<String>,
    pub remote_patterns: Vec<Pattern>,
    pub local_patterns: Option<Vec<Pattern>>,
}
impl Default for ImageConfig {
    fn default() -> Self {
        Self {
            device_sizes: vec![640, 750, 828, 1080, 1200, 1920, 2048, 3840],
            image_sizes: vec![32, 48, 64, 96, 128, 256, 384],
            qualities: vec![75],
            formats: vec!["image/webp".into()],
            path: "/_rustyx/image".into(),
            unoptimized: false,
            loader: "default".into(),
            minimum_cache_ttl: 14400,
            maximum_disk_cache_size: 256 * 1024 * 1024,
            maximum_redirects: 3,
            maximum_response_body: 50_000_000,
            dangerously_allow_local_ip: false,
            dangerously_allow_svg: false,
            content_security_policy: "script-src 'none'; frame-src 'none'; sandbox;".into(),
            content_disposition_type: "attachment".into(),
            domains: vec![],
            remote_patterns: vec![],
            local_patterns: None,
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Pattern {
    pub protocol: Option<String>,
    pub hostname: Option<String>,
    pub port: Option<String>,
    pub pathname: Option<String>,
    pub search: Option<String>,
}
fn glob(pattern: &str, value: &str, separator: u8) -> bool {
    if separator == b'/' && pattern.strip_suffix("/**") == Some(value) {
        return true;
    }
    let p = pattern.as_bytes();
    let v = value.as_bytes();
    let mut row = vec![false; v.len() + 1];
    row[0] = true;
    let mut i = 0;
    while i < p.len() {
        let mut next = vec![false; v.len() + 1];
        if p[i] == b'*' {
            let any = p.get(i + 1) == Some(&b'*');
            if any {
                i += 1;
            }
            next[0] = row[0];
            for j in 1..=v.len() {
                next[j] = row[j] || next[j - 1] && (any || v[j - 1] != separator);
            }
        } else {
            for j in 1..=v.len() {
                next[j] = row[j - 1] && p[i] == v[j - 1];
            }
        }
        row = next;
        i += 1;
    }
    row[v.len()]
}
impl Pattern {
    fn matches(&self, url: &reqwest::Url, remote: bool) -> bool {
        (!remote || self.protocol.as_ref().is_none_or(|p| p == url.scheme()))
            && (!remote
                || self
                    .hostname
                    .as_ref()
                    .is_some_and(|p| glob(p, url.host_str().unwrap_or(""), b'.')))
            && (!remote
                || self
                    .port
                    .as_ref()
                    .is_none_or(|p| *p == url.port().map(|p| p.to_string()).unwrap_or_default()))
            && self
                .pathname
                .as_ref()
                .is_none_or(|p| glob(p, url.path(), b'/'))
            && self
                .search
                .as_ref()
                .is_none_or(|p| *p == url.query().map(|s| format!("?{s}")).unwrap_or_default())
    }
}
fn seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn hash(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}
#[derive(Debug)]
struct ImageError(StatusCode, &'static str);
impl std::fmt::Display for ImageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.1)
    }
}
impl std::error::Error for ImageError {}
fn invalid(message: &'static str) -> anyhow::Error {
    ImageError(StatusCode::BAD_REQUEST, message).into()
}
enum Source {
    File(std::fs::File),
    Bytes(Cursor<Vec<u8>>),
}
struct Entry {
    source: Source,
    length: u64,
    etag: String,
    mime: String,
    expires: u64,
}
struct Store {
    directory: PathBuf,
    connection: Mutex<Option<Connection>>,
    limit: u64,
}
impl Store {
    fn connection<T>(&self, operation: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut guard = self
            .connection
            .lock()
            .map_err(|_| anyhow!("Image cache unavailable"))?;
        if guard.is_none() {
            std::fs::create_dir_all(&self.directory)?;
            let conn = Connection::open(self.directory.join("index.sqlite3"))?;
            conn.busy_timeout(Duration::from_secs(5))?;
            conn.execute_batch("PRAGMA cache_size=-2048; PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS images(key TEXT PRIMARY KEY,file TEXT NOT NULL,etag TEXT NOT NULL,mime TEXT NOT NULL,expires INTEGER NOT NULL,access INTEGER NOT NULL,bytes INTEGER NOT NULL);")?;
            *guard = Some(conn);
        }
        operation(guard.as_mut().unwrap())
    }
    fn get(&self, key: &str) -> Result<Option<Entry>> {
        if self.limit == 0 {
            return Ok(None);
        }
        self.connection(|conn| {
            let row = conn
                .query_row(
                    "SELECT file,etag,mime,expires FROM images WHERE key=?1",
                    [key],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get::<_, i64>(3)? as u64,
                        ))
                    },
                )
                .optional()?;
            match row {
                Some((file, etag, mime, expires))
                    if expires > seconds() && self.directory.join(&file).is_file() =>
                {
                    conn.execute(
                        "UPDATE images SET access=?2 WHERE key=?1 AND access<?2-30",
                        params![key, seconds() as i64],
                    )?;
                    let file = match std::fs::File::open(self.directory.join(file)) {
                        Ok(file) => file,
                        Err(_) => return Ok(None),
                    };
                    let length = file.metadata()?.len();
                    Ok(Some(Entry {
                        source: Source::File(file),
                        length,
                        etag,
                        mime,
                        expires,
                    }))
                }
                _ => Ok(None),
            }
        })
    }
    fn put(&self, key: &str, bytes: Vec<u8>, mime: &str, ttl: u64) -> Result<Entry> {
        let etag = format!("\"{}\"", hash(&bytes));
        let expires = seconds().saturating_add(ttl);
        let length = bytes.len() as u64;
        if length > self.limit || self.limit == 0 {
            return Ok(Entry {
                source: Source::Bytes(Cursor::new(bytes)),
                length,
                etag,
                mime: mime.into(),
                expires,
            });
        }
        let name = format!("{key}-{}.img", hash(&bytes));
        let file = self.directory.join(&name);
        self.connection(|conn| {
            let mut random = [0u8; 8];
            getrandom::fill(&mut random).map_err(|e| anyhow!(e.to_string()))?;
            let temporary = self
                .directory
                .join(format!(".{key}-{:x}.tmp", u64::from_ne_bytes(random)));
            std::fs::write(&temporary, &bytes)?;
            std::fs::rename(&temporary, &file)?;
            let old: Option<String> = conn
                .query_row("SELECT file FROM images WHERE key=?1", [key], |r| r.get(0))
                .optional()?;
            conn.execute(
                "INSERT OR REPLACE INTO images VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    key,
                    name,
                    etag,
                    mime,
                    expires as i64,
                    seconds() as i64,
                    bytes.len() as i64
                ],
            )?;
            if let Some(old) = old.filter(|old| *old != name) {
                let _ = std::fs::remove_file(self.directory.join(old));
            }
            loop {
                let (size, count): (i64, i64) = conn.query_row(
                    "SELECT COALESCE(SUM(bytes),0),COUNT(*) FROM images",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                if size as u64 <= self.limit && count as u64 <= MAX_ENTRIES {
                    break;
                }
                let (old_key, old_file): (String, String) = conn.query_row(
                    "SELECT key,file FROM images WHERE key!=?1 ORDER BY access,key LIMIT 1",
                    [key],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?;
                conn.execute("DELETE FROM images WHERE key=?1", [old_key])?;
                let _ = std::fs::remove_file(self.directory.join(old_file));
            }
            Ok(Entry {
                source: Source::File(std::fs::File::open(file)?),
                length,
                etag,
                mime: mime.into(),
                expires,
            })
        })
    }
}
pub struct Images {
    config: ImageConfig,
    project: PathBuf,
    dist: PathBuf,
    base_path: String,
    asset_base: String,
    local_origin: String,
    slots: Arc<Semaphore>,
    transforms: Arc<Semaphore>,
    flights: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
    store: Arc<Store>,
}
impl Images {
    pub fn new(
        project: PathBuf,
        dist: PathBuf,
        config: ImageConfig,
        base_path: String,
        asset_base: String,
        local_origin: String,
    ) -> Self {
        Self {
            store: Arc::new(Store {
                directory: project.join(".rustyx-cache/images"),
                connection: Mutex::new(None),
                limit: config.maximum_disk_cache_size,
            }),
            config,
            project,
            dist,
            base_path,
            asset_base,
            local_origin,
            slots: Arc::new(Semaphore::new(16)),
            transforms: Arc::new(Semaphore::new(2)),
            flights: Mutex::new(HashMap::new()),
        }
    }
    pub fn matches(&self, path: &str) -> bool {
        let path = path.trim_end_matches('/');
        path == self.config.path.trim_end_matches('/')
            || path == format!("{}/_next/image", self.base_path)
            || path == format!("{}/_rustyx/image", self.base_path)
    }
    pub async fn handle(&self, request: Request) -> Response<Body> {
        match tokio::time::timeout(TIMEOUT, self.optimize(request)).await {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                let (status, message) = error
                    .downcast_ref::<ImageError>()
                    .map(|e| (e.0, e.1))
                    .unwrap_or((
                        StatusCode::BAD_REQUEST,
                        "The requested resource is not a valid image",
                    ));
                {
                    let mut response = Response::builder()
                        .status(status)
                        .header(header::CACHE_CONTROL, "no-store")
                        .body(Body::from(message))
                        .unwrap();
                    if status == StatusCode::SERVICE_UNAVAILABLE {
                        response
                            .headers_mut()
                            .insert(header::RETRY_AFTER, "1".parse().unwrap());
                    }
                    response
                }
            }
            Err(_) => Response::builder()
                .status(504)
                .header(header::CACHE_CONTROL, "no-store")
                .body(Body::from("Image optimization timed out"))
                .unwrap(),
        }
    }
    async fn optimize(&self, request: Request) -> Result<Response<Body>> {
        if !matches!(
            *request.method(),
            axum::http::Method::GET | axum::http::Method::HEAD
        ) {
            return Ok(Response::builder()
                .status(405)
                .header(header::ALLOW, "GET, HEAD")
                .body(Body::empty())?);
        }
        if self.config.unoptimized || self.config.loader != "default" {
            return Err(ImageError(StatusCode::NOT_FOUND, "Image optimization is disabled").into());
        }
        let slot = self.slots.clone().try_acquire_owned().map_err(|_| {
            ImageError(
                StatusCode::SERVICE_UNAVAILABLE,
                "Image optimization queue is full",
            )
        })?;
        if request
            .uri()
            .query()
            .is_some_and(|query| query.len() > 8192)
        {
            return Err(invalid("Image query exceeds 8192 bytes"));
        }
        let mut query = HashMap::new();
        for (key, value) in
            reqwest::Url::parse(&format!("http://local{}", request.uri()))?.query_pairs()
        {
            if query.insert(key.into_owned(), value.into_owned()).is_some() {
                return Err(invalid("Image parameters must not be repeated"));
            }
        }
        let source = query
            .get("url")
            .filter(|s| !s.is_empty() && s.len() <= 4096)
            .ok_or_else(|| invalid("A valid url parameter is required"))?;
        let width = query
            .get("w")
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|v| self.config.device_sizes.contains(v) || self.config.image_sizes.contains(v))
            .ok_or_else(|| invalid("The requested width is not allowed"))?;
        let quality = query
            .get("q")
            .and_then(|v| v.parse::<u8>().ok())
            .filter(|v| self.config.qualities.contains(v))
            .ok_or_else(|| invalid("The requested quality is not allowed"))?;
        let remote = !source.starts_with('/');
        if source.starts_with("//") || source.contains('\\') || source.chars().any(char::is_control)
        {
            return Err(invalid("Invalid image URL"));
        }
        let url = if remote {
            reqwest::Url::parse(source)?
        } else {
            reqwest::Url::parse("http://rustyx.local")?.join(source)?
        };
        if !url.username().is_empty()
            || url.password().is_some()
            || !matches!(url.scheme(), "http" | "https")
        {
            return Err(invalid(
                "Image URL must use HTTP or HTTPS without credentials",
            ));
        }
        if self.matches(url.path()) {
            return Err(invalid(
                "Image optimizer URLs cannot be optimized recursively",
            ));
        }
        if remote {
            if !self
                .config
                .domains
                .iter()
                .any(|host| Some(host.as_str()) == url.host_str())
                && !self
                    .config
                    .remote_patterns
                    .iter()
                    .any(|pattern| pattern.matches(&url, true))
            {
                return Err(invalid("Image URL is not allowed by remotePatterns"));
            }
        } else if self
            .config
            .local_patterns
            .as_ref()
            .is_some_and(|patterns| !patterns.iter().any(|p| p.matches(&url, false)))
        {
            return Err(invalid("Image URL is not allowed by localPatterns"));
        }
        let format = accepted_format(request.headers(), &self.config.formats);
        let key = hash(format!("v1|{source}|{width}|{quality}|{format}").as_bytes());
        let store = self.store.clone();
        let lookup = key.clone();
        let mut entry = tokio::task::spawn_blocking(move || store.get(&lookup)).await??;
        let mut cache_status = "HIT";
        if entry.is_none() {
            let lock = {
                let mut map = self.flights.lock().unwrap();
                map.retain(|_, value| value.strong_count() > 0);
                map.entry(key.clone())
                    .or_default()
                    .upgrade()
                    .unwrap_or_else(|| {
                        let lock = Arc::new(tokio::sync::Mutex::new(()));
                        map.insert(key.clone(), Arc::downgrade(&lock));
                        lock
                    })
            };
            let _guard = lock.lock().await;
            let store = self.store.clone();
            let lookup = key.clone();
            entry = tokio::task::spawn_blocking(move || store.get(&lookup)).await??;
            if entry.is_none() {
                cache_status = "MISS";
                let permit = self.transforms.clone().acquire_owned().await?;
                let (bytes, source_ttl) = if remote {
                    self.fetch(url.clone(), false).await?
                } else {
                    self.local(&url).await?
                };
                let allow_svg = self.config.dangerously_allow_svg;
                let format = format.to_owned();
                let (output, permit) = tokio::task::spawn_blocking(move || {
                    let output = transform(&bytes, width, quality, &format, allow_svg)?;
                    Ok::<_, anyhow::Error>((output, permit))
                })
                .await??;
                let store = self.store.clone();
                let ttl = self.config.minimum_cache_ttl.max(source_ttl);
                let key = key.clone();
                entry = Some(
                    tokio::task::spawn_blocking(move || {
                        let _permit = permit;
                        store.put(&key, output.bytes, &output.mime, ttl)
                    })
                    .await??,
                );
            }
        }
        let entry = entry.unwrap();
        let not_modified = request
            .headers()
            .get(header::IF_NONE_MATCH)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(',')
                    .any(|v| v.trim().trim_start_matches("W/") == entry.etag || v.trim() == "*")
            });
        let body = if not_modified || request.method() == axum::http::Method::HEAD {
            Body::empty()
        } else {
            entry_body(entry.source, slot)
        };
        let mut response = Response::builder()
            .status(if not_modified { 304 } else { 200 })
            .body(body)?;
        if !not_modified {
            response
                .headers_mut()
                .insert(header::CONTENT_LENGTH, entry.length.into());
        }
        let headers = response.headers_mut();
        headers.insert(header::CONTENT_TYPE, entry.mime.parse()?);
        headers.insert(header::ETAG, entry.etag.parse()?);
        headers.insert(header::VARY, "Accept".parse()?);
        headers.insert(
            header::CACHE_CONTROL,
            format!(
                "public, max-age={}, must-revalidate",
                entry.expires.saturating_sub(seconds())
            )
            .parse()?,
        );
        headers.insert("x-nextjs-cache", cache_status.parse()?);
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            self.config.content_security_policy.parse()?,
        );
        headers.insert(
            header::CONTENT_DISPOSITION,
            format!(
                "{}; filename=\"image.{}\"",
                self.config.content_disposition_type,
                extension(&entry.mime)
            )
            .parse()?,
        );
        headers.insert("x-content-type-options", "nosniff".parse()?);
        Ok(response)
    }
    async fn local(&self, url: &reqwest::Url) -> Result<(Vec<u8>, u64)> {
        let path = url
            .path()
            .strip_prefix(&self.base_path)
            .filter(|rest| rest.starts_with('/'))
            .unwrap_or(url.path());
        let asset_prefix = reqwest::Url::parse(&self.asset_base)
            .ok()
            .map(|v| v.path().to_owned())
            .unwrap_or_else(|| self.asset_base.clone());
        let candidate = if let Some(name) = url.path().strip_prefix(&(asset_prefix + "/")) {
            Some((self.dist.join("assets"), name.to_owned()))
        } else if let Some(name) = path.strip_prefix("/_rustyx/assets/") {
            Some((self.dist.join("assets"), name.to_owned()))
        } else if !path.starts_with("/_rustyx/") && !path.starts_with("/_next/") {
            Some((
                self.project.join("public"),
                path.trim_start_matches('/').to_owned(),
            ))
        } else {
            None
        };
        if let Some((root, name)) = candidate {
            let decoded = percent_encoding::percent_decode_str(&name)
                .decode_utf8()
                .map_err(|_| invalid("Invalid image path"))?;
            let root = tokio::fs::canonicalize(root).await.ok();
            if let Some(root) = root {
                if let Ok(file) = tokio::fs::canonicalize(root.join(decoded.as_ref())).await {
                    if !file.starts_with(&root) {
                        return Err(invalid("Image path is outside the public directory"));
                    }
                    let stat = tokio::fs::metadata(&file).await?;
                    if stat.is_file() {
                        if stat.len() > self.config.maximum_response_body as u64 {
                            return Err(invalid("Image source exceeds maximumResponseBody"));
                        }
                        let mut bytes = Vec::with_capacity(stat.len() as usize);
                        tokio::fs::File::open(file)
                            .await?
                            .take(self.config.maximum_response_body as u64 + 1)
                            .read_to_end(&mut bytes)
                            .await?;
                        if bytes.len() > self.config.maximum_response_body {
                            return Err(invalid("Image source exceeds maximumResponseBody"));
                        }
                        return Ok((bytes, 0));
                    }
                }
            }
        }
        let target = reqwest::Url::parse(&self.local_origin)?.join(&format!(
            "{}{}",
            url.path(),
            url.query().map(|q| format!("?{q}")).unwrap_or_default()
        ))?;
        self.fetch(target, true).await
    }
    async fn fetch(&self, mut url: reqwest::Url, mut internal: bool) -> Result<(Vec<u8>, u64)> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        for redirect in 0..=self.config.maximum_redirects {
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(invalid("Invalid image redirect URL"));
            }
            if self.matches(url.path()) {
                return Err(invalid(
                    "Image optimizer URLs cannot be optimized recursively",
                ));
            }
            let hostname = url
                .host_str()
                .ok_or_else(|| invalid("Invalid image hostname"))?;
            let addresses: Vec<SocketAddr> = tokio::net::lookup_host((
                hostname.trim_matches(['[', ']']),
                url.port_or_known_default().unwrap_or(80),
            ))
            .await?
            .collect();
            if addresses.is_empty()
                || !internal
                    && !self.config.dangerously_allow_local_ip
                    && addresses.iter().any(|a| !public_ip(a.ip()))
            {
                return Err(invalid(
                    "Image source resolves to a private or reserved address",
                ));
            }
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(TIMEOUT)
                .connect_timeout(Duration::from_secs(5))
                .resolve_to_addrs(hostname, &addresses)
                .build()?;
            let response = client
                .get(url.clone())
                .header(header::ACCEPT, "image/*")
                .send()
                .await?;
            if response.status().is_redirection() {
                if redirect == self.config.maximum_redirects {
                    return Err(invalid("Image source exceeded maximumRedirects"));
                }
                let location = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| invalid("Image redirect has no Location"))?;
                let target = url.join(location)?;
                internal = internal && target.origin() == url.origin();
                url = target;
                continue;
            }
            if !response.status().is_success() {
                return Err(ImageError(
                    response.status(),
                    "Image upstream returned an unsuccessful response",
                )
                .into());
            }
            if response
                .content_length()
                .is_some_and(|v| v > self.config.maximum_response_body as u64)
            {
                return Err(invalid("Image source exceeds maximumResponseBody"));
            }
            let ttl = upstream_ttl(response.headers());
            let mut body = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                if body.len().saturating_add(chunk.len()) > self.config.maximum_response_body {
                    return Err(invalid("Image source exceeds maximumResponseBody"));
                }
                body.extend_from_slice(&chunk);
            }
            return Ok((body, ttl));
        }
        Err(invalid("Image redirect limit"))
    }
}
fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let o = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_broadcast()
                || ip.is_documentation()
                || ip.is_unspecified()
                || ip.is_multicast()
                || o[0] == 0
                || o[0] >= 240
                || o[0] == 100 && (64..=127).contains(&o[1])
                || o[0] == 192 && o[1] == 0 && o[2] == 0
                || o[0] == 192 && o[1] == 88 && o[2] == 99
                || o[0] == 198 && (o[1] == 18 || o[1] == 19))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let s = ip.segments();
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                || (s[0] == 0x2001 && s[1] == 0xdb8)
                || s[0] == 0x2001 && s[1] <= 0x1ff
                || s[0] == 0x2002
                || s[0] < 0x2000
                || s[0] >= 0x4000)
        }
    }
}
fn upstream_ttl(headers: &HeaderMap) -> u64 {
    let mut max = 0;
    let mut shared = None;
    for token in headers
        .get(header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(',')
    {
        if let Some((key, value)) = token.trim().split_once('=') {
            if let Ok(value) = value.trim_matches('"').parse::<u64>() {
                if key == "s-maxage" {
                    shared = Some(value);
                } else if key == "max-age" {
                    max = value;
                }
            }
        }
    }
    shared.unwrap_or(max).min(31536000)
}
fn accepted_format(headers: &HeaderMap, formats: &[String]) -> &'static str {
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let mut selected = "";
    let mut best = 0f32;
    for format in formats {
        let mut quality = 0f32;
        let mut specificity = 0;
        for item in accept.split(',') {
            let mut fields = item.trim().split(';');
            let media = fields.next().unwrap_or("").trim();
            let score = if media == format {
                3
            } else if media == "image/*" {
                2
            } else if media == "*/*" {
                1
            } else {
                0
            };
            if score > specificity {
                specificity = score;
                quality = fields
                    .find_map(|v| v.trim().strip_prefix("q=").and_then(|q| q.parse().ok()))
                    .unwrap_or(1.0);
            }
        }
        if quality.is_finite() && quality > best && quality <= 1.0 {
            best = quality;
            selected = if format == "image/avif" {
                "image/avif"
            } else {
                "image/webp"
            };
        }
    }
    selected
}
fn entry_body(source: Source, permit: OwnedSemaphorePermit) -> Body {
    enum Reader {
        File(tokio::fs::File),
        Bytes(Cursor<Vec<u8>>),
    }
    let reader = match source {
        Source::File(file) => Reader::File(tokio::fs::File::from_std(file)),
        Source::Bytes(bytes) => Reader::Bytes(bytes),
    };
    Body::from_stream(
        futures_util::stream::unfold((reader, permit), |(mut reader, permit)| async move {
            let mut bytes = vec![0; 64 * 1024];
            let result = match &mut reader {
                Reader::File(file) => file.read(&mut bytes).await,
                Reader::Bytes(cursor) => std::io::Read::read(cursor, &mut bytes),
            };
            match result {
                Ok(0) => None,
                Ok(length) => {
                    bytes.truncate(length);
                    Some((Ok::<_, std::io::Error>(bytes), (reader, permit)))
                }
                Err(error) => Some((Err(error), (reader, permit))),
            }
        })
        .fuse(),
    )
}
fn extension(mime: &str) -> &str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/avif" => "avif",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}
struct Output {
    bytes: Vec<u8>,
    mime: String,
}
fn animated(bytes: &[u8], format: ImageFormat) -> bool {
    match format {
        ImageFormat::Gif => {
            if bytes.len() < 13 {
                return false;
            }
            let mut offset = 13
                + if bytes[10] & 128 != 0 {
                    3usize << ((bytes[10] & 7) + 1)
                } else {
                    0
                };
            let mut frames = 0;
            while offset < bytes.len() {
                let marker = bytes[offset];
                offset += 1;
                match marker {
                    0x2c => {
                        if offset + 9 > bytes.len() {
                            return false;
                        }
                        frames += 1;
                        if frames > 1 {
                            return true;
                        }
                        let flags = bytes[offset + 8];
                        offset += 9 + if flags & 128 != 0 {
                            3usize << ((flags & 7) + 1)
                        } else {
                            0
                        };
                        offset += 1;
                    }
                    0x21 => offset += 1,
                    _ => break,
                }
                while offset < bytes.len() {
                    let length = bytes[offset] as usize;
                    offset += 1;
                    if length == 0 {
                        break;
                    }
                    offset = offset.saturating_add(length);
                }
            }
            false
        }
        ImageFormat::Png => {
            let mut offset = 8;
            while offset + 12 <= bytes.len() {
                let length =
                    u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
                if &bytes[offset + 4..offset + 8] == b"acTL" {
                    return true;
                }
                offset = offset.saturating_add(length).saturating_add(12);
            }
            false
        }
        ImageFormat::WebP => image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))
            .is_ok_and(|decoder| decoder.has_animation()),
        _ => false,
    }
}
fn decode_avif(bytes: &[u8]) -> Result<DynamicImage> {
    // Inspect every sequence header, including later layers, before a decoder allocates frames.
    let parsed = avif_parse::read_avif(&mut Cursor::new(bytes))?;
    for stream in
        std::iter::once(parsed.primary_item.as_slice()).chain(parsed.alpha_item.as_deref())
    {
        let mut offset = 0usize;
        while offset < stream.len() {
            let start = offset;
            let header = stream[offset];
            offset += 1;
            if header & 0x80 != 0 || header & 1 != 0 {
                return Err(invalid("Invalid AV1 header"));
            }
            if header & 4 != 0 {
                offset = offset.saturating_add(1);
            }
            let length = if header & 2 != 0 {
                let mut value = 0u64;
                let mut shift = 0;
                loop {
                    let byte = *stream
                        .get(offset)
                        .ok_or_else(|| invalid("Truncated AV1 data"))?;
                    offset += 1;
                    value |= u64::from(byte & 127) << shift;
                    if byte & 128 == 0 {
                        break value;
                    }
                    shift += 7;
                    if shift >= 56 {
                        return Err(invalid("Invalid AV1 length"));
                    }
                }
            } else {
                stream.len().saturating_sub(offset) as u64
            };
            if (header >> 3) & 15 == 1 {
                let metadata = avif_parse::AV1Metadata::parse_av1_bitstream(&stream[start..])?;
                let width = metadata.max_frame_width.get();
                let height = metadata.max_frame_height.get();
                if width > 32768
                    || height > 32768
                    || u64::from(width) * u64::from(height) > MAX_PIXELS
                {
                    return Err(invalid("Image dimensions exceed the 40 megapixel limit"));
                }
            }
            offset = offset
                .checked_add(usize::try_from(length)?)
                .filter(|v| *v <= stream.len())
                .ok_or_else(|| invalid("Truncated AV1 data"))?;
        }
    }
    drop(parsed);
    macro_rules! convert {
        ($image:expr,$variant:ident,$fields:expr) => {{
            let (pixels, width, height) = $image.into_contiguous_buf();
            let pixels = pixels.into_iter().flat_map($fields).collect();
            DynamicImage::$variant(
                image::ImageBuffer::from_raw(width as u32, height as u32, pixels)
                    .ok_or_else(|| invalid("Invalid AVIF dimensions"))?,
            )
        }};
    }
    Ok(match avif_decode::Decoder::from_avif(bytes)?.to_image()? {
        avif_decode::Image::Rgb8(image) => convert!(image, ImageRgb8, |p| [p.r, p.g, p.b]),
        avif_decode::Image::Rgba8(image) => convert!(image, ImageRgba8, |p| [p.r, p.g, p.b, p.a]),
        avif_decode::Image::Rgb16(image) => convert!(image, ImageRgb16, |p| [p.r, p.g, p.b]),
        avif_decode::Image::Rgba16(image) => convert!(image, ImageRgba16, |p| [p.r, p.g, p.b, p.a]),
        avif_decode::Image::Gray8(image) => convert!(image, ImageLuma8, |p| [p.value()]),
        avif_decode::Image::Gray16(image) => convert!(image, ImageLuma16, |p| [p.value()]),
    })
}
fn decode(bytes: &[u8]) -> Result<DynamicImage> {
    if image::guess_format(bytes)? == ImageFormat::Avif {
        return decode_avif(bytes);
    }
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(32768);
    limits.max_image_height = Some(32768);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let mut decoder = reader.into_decoder()?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(invalid("Image dimensions exceed the 40 megapixel limit"));
    }
    let orientation = decoder.orientation()?;
    let mut decoded = DynamicImage::from_decoder(decoder)?;
    decoded.apply_orientation(orientation);
    Ok(decoded)
}
fn transform(
    bytes: &[u8],
    width: u32,
    quality: u8,
    format: &str,
    allow_svg: bool,
) -> Result<Output> {
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(1024)]);
    if text
        .trim_start_matches('\u{feff}')
        .trim_start()
        .starts_with("<svg")
        || text.contains("<svg ")
        || text.contains("<svg>")
    {
        if !allow_svg {
            return Err(invalid("SVG optimization requires dangerouslyAllowSVG"));
        }
        return Ok(Output {
            bytes: bytes.to_vec(),
            mime: "image/svg+xml".into(),
        });
    }
    let input =
        image::guess_format(bytes).map_err(|_| invalid("The source is not a supported image"))?;
    let mut decoded = decode(bytes)?;
    if animated(bytes, input) {
        return Ok(Output {
            bytes: bytes.to_vec(),
            mime: input.to_mime_type().into(),
        });
    }
    if decoded.width() > width {
        decoded = decoded.resize(width, u32::MAX, image::imageops::FilterType::Lanczos3);
    }
    let mime = if format.is_empty() {
        if decoded.color().has_alpha() {
            "image/png"
        } else {
            "image/jpeg"
        }
    } else {
        format
    };
    let mut output = Vec::new();
    match mime {
        "image/webp" => {
            let rgba = decoded.into_rgba8();
            output = webp::Encoder::from_rgba(&rgba, rgba.width(), rgba.height())
                .encode_simple(false, f32::from(quality))
                .map_err(|e| anyhow!("WebP encoding failed: {e:?}"))?
                .to_vec();
        }
        "image/avif" => {
            let rgba = decoded.into_rgba8();
            image::codecs::avif::AvifEncoder::new_with_speed_quality(
                &mut output,
                8,
                quality.saturating_sub(20).max(1),
            )
            .with_num_threads(Some(1))
            .write_image(
                &rgba,
                rgba.width(),
                rgba.height(),
                image::ExtendedColorType::Rgba8,
            )?;
        }
        "image/png" => {
            decoded.write_to(&mut Cursor::new(&mut output), ImageFormat::Png)?;
        }
        _ => {
            let rgb = decoded.into_rgb8();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality).write_image(
                &rgb,
                rgb.width(),
                rgb.height(),
                image::ExtendedColorType::Rgb8,
            )?;
        }
    }
    Ok(Output {
        bytes: output,
        mime: mime.into(),
    })
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    width: u32,
    height: u32,
    #[serde(rename = "blurDataURL", skip_serializing_if = "Option::is_none")]
    blur_data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    blur_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    blur_height: Option<u32>,
}
pub fn image_info(path: &Path) -> Result<ImageInfo> {
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(std::fs::File::open(path)?, 50_000_001),
        &mut bytes,
    )?;
    if bytes.len() > 50_000_000 {
        bail!("Static image exceeds 50 MB");
    }
    let decoded = decode(&bytes)?;
    let (width, height) = (decoded.width(), decoded.height());
    let format = image::guess_format(&bytes)?;
    if animated(&bytes, format) {
        return Ok(ImageInfo {
            width,
            height,
            blur_data_url: None,
            blur_width: None,
            blur_height: None,
        });
    }
    let thumb = decoded.thumbnail(8, 8);
    let (bw, bh) = (thumb.width(), thumb.height());
    let rgba = thumb.into_rgba8();
    let output = webp::Encoder::from_rgba(&rgba, bw, bh)
        .encode_simple(false, 50.0)
        .map_err(|e| anyhow!("Blur encoding failed: {e:?}"))?;
    Ok(ImageInfo {
        width,
        height,
        blur_data_url: Some(format!(
            "data:image/webp;base64,{}",
            STANDARD.encode(&*output)
        )),
        blur_width: Some(bw),
        blur_height: Some(bh),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(width: u32, height: u32) -> Vec<u8> {
        let image = image::RgbaImage::from_fn(width, height, |x, y| {
            image::Rgba([
                (x % 256) as u8,
                (y % 256) as u8,
                90,
                if x < width / 2 { 128 } else { 255 },
            ])
        });
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    }
    #[test]
    fn real_transforms_preserve_aspect_alpha_and_never_upscale() {
        let input = png(100, 50);
        let output = transform(&input, 32, 75, "image/webp", false).unwrap();
        assert_eq!(output.mime, "image/webp");
        let decoded = decode(&output.bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (32, 16));
        assert!(decoded.color().has_alpha());
        let output = transform(&input, 1000, 75, "", false).unwrap();
        let decoded = decode(&output.bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (100, 50));
    }
    #[test]
    fn avif_has_real_pixels_and_can_be_reoptimized() {
        let output = transform(&png(32, 16), 16, 75, "image/avif", false).unwrap();
        assert_eq!(
            image::guess_format(&output.bytes).unwrap(),
            ImageFormat::Avif
        );
        let decoded = decode(&output.bytes).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (16, 8));
        assert!(decoded.color().has_alpha());
        let webp = transform(&output.bytes, 8, 75, "image/webp", false).unwrap();
        assert_eq!(decode(&webp.bytes).unwrap().width(), 8);
    }
    #[test]
    fn svg_invalid_and_oversized_images_fail_before_encoding() {
        assert!(transform(b"<svg/>", 32, 75, "image/webp", false).is_err());
        assert_eq!(
            transform(b"<svg></svg>", 32, 75, "", true).unwrap().mime,
            "image/svg+xml"
        );
        assert!(transform(b"not an image", 32, 75, "", false).is_err());
    }
    #[test]
    fn animated_gif_is_preserved_but_still_gif_is_optimized() {
        fn gif(frames: usize) -> Vec<u8> {
            let mut bytes = Vec::new();
            {
                let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
                for _ in 0..frames {
                    encoder
                        .encode_frame(image::Frame::new(image::RgbaImage::from_pixel(
                            4,
                            2,
                            image::Rgba([12, 34, 56, 255]),
                        )))
                        .unwrap();
                }
            }
            bytes
        }
        let still = gif(1);
        assert_eq!(
            transform(&still, 2, 75, "image/webp", false).unwrap().mime,
            "image/webp"
        );
        let animation = gif(2);
        let output = transform(&animation, 2, 75, "image/webp", false).unwrap();
        assert_eq!(output.mime, "image/gif");
        assert_eq!(output.bytes, animation);
    }
    #[test]
    fn mime_negotiation_obeys_quality_and_specific_exclusions() {
        let mut headers = HeaderMap::new();
        let formats = vec!["image/avif".into(), "image/webp".into()];
        headers.insert(
            header::ACCEPT,
            "image/avif;q=0.2,image/webp;q=0.9".parse().unwrap(),
        );
        assert_eq!(accepted_format(&headers, &formats), "image/webp");
        headers.insert(
            header::ACCEPT,
            "image/avif;q=0,image/*;q=1".parse().unwrap(),
        );
        assert_eq!(accepted_format(&headers, &formats), "image/webp");
        headers.insert(header::ACCEPT, "image/jpeg".parse().unwrap());
        assert_eq!(accepted_format(&headers, &formats), "");
    }
    #[test]
    fn public_config_preserves_acronym_fields() {
        let config: ImageConfig = serde_json::from_str(
            r#"{"minimumCacheTTL":17,"dangerouslyAllowLocalIP":true,"dangerouslyAllowSVG":true}"#,
        )
        .unwrap();
        assert_eq!(config.minimum_cache_ttl, 17);
        assert!(config.dangerously_allow_local_ip);
        assert!(config.dangerously_allow_svg);
    }
    #[test]
    fn source_patterns_and_private_network_guard() {
        assert!(glob("/photos/**", "/photos", b'/'));
        let pattern = Pattern {
            hostname: Some("*.example.com".into()),
            pathname: Some("/photos/**".into()),
            search: Some("?v=1".into()),
            ..Default::default()
        };
        assert!(pattern.matches(
            &reqwest::Url::parse("https://img.example.com/photos/a/b?v=1").unwrap(),
            true
        ));
        assert!(!pattern.matches(
            &reqwest::Url::parse("https://deep.img.example.com/photos/a?v=1").unwrap(),
            true
        ));
        assert!(!pattern.matches(
            &reqwest::Url::parse("https://img.example.com/photos/a?v=2").unwrap(),
            true
        ));
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "192.0.0.170",
            "192.88.99.1",
            "100.64.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "2001:db8::1",
            "2001:2::1",
            "2002:7f00:0001::",
        ] {
            assert!(!public_ip(address.parse().unwrap()), "{address}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
    }
    #[test]
    fn persistent_cache_is_bounded_and_evicted_open_readers_survive() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store {
            directory: dir.path().to_owned(),
            connection: Mutex::new(None),
            limit: 8,
        };
        let first = store.put("a", vec![1; 8], "image/png", 60).unwrap();
        store.put("b", vec![2; 8], "image/png", 60).unwrap();
        assert!(store.get("a").unwrap().is_none());
        assert!(store.get("b").unwrap().is_some());
        let Source::File(mut file) = first.source else {
            panic!()
        };
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut data).unwrap();
        assert_eq!(data, vec![1; 8]);
        let oversize = store.put("c", vec![3; 9], "image/png", 60).unwrap();
        assert!(matches!(oversize.source, Source::Bytes(_)));
        assert!(store.get("c").unwrap().is_none());
        drop(store);
        let store = Store {
            directory: dir.path().to_owned(),
            connection: Mutex::new(None),
            limit: 8,
        };
        assert!(store.get("b").unwrap().is_some());
        store.put("b", vec![4; 8], "image/png", 0).unwrap();
        assert!(store.get("b").unwrap().is_none());
    }
    #[tokio::test]
    async fn slow_response_keeps_admission_and_disabled_cache_does_not_open_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store {
            directory: dir.path().join("absent"),
            connection: Mutex::new(None),
            limit: 0,
        };
        let entry = store.put("a", vec![0; 200_000], "image/png", 60).unwrap();
        assert!(!store.directory.exists());
        let semaphore = Arc::new(Semaphore::new(1));
        let body = entry_body(
            entry.source,
            semaphore.clone().acquire_owned().await.unwrap(),
        );
        assert_eq!(semaphore.available_permits(), 0);
        let mut stream = body.into_data_stream();
        assert_eq!(stream.next().await.unwrap().unwrap().len(), 64 * 1024);
        assert_eq!(semaphore.available_permits(), 0);
        drop(stream);
        assert_eq!(semaphore.available_permits(), 1);
    }
}
