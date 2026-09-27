//! Private, persistent data cache shared by render workers. No application data
//! or SQLite connection is allocated until the first authenticated operation.
use anyhow::{anyhow, bail, Context, Result};
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Request, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_core::Stream;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, VecDeque},
    convert::Infallible,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex, OnceLock},
    task::{Context as TaskContext, Poll},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
    time::timeout,
};

const MAX_VALUE: usize = 2 * 1024 * 1024;
const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_ASSOCIATIONS: usize = 128;
const LEASE_MS: i64 = 30_000;
const RESPONSE_CHUNK_BYTES: usize = 64 * 1024;

/// Each chunk owns its allocation: retaining the last network frame cannot pin
/// the entire multi-megabyte response after admission has been released.
#[derive(Default)]
struct JsonChunks {
    chunks: VecDeque<Bytes>,
    buffer: Vec<u8>,
}
impl std::io::Write for JsonChunks {
    fn write(&mut self, mut bytes: &[u8]) -> std::io::Result<usize> {
        let total = bytes.len();
        while !bytes.is_empty() {
            let count = bytes.len().min(RESPONSE_CHUNK_BYTES - self.buffer.len());
            self.buffer.extend_from_slice(&bytes[..count]);
            bytes = &bytes[count..];
            if self.buffer.len() == RESPONSE_CHUNK_BYTES {
                self.chunks
                    .push_back(Bytes::from(std::mem::take(&mut self.buffer)));
            }
        }
        Ok(total)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl JsonChunks {
    fn encode(value: &Value) -> Result<VecDeque<Bytes>> {
        let mut output = Self::default();
        serde_json::to_writer(&mut output, value)?;
        if !output.buffer.is_empty() {
            output.chunks.push_back(Bytes::from(output.buffer));
        }
        Ok(output.chunks)
    }
}
struct CacheReplyBody {
    chunks: VecDeque<Bytes>,
    permit: Option<OwnedSemaphorePermit>,
}
impl Stream for CacheReplyBody {
    type Item = std::result::Result<Bytes, Infallible>;
    fn poll_next(mut self: Pin<&mut Self>, _cx: &mut TaskContext<'_>) -> Poll<Option<Self::Item>> {
        match self.chunks.pop_front() {
            Some(bytes) => Poll::Ready(Some(Ok(bytes))),
            None => {
                self.permit.take();
                Poll::Ready(None)
            }
        }
    }
}

#[derive(Clone)]
pub struct CacheCredentials {
    pub url: String,
    pub token: String,
}

pub struct CacheService {
    pub credentials: CacheCredentials,
    task: JoinHandle<()>,
    pages: Arc<OnceLock<Arc<crate::pages::PageCache>>>,
}
impl Drop for CacheService {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl CacheService {
    pub fn set_pages(&self, pages: Arc<crate::pages::PageCache>) {
        let _ = self.pages.set(pages);
    }
    pub async fn start(project: &Path, memory_budget: Option<u64>) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let credentials = CacheCredentials {
            url: format!("http://{}/cache", listener.local_addr()?),
            token: random_token()?,
        };
        let pages = Arc::new(OnceLock::new());
        let state = Arc::new(CacheState {
            memory_budget,
            file: project.join(".prnext-cache/data.sqlite3"),
            token: credentials.token.clone(),
            database: Mutex::new(None),
            slots: Arc::new(Semaphore::new(8)),
            pages: pages.clone(),
            page_slots: Arc::new(Semaphore::new(5)),
        });
        let app = Router::new()
            .route("/cache", post(handle))
            .route("/pages/revalidate", post(revalidate_page))
            .with_state(state);
        let task = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app).await {
                tracing::error!(%error, "private cache service stopped");
            }
        });
        Ok(Self {
            credentials,
            task,
            pages,
        })
    }
}

struct CacheState {
    memory_budget: Option<u64>,
    file: PathBuf,
    token: String,
    database: Mutex<Option<Database>>,
    slots: Arc<Semaphore>,
    pages: Arc<OnceLock<Arc<crate::pages::PageCache>>>,
    page_slots: Arc<Semaphore>,
}

async fn revalidate_page(State(state): State<Arc<CacheState>>, request: Request) -> Response {
    if !authorized(request.headers(), &state.token) {
        return failure(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let Ok(_permit) = state.page_slots.clone().try_acquire_owned() else {
        let mut response = failure(StatusCode::SERVICE_UNAVAILABLE, "Page regeneration busy");
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, "1".parse().unwrap());
        return response;
    };
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct RevalidateRequest {
        path: String,
        #[serde(default)]
        only_generated: bool,
    }
    let bytes = match timeout(
        Duration::from_secs(5),
        to_bytes(request.into_body(), 20 * 1024),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        _ => return failure(StatusCode::BAD_REQUEST, "Invalid revalidation request"),
    };
    let operation: RevalidateRequest = match serde_json::from_slice(&bytes) {
        Ok(operation) => operation,
        Err(_) => return failure(StatusCode::BAD_REQUEST, "Invalid revalidation request"),
    };
    let Some(pages) = state.pages.get() else {
        if operation.only_generated {
            return (
                [(header::CACHE_CONTROL, "no-store")],
                Json(json!({"revalidated":false})),
            )
                .into_response();
        }
        return failure(StatusCode::BAD_REQUEST, "Path is not an SSG page");
    };
    match pages
        .revalidate(&operation.path, operation.only_generated)
        .await
    {
        Ok(revalidated) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(json!({"revalidated":revalidated})),
        )
            .into_response(),
        Err(error) if error.is::<crate::pages::PageBusy>() => {
            let mut response = failure(StatusCode::SERVICE_UNAVAILABLE, "Page regeneration busy");
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "1".parse().unwrap());
            response
        }
        Err(error) => {
            tracing::warn!(%error, "on-demand page regeneration failed");
            failure(StatusCode::BAD_REQUEST, "Page revalidation failed")
        }
    }
}

async fn handle(State(state): State<Arc<CacheState>>, request: Request) -> Response {
    if !authorized(request.headers(), &state.token) {
        return failure(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let Ok(permit) = state.slots.clone().try_acquire_owned() else {
        return failure(StatusCode::SERVICE_UNAVAILABLE, "Cache busy");
    };
    let bytes = match timeout(
        Duration::from_secs(5),
        to_bytes(request.into_body(), MAX_BODY),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return failure(StatusCode::PAYLOAD_TOO_LARGE, "Cache request too large"),
        Err(_) => return failure(StatusCode::REQUEST_TIMEOUT, "Cache request timed out"),
    };
    let operation = match serde_json::from_slice::<CacheRequest>(&bytes)
        .map_err(anyhow::Error::from)
        .and_then(CacheRequest::validate)
    {
        Ok(operation) => operation,
        Err(_) => return failure(StatusCode::BAD_REQUEST, "Invalid cache request"),
    };
    drop(bytes);
    let task =
        tokio::task::spawn_blocking(move || -> Result<(VecDeque<Bytes>, OwnedSemaphorePermit)> {
            let mut database = state
                .database
                .lock()
                .map_err(|_| anyhow!("cache lock poisoned"))?;
            if database.is_none() {
                let opened = Database::open(&state.file, Limits::default())?;
                configure_memory(&opened.connection, state.memory_budget)?;
                *database = Some(opened);
            }
            let database_ref = database.as_mut().unwrap();
            let invalidation = database_ref.route_invalidation(&operation)?;
            let value = match (state.pages.get(), invalidation) {
                (Some(pages), Some(invalidation)) => pages
                    .invalidate_with(&invalidation, || {
                        database_ref.execute(operation, now_ms()?)
                    })?,
                _ => database_ref.execute(operation, now_ms()?)?,
            };
            drop(database);
            // Serialization remains admitted, but does not hold the SQLite mutex or
            // monopolize an async executor thread for a large cache value.
            Ok((JsonChunks::encode(&value)?, permit))
        });
    match timeout(Duration::from_secs(10), task).await {
        Ok(Ok(Ok((chunks, permit)))) => {
            let length: usize = chunks.iter().map(Bytes::len).sum();
            let mut response = Response::new(Body::from_stream(CacheReplyBody {
                chunks,
                permit: Some(permit),
            }));
            response
                .headers_mut()
                .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
            response
                .headers_mut()
                .insert(header::CONTENT_LENGTH, length.to_string().parse().unwrap());
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
            response
        }
        Ok(Ok(Err(error))) => {
            tracing::warn!(%error, "private cache operation failed");
            failure(StatusCode::INTERNAL_SERVER_ERROR, "Cache operation failed")
        }
        Ok(Err(_)) => failure(StatusCode::INTERNAL_SERVER_ERROR, "Cache operation failed"),
        Err(_) => failure(StatusCode::GATEWAY_TIMEOUT, "Cache operation timed out"),
    }
}

fn failure(status: StatusCode, message: &'static str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(json!({"error": message})),
    )
        .into_response()
}
fn authorized(headers: &HeaderMap, token: &str) -> bool {
    if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
        return false;
    }
    let Some(actual) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    let actual = actual.as_bytes();
    let mut difference = token.len() ^ actual.len();
    for (index, expected) in token.bytes().enumerate() {
        difference |= usize::from(expected ^ actual.get(index).copied().unwrap_or(0));
    }
    difference == 0
}
fn random_token() -> Result<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| anyhow!("random source unavailable: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}
fn now_ms() -> Result<i64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .try_into()?)
}
fn milliseconds(seconds: Option<f64>) -> Result<Option<i64>> {
    seconds
        .map(|seconds| {
            if !seconds.is_finite() || seconds < 0.0 || seconds > (i64::MAX / 2000) as f64 {
                bail!("invalid cache duration")
            }
            Ok((seconds * 1000.0).ceil() as i64)
        })
        .transpose()
}
fn key(value: String) -> Result<String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("invalid cache key")
    }
    Ok(value.to_ascii_lowercase())
}
pub(crate) fn associations(
    values: Vec<String>,
    max_length: usize,
    opaque_tags: bool,
) -> Result<Vec<String>> {
    if values.len() > MAX_ASSOCIATIONS
        || values.iter().any(|value| {
            value.len() > max_length || (!opaque_tags && (value.is_empty() || value.contains('\0')))
        })
    {
        bail!("invalid cache associations")
    }
    Ok(values
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum CacheRequest {
    Generation,
    LeaseStatus {
        key: String,
        lease: String,
    },
    Read {
        key: String,
        #[serde(default)]
        tags: Vec<String>,
        #[serde(default)]
        paths: Vec<String>,
        revalidate: Option<f64>,
        #[serde(default, rename = "forceFresh")]
        force_fresh: bool,
        #[serde(default)]
        versioned: bool,
    },
    Commit {
        key: String,
        lease: String,
        value: String,
        revalidate: Option<f64>,
        expire: Option<f64>,
        #[serde(default)]
        tags: Vec<String>,
        #[serde(default)]
        paths: Vec<String>,
    },
    Release {
        key: String,
        lease: String,
    },
    Invalidate {
        #[serde(default)]
        tags: Vec<String>,
        #[serde(default)]
        paths: Vec<String>,
        mode: InvalidateMode,
        expire: Option<f64>,
    },
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum InvalidateMode {
    Expire,
    Stale,
}
enum Operation {
    Generation,
    LeaseStatus {
        key: String,
        lease: String,
    },
    Read {
        key: String,
        tags: Vec<String>,
        paths: Vec<String>,
        ttl: Option<i64>,
        force_fresh: bool,
        versioned: bool,
    },
    Commit {
        key: String,
        lease: String,
        value: Vec<u8>,
        ttl: Option<i64>,
        expire: Option<i64>,
        tags: Vec<String>,
        paths: Vec<String>,
    },
    Release {
        key: String,
        lease: String,
    },
    Invalidate {
        tags: Vec<String>,
        paths: Vec<String>,
        mode: InvalidateMode,
        expire: Option<i64>,
    },
}
impl CacheRequest {
    fn validate(self) -> Result<Operation> {
        Ok(match self {
            Self::Generation => Operation::Generation,
            Self::LeaseStatus { key: value, lease } => Operation::LeaseStatus {
                key: key(value)?,
                lease: key(lease)?,
            },
            Self::Read {
                key: value,
                tags,
                paths,
                revalidate,
                force_fresh,
                versioned,
            } => Operation::Read {
                key: key(value)?,
                tags: associations(tags, 1024, true)?,
                paths: associations(paths, 8192, false)?,
                ttl: milliseconds(revalidate)?,
                force_fresh,
                versioned,
            },
            Self::Commit {
                key: value,
                lease,
                value: body,
                revalidate,
                expire,
                tags,
                paths,
            } => {
                if body.len() > MAX_VALUE.div_ceil(3) * 4 {
                    bail!("cache value too large")
                }
                let body = STANDARD.decode(body)?;
                if body.len() > MAX_VALUE {
                    bail!("cache value too large")
                }
                Operation::Commit {
                    key: key(value)?,
                    lease: key(lease)?,
                    value: body,
                    ttl: milliseconds(revalidate)?,
                    expire: milliseconds(expire)?,
                    tags: associations(tags, 1024, true)?,
                    paths: associations(paths, 8192, false)?,
                }
            }
            Self::Release { key: value, lease } => Operation::Release {
                key: key(value)?,
                lease: key(lease)?,
            },
            Self::Invalidate {
                tags,
                paths,
                mode,
                expire,
            } => Operation::Invalidate {
                tags: associations(tags, 1024, true)?,
                paths: associations(paths, 8192, false)?,
                mode,
                expire: milliseconds(expire)?,
            },
        })
    }
}

#[derive(Clone, Copy)]
struct Limits {
    entries: i64,
    bytes: i64,
    leases: i64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            entries: 8192,
            bytes: 64 * 1024 * 1024,
            leases: 256,
        }
    }
}
struct Database {
    connection: Connection,
    limits: Limits,
    last_cleanup: Option<i64>,
}

/// The configured cache budget is split between the data and page databases.
/// Zero disables retention of clean SQLite pages; active operations still allocate.
pub(crate) fn configure_memory(connection: &Connection, budget: Option<u64>) -> Result<()> {
    if let Some(bytes) = budget {
        let kib = i64::try_from(bytes / 2 / 1024)?;
        connection.pragma_update(None, "cache_size", -kib)?;
        connection.pragma_update(None, "mmap_size", 0)?;
    }
    Ok(())
}

impl Database {
    fn route_invalidation(
        &self,
        operation: &Operation,
    ) -> Result<Option<crate::pages::Invalidation>> {
        let Operation::Invalidate {
            tags,
            paths,
            mode,
            expire,
        } = operation
        else {
            return Ok(None);
        };
        let mut consumers = BTreeSet::new();
        let mut bytes = 0usize;
        let mut all = false;
        let mut statement=self.connection.prepare("SELECT DISTINCT p.token FROM cache_associations p WHERE p.kind=1 AND substr(p.token,1,5)='page:' AND p.key IN (SELECT key FROM cache_associations WHERE (kind=0 AND token IN (SELECT value FROM json_each(?1))) OR (kind=1 AND token IN (SELECT value FROM json_each(?2))))")?;
        let rows = statement.query_map(
            params![serde_json::to_string(tags)?, serde_json::to_string(paths)?],
            |row| row.get::<_, String>(0),
        )?;
        for row in rows {
            let path = row?;
            // A route pattern or layout ancestor is not a concrete consumer;
            // expanding it would invalidate unrelated pages sharing that parent.
            if path.contains('[') {
                continue;
            }
            bytes += path.len();
            if consumers.len() >= 4096 || bytes > 1024 * 1024 {
                all = true;
                consumers.clear();
                break;
            }
            consumers.insert(path);
        }
        Ok(Some(crate::pages::Invalidation {
            tags: tags.clone(),
            paths: paths.clone(),
            consumers: consumers.into_iter().collect(),
            all,
            stale: matches!(mode, InvalidateMode::Stale),
            expire: expire.map(|value| value as u64),
        }))
    }
    fn open(file: &Path, limits: Limits) -> Result<Self> {
        let parent = file.parent().context("cache directory missing")?;
        let mut directory = std::fs::DirBuilder::new();
        directory.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory.create(parent)?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        drop(options.open(file)?);
        let mut connection = Connection::open(file)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        // Only fixed SQL shapes are cached, never response bytes. Bound the
        // compilation cache independently of the number of keys or visitors.
        connection.set_prepared_statement_cache_capacity(32);
        connection.execute_batch("PRAGMA page_size=4096; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-2048; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=4194304; PRAGMA max_page_count=32768;
            CREATE TABLE IF NOT EXISTS cache_meta (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, access INTEGER NOT NULL, bytes INTEGER NOT NULL, entries INTEGER NOT NULL);
            INSERT OR IGNORE INTO cache_meta VALUES(1,0,0,0,0);
            CREATE TABLE IF NOT EXISTS cache_records (key TEXT PRIMARY KEY, value BLOB, value_size INTEGER NOT NULL DEFAULT 0, stored_at INTEGER NOT NULL DEFAULT 0, ttl INTEGER, stale_at INTEGER, hard_at INTEGER, touched INTEGER NOT NULL, lease TEXT, lease_until INTEGER, lease_generation INTEGER, lease_ttl INTEGER);
            CREATE TABLE IF NOT EXISTS cache_associations (key TEXT NOT NULL REFERENCES cache_records(key) ON DELETE CASCADE, kind INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY(key,kind,token));
            CREATE INDEX IF NOT EXISTS cache_association_token ON cache_associations(kind,token,key);
            CREATE INDEX IF NOT EXISTS cache_lru ON cache_records(touched);
            CREATE INDEX IF NOT EXISTS cache_leases ON cache_records(lease_until) WHERE lease IS NOT NULL;
            CREATE TRIGGER IF NOT EXISTS cache_record_insert AFTER INSERT ON cache_records BEGIN UPDATE cache_meta SET entries=entries+1,bytes=bytes+256+NEW.value_size WHERE id=1; END;
            CREATE TRIGGER IF NOT EXISTS cache_record_delete AFTER DELETE ON cache_records BEGIN UPDATE cache_meta SET entries=entries-1,bytes=bytes-256-OLD.value_size WHERE id=1; END;
            CREATE TRIGGER IF NOT EXISTS cache_record_value AFTER UPDATE OF value_size ON cache_records BEGIN UPDATE cache_meta SET bytes=bytes+NEW.value_size-OLD.value_size WHERE id=1; END;
            CREATE TRIGGER IF NOT EXISTS cache_assoc_insert AFTER INSERT ON cache_associations BEGIN UPDATE cache_meta SET bytes=bytes+192+2*length(CAST(NEW.token AS BLOB)) WHERE id=1; END;
            CREATE TRIGGER IF NOT EXISTS cache_assoc_delete AFTER DELETE ON cache_associations BEGIN UPDATE cache_meta SET bytes=bytes-192-2*length(CAST(OLD.token AS BLOB)) WHERE id=1; END;")?;
        // Compatible with existing databases; serialize the one-time migration.
        let migration = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let has_touch: bool = migration.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('cache_records') WHERE name='last_hit')",
            [],
            |row| row.get(0),
        )?;
        if !has_touch {
            migration.execute_batch(
                "ALTER TABLE cache_records ADD COLUMN last_hit INTEGER NOT NULL DEFAULT 0",
            )?;
        }
        migration.commit()?;
        Ok(Self {
            connection,
            limits,
            last_cleanup: None,
        })
    }

    fn execute(&mut self, operation: Operation, now: i64) -> Result<Value> {
        if matches!(operation, Operation::Generation) {
            let generation: i64 = self
                .connection
                .prepare_cached("SELECT generation FROM cache_meta WHERE id=1")?
                .query_row([], |row| row.get(0))?;
            return Ok(json!({"generation": generation}));
        }
        if let Some(result) = self.fresh(&operation, now)? {
            return Ok(result);
        }
        if let Operation::LeaseStatus { key, lease } = &operation {
            let valid: bool = self.connection.prepare_cached("SELECT EXISTS(SELECT 1 FROM cache_records WHERE key=?1 AND lease=?2 AND lease_until>?3 AND lease_generation=(SELECT generation FROM cache_meta WHERE id=1))")?.query_row(params![key, lease, now], |row| row.get(0))?;
            return Ok(json!({"valid": valid}));
        }
        let cleanup = self
            .last_cleanup
            .is_none_or(|last| now < last || now.saturating_sub(last) >= 1000);
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if cleanup {
            transaction.prepare_cached("UPDATE cache_records SET lease=NULL,lease_until=NULL,lease_generation=NULL,lease_ttl=NULL WHERE lease IS NOT NULL AND lease_until<=?")?.execute([now])?;
            transaction
                .prepare_cached("DELETE FROM cache_records WHERE value IS NULL AND lease IS NULL")?
                .execute([])?;
        }
        let result = match operation {
            Operation::Generation => unreachable!(),
            Operation::LeaseStatus { key, lease } => {
                let valid: bool = transaction.prepare_cached("SELECT EXISTS(SELECT 1 FROM cache_records WHERE key=?1 AND lease=?2 AND lease_until>?3 AND lease_generation=(SELECT generation FROM cache_meta WHERE id=1))")?.query_row(params![key, lease, now], |row| row.get(0))?;
                json!({"valid": valid})
            }
            Operation::Read {
                key,
                tags,
                paths,
                ttl,
                force_fresh,
                versioned,
            } => {
                // Resolve the namespace and acquire its lease in one transaction.
                // Invalidation still rejects obsolete commits; no revision is
                // cached in a worker and no second copy of the value is retained.
                let generation: Option<i64> = if versioned {
                    Some(
                        transaction
                            .prepare_cached("SELECT generation FROM cache_meta WHERE id=1")?
                            .query_row([], |row| row.get(0))?,
                    )
                } else {
                    None
                };
                let key = if let Some(generation) = generation {
                    format!(
                        "{:x}",
                        Sha256::digest(format!("prnext-versioned:{key}:{generation}"))
                    )
                } else {
                    key
                };
                let mut result = Self::read(
                    &transaction,
                    &key,
                    &tags,
                    &paths,
                    ttl,
                    force_fresh,
                    now,
                    self.limits,
                )?;
                if let Some(generation) = generation {
                    result["key"] = json!(key);
                    result["generation"] = json!(generation);
                }
                result
            }
            Operation::Commit {
                key,
                lease,
                value,
                ttl,
                expire,
                tags,
                paths,
            } => {
                let generation: i64 = transaction
                    .prepare_cached("SELECT generation FROM cache_meta WHERE id=1")?
                    .query_row([], |row| row.get(0))?;
                let current: Option<Option<i64>> = transaction.prepare_cached("SELECT lease_ttl FROM cache_records WHERE key=? AND lease=? AND lease_until>? AND lease_generation=?")?.query_row(params![key, lease, now, generation], |row| row.get(0)).optional()?;
                if let Some(lease_ttl) = current {
                    let ttl = minimum(ttl, lease_ttl);
                    Self::merge(&transaction, &key, &tags, &paths)?;
                    let overflow: bool = transaction.prepare_cached("SELECT EXISTS(SELECT 1 FROM cache_associations WHERE key=? GROUP BY kind HAVING count(*)>128)")?.query_row([&key], |row| row.get(0))?;
                    if overflow {
                        transaction
                            .prepare_cached("DELETE FROM cache_records WHERE key=?")?
                            .execute([&key])?;
                        transaction.commit()?;
                        return Ok(json!({"stored": false}));
                    }
                    transaction.prepare_cached("UPDATE cache_records SET value=?1,value_size=?2,stored_at=?3,ttl=?4,stale_at=NULL,hard_at=?6,lease=NULL,lease_until=NULL,lease_generation=NULL,lease_ttl=NULL WHERE key=?5")?.execute(params![value, value.len() as i64, now, ttl, key, expire.map(|duration| now.saturating_add(duration))])?;
                    Self::evict(&transaction, self.limits)?;
                    let stored = transaction.prepare_cached("SELECT EXISTS(SELECT 1 FROM cache_records WHERE key=? AND value IS NOT NULL)")?.query_row([&key], |row| row.get::<_, bool>(0))?;
                    json!({"stored": stored})
                } else {
                    json!({"stored": false})
                }
            }
            Operation::Release { key, lease } => {
                transaction.prepare_cached("UPDATE cache_records SET lease=NULL,lease_until=NULL,lease_generation=NULL,lease_ttl=NULL WHERE key=? AND lease=?")?.execute(params![key, lease])?;
                transaction
                    .prepare_cached(
                        "DELETE FROM cache_records WHERE key=? AND value IS NULL AND lease IS NULL",
                    )?
                    .execute([&key])?;
                json!({})
            }
            Operation::Invalidate {
                tags,
                paths,
                mode,
                expire,
            } => {
                transaction
                    .prepare_cached("UPDATE cache_meta SET generation=generation+1 WHERE id=1")?
                    .execute([])?;
                transaction.prepare_cached("UPDATE cache_records SET lease=NULL,lease_until=NULL,lease_generation=NULL,lease_ttl=NULL WHERE lease IS NOT NULL")?.execute([])?;
                transaction
                    .prepare_cached("DELETE FROM cache_records WHERE value IS NULL")?
                    .execute([])?;
                for (kind, values) in [(0, tags), (1, paths)] {
                    for token in values {
                        match mode {
                            InvalidateMode::Expire => {
                                transaction.prepare_cached("DELETE FROM cache_records WHERE key IN (SELECT key FROM cache_associations WHERE kind=? AND token=?)")?.execute(params![kind, token])?;
                            }
                            InvalidateMode::Stale => {
                                let hard = expire.map(|duration| now.saturating_add(duration));
                                transaction.prepare_cached("UPDATE cache_records SET stale_at=?1,hard_at=CASE WHEN ?2 IS NULL THEN hard_at WHEN hard_at IS NULL THEN ?2 ELSE min(hard_at,?2) END WHERE key IN (SELECT key FROM cache_associations WHERE kind=?3 AND token=?4)")?.execute(params![now, hard, kind, token])?;
                            }
                        }
                    }
                }
                json!({})
            }
        };
        transaction.commit()?;
        if cleanup {
            self.last_cleanup = Some(now);
        }
        Ok(result)
    }

    // Fresh hits are read-only for up to one second. The SQL snapshot checks
    // TTL, hard expiry, generation and every association; no per-key RAM cache
    // can hide an invalidation from another process. LRU touches are approximate.
    fn fresh(&mut self, operation: &Operation, now: i64) -> Result<Option<Value>> {
        let Operation::Read {
            key,
            tags,
            paths,
            ttl,
            versioned,
            ..
        } = operation
        else {
            return Ok(None);
        };
        let transaction = self.connection.transaction()?;
        let generation: Option<i64> = if *versioned {
            Some(
                transaction
                    .prepare_cached("SELECT generation FROM cache_meta WHERE id=1")?
                    .query_row([], |row| row.get(0))?,
            )
        } else {
            None
        };
        let resolved = generation.map(|generation| {
            format!(
                "{:x}",
                Sha256::digest(format!("prnext-versioned:{key}:{generation}"))
            )
        });
        let key = resolved.as_deref().unwrap_or(key);
        let value: Option<Vec<u8>> = transaction.prepare_cached("SELECT value FROM cache_records r WHERE key=?1 AND value IS NOT NULL
            AND last_hit<=?2 AND last_hit>?2-1000
            AND (ttl IS NULL OR ?2<stored_at+ttl) AND (stale_at IS NULL OR ?2<stale_at) AND (hard_at IS NULL OR ?2<hard_at)
            AND (?3 IS NULL OR (ttl IS NOT NULL AND ttl<=?3))
            AND NOT EXISTS(SELECT 1 FROM json_each(?4) t WHERE NOT EXISTS(SELECT 1 FROM cache_associations a WHERE a.key=r.key AND a.kind=0 AND a.token=t.value))
            AND NOT EXISTS(SELECT 1 FROM json_each(?5) p WHERE NOT EXISTS(SELECT 1 FROM cache_associations a WHERE a.key=r.key AND a.kind=1 AND a.token=p.value))")?
            .query_row(params![key, now, ttl, serde_json::to_string(tags)?, serde_json::to_string(paths)?], |row| row.get(0)).optional()?;
        Ok(value.map(|value| {
            let mut result = json!({"state":"fresh", "value":STANDARD.encode(value)});
            if let Some(generation) = generation {
                result["key"] = json!(key);
                result["generation"] = json!(generation);
            }
            result
        }))
    }

    #[allow(clippy::too_many_arguments)]
    fn read(
        transaction: &Transaction<'_>,
        key: &str,
        tags: &[String],
        paths: &[String],
        ttl: Option<i64>,
        force_fresh: bool,
        now: i64,
        limits: Limits,
    ) -> Result<Value> {
        transaction
            .prepare_cached("UPDATE cache_meta SET access=access+1 WHERE id=1")?
            .execute([])?;
        let touched: i64 = transaction
            .prepare_cached("SELECT access FROM cache_meta WHERE id=1")?
            .query_row([], |row| row.get(0))?;
        transaction
            .prepare_cached("INSERT OR IGNORE INTO cache_records(key,touched) VALUES(?,?)")?
            .execute(params![key, touched])?;
        Self::merge(transaction, key, tags, paths)?;
        let overflow: bool = transaction.prepare_cached("SELECT EXISTS(SELECT 1 FROM cache_associations WHERE key=? GROUP BY kind HAVING count(*)>128)")?.query_row([key], |row| row.get(0))?;
        if overflow {
            transaction
                .prepare_cached("DELETE FROM cache_records WHERE key=?")?
                .execute([key])?;
            transaction
                .prepare_cached("INSERT INTO cache_records(key,touched) VALUES(?,?)")?
                .execute(params![key, touched])?;
            Self::merge(transaction, key, tags, paths)?;
        }
        transaction.prepare_cached("UPDATE cache_records SET lease=NULL,lease_until=NULL,lease_generation=NULL,lease_ttl=NULL WHERE key=?1 AND lease_until<=?2")?.execute(params![key, now])?;
        transaction.prepare_cached("UPDATE cache_records SET last_hit=?4,touched=?1,ttl=CASE WHEN ?2 IS NULL THEN ttl WHEN ttl IS NULL THEN ?2 ELSE min(ttl,?2) END,lease_ttl=CASE WHEN ?2 IS NULL THEN lease_ttl WHEN lease_ttl IS NULL THEN ?2 ELSE min(lease_ttl,?2) END WHERE key=?3")?.execute(params![touched, ttl, key, now])?;
        transaction.prepare_cached("UPDATE cache_records SET value=NULL,value_size=0,stored_at=0,ttl=NULL,stale_at=NULL,hard_at=NULL WHERE key=? AND hard_at<=?")?.execute(params![key, now])?;
        let (present, fresh, active): (bool, bool, bool) = transaction.prepare_cached("SELECT value IS NOT NULL, value IS NOT NULL AND (ttl IS NULL OR ?1<stored_at+ttl) AND (stale_at IS NULL OR ?1<stale_at), lease IS NOT NULL FROM cache_records WHERE key=?2")?.query_row(params![now, key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        let mut lease = None;
        if !fresh && !active {
            let count: i64 = transaction
                .prepare_cached(
                    "SELECT count(*) FROM cache_records WHERE lease IS NOT NULL AND lease_until>?",
                )?
                .query_row([now], |row| row.get(0))?;
            if count < limits.leases {
                let token = random_token()?;
                transaction.prepare_cached("UPDATE cache_records SET lease=?1,lease_until=?2,lease_generation=(SELECT generation FROM cache_meta WHERE id=1),lease_ttl=CASE WHEN ?3 IS NULL THEN ttl WHEN ttl IS NULL THEN ?3 ELSE min(ttl,?3) END WHERE key=?4")?.execute(params![token, now.saturating_add(LEASE_MS), ttl, key])?;
                lease = Some(token);
            }
        }
        let result = if fresh || (present && !force_fresh) {
            let value: Vec<u8> = transaction
                .prepare_cached("SELECT value FROM cache_records WHERE key=?")?
                .query_row([key], |row| row.get(0))?;
            let mut result = json!({"state": if fresh {"fresh"} else {"stale"}, "value": STANDARD.encode(value)});
            if let Some(lease) = lease {
                result["lease"] = Value::String(lease);
            }
            result
        } else if let Some(lease) = lease {
            json!({"state": "miss", "lease": lease})
        } else {
            json!({"state": "pending", "retryAfterMs": 25})
        };
        Self::evict(transaction, limits)?;
        Ok(result)
    }
    fn merge(
        transaction: &Transaction<'_>,
        key: &str,
        tags: &[String],
        paths: &[String],
    ) -> Result<()> {
        let mut statement = transaction.prepare_cached(
            "INSERT OR IGNORE INTO cache_associations(key,kind,token) VALUES(?,?,?)",
        )?;
        for (kind, values) in [(0, tags), (1, paths)] {
            for token in values {
                statement.execute(params![key, kind, token])?;
            }
        }
        Ok(())
    }
    fn evict(transaction: &Transaction<'_>, limits: Limits) -> Result<()> {
        loop {
            let (entries, bytes): (i64, i64) = transaction
                .prepare_cached("SELECT entries,bytes FROM cache_meta WHERE id=1")?
                .query_row([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            if entries <= limits.entries && bytes <= limits.bytes {
                break;
            }
            transaction.prepare_cached("DELETE FROM cache_records WHERE key=(SELECT key FROM cache_records ORDER BY touched LIMIT 1)")?.execute([])?;
        }
        Ok(())
    }
}
fn minimum(first: Option<i64>, second: Option<i64>) -> Option<i64> {
    match (first, second) {
        (Some(first), Some(second)) => Some(first.min(second)),
        (first, second) => first.or(second),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_memory_cache_budget_can_disable_retention_without_disabling_storage() {
        let connection = Connection::open_in_memory().unwrap();
        for (bytes, expected_kib) in [(0, 0), (1024, 0), (1024 * 1024, -512)] {
            configure_memory(&connection, Some(bytes)).unwrap();
            let configured: i64 = connection
                .query_row("PRAGMA cache_size", [], |row| row.get(0))
                .unwrap();
            assert_eq!(configured, expected_kib);
            connection.execute_batch("CREATE TABLE IF NOT EXISTS durable(value INTEGER); INSERT INTO durable VALUES(42);").unwrap();
        }
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM durable", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn private_page_revalidation_requires_auth_and_has_independent_admission() {
        use tower::ServiceExt;
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(CacheState {
            memory_budget: None,
            file: directory.path().join("cache/data.sqlite3"),
            token: "a".repeat(64),
            database: Mutex::new(None),
            slots: Arc::new(Semaphore::new(8)),
            pages: Arc::new(OnceLock::new()),
            page_slots: Arc::new(Semaphore::new(5)),
        });
        let app = Router::new()
            .route("/pages/revalidate", post(revalidate_page))
            .with_state(state.clone());
        let request = |auth: bool| {
            let request = Request::builder().method("POST").uri("/pages/revalidate");
            let request = if auth {
                request.header(header::AUTHORIZATION, format!("Bearer {}", state.token))
            } else {
                request
            };
            request
                .body(Body::from(r#"{"path":"/missing","onlyGenerated":true}"#))
                .unwrap()
        };
        assert_eq!(
            app.clone().oneshot(request(false)).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        // Data-cache activity cannot consume page-revalidation admission or vice versa.
        let data = state.slots.clone().acquire_many_owned(8).await.unwrap();
        let reply = app.clone().oneshot(request(true)).await.unwrap();
        assert_eq!(reply.status(), StatusCode::OK);
        assert_eq!(reply.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            to_bytes(reply.into_body(), 1024).await.unwrap(),
            r#"{"revalidated":false}"#
        );
        let pages = state
            .page_slots
            .clone()
            .acquire_many_owned(5)
            .await
            .unwrap();
        assert_eq!(
            app.oneshot(request(true)).await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        drop(pages);
        drop(data);
        assert!(!state.file.exists());
    }
    use tower::ServiceExt;
    fn cache_key(index: u64) -> String {
        format!("{index:064x}")
    }
    fn operation(value: Value) -> Operation {
        serde_json::from_value::<CacheRequest>(value)
            .unwrap()
            .validate()
            .unwrap()
    }
    fn call(database: &mut Database, value: Value, now: i64) -> Value {
        database.execute(operation(value), now).unwrap()
    }
    fn read(database: &mut Database, index: u64, now: i64) -> Value {
        call(
            database,
            json!({"op":"read","key":cache_key(index),"tags":[],"paths":[],"revalidate":null}),
            now,
        )
    }
    fn commit(
        database: &mut Database,
        index: u64,
        lease: &Value,
        value: &[u8],
        ttl: Option<f64>,
        now: i64,
    ) -> Value {
        call(
            database,
            json!({"op":"commit","key":cache_key(index),"lease":lease,"value":STANDARD.encode(value),"revalidate":ttl}),
            now,
        )
    }
    fn database() -> (tempfile::TempDir, Database) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(
            &directory.path().join("cache/data.sqlite3"),
            Limits::default(),
        )
        .unwrap();
        (directory, database)
    }

    #[test]
    fn versioned_reads_follow_invalidation_atomically_and_reject_old_leases() {
        let (_directory, mut database) = database();
        let request = json!({"op":"read","key":cache_key(700),"versioned":true,"forceFresh":true,"tags":["ppr"]});
        let first = call(&mut database, request.clone(), 100);
        assert_eq!(first["generation"], 0);
        assert_eq!(first["state"], "miss");
        let commit = |read: &Value| json!({"op":"commit","key":read["key"],"lease":read["lease"],"value":STANDARD.encode(b"shell"),"tags":["ppr"]});
        assert_eq!(call(&mut database, commit(&first), 101)["stored"], true);
        let hit = call(&mut database, request.clone(), 102);
        assert_eq!(hit["state"], "fresh");
        assert_eq!(hit["value"], STANDARD.encode(b"shell"));
        assert_eq!(hit["key"], first["key"]);
        // Even a different tag changes the global namespace, matching PPR's
        // previous generation key semantics, without caching that generation.
        call(
            &mut database,
            json!({"op":"invalidate","tags":["other"],"mode":"expire"}),
            103,
        );
        let second = call(&mut database, request.clone(), 104);
        assert_eq!(second["generation"], 1);
        assert_eq!(second["state"], "miss");
        assert_ne!(second["key"], first["key"]);
        call(
            &mut database,
            json!({"op":"invalidate","tags":["ppr"],"mode":"expire"}),
            105,
        );
        assert_eq!(call(&mut database, commit(&second), 106)["stored"], false);
        let third = call(&mut database, request, 107);
        assert_eq!(third["generation"], 2);
        assert_ne!(third["key"], second["key"]);
        assert_eq!(call(&mut database, commit(&third), 108)["stored"], true);
        // Ordinary cache keys have no revision envelope and stay isolated.
        let ordinary = read(&mut database, 700, 109);
        assert_eq!(ordinary["state"], "miss");
        assert!(ordinary.get("generation").is_none());
    }

    #[test]
    fn external_cache_leases_detect_invalidation_expiry_and_release_without_storing_values() {
        let (_directory, mut database) = database();
        let first = read(&mut database, 501, 100);
        let status = |lease: &Value| json!({"op":"leaseStatus","key":cache_key(501),"lease":lease});
        assert_eq!(
            call(&mut database, status(&first["lease"]), 101)["valid"],
            true
        );
        assert_eq!(read(&mut database, 501, 101)["state"], "pending");
        call(
            &mut database,
            json!({"op":"invalidate","tags":["changed"],"mode":"expire"}),
            102,
        );
        assert_eq!(
            call(&mut database, status(&first["lease"]), 103)["valid"],
            false
        );
        let second = read(&mut database, 501, 104);
        assert_eq!(
            call(&mut database, status(&second["lease"]), 105)["valid"],
            true
        );
        assert_eq!(
            call(&mut database, status(&second["lease"]), 104 + LEASE_MS)["valid"],
            false
        );
        let third = read(&mut database, 501, 200 + LEASE_MS);
        call(
            &mut database,
            json!({"op":"release","key":cache_key(501),"lease":third["lease"]}),
            201 + LEASE_MS,
        );
        assert_eq!(
            call(&mut database, status(&third["lease"]), 202 + LEASE_MS)["valid"],
            false
        );
        let count: i64 = database
            .connection
            .query_row("SELECT COUNT(*) FROM cache_records", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
    fn seed(database: &mut Database, index: u64, now: i64) {
        let result = read(database, index, now);
        assert_eq!(
            commit(database, index, &result["lease"], b"cached", None, now)["stored"],
            true
        );
    }

    #[test]
    fn commit_tracks_discovered_tags_expiration_and_invalidation_races() {
        let (_directory, mut database) = database();
        let lease = read(&mut database, 1, 1000)["lease"].clone();
        let committed = call(
            &mut database,
            json!({"op":"commit","key":cache_key(1),"lease":lease,"value":STANDARD.encode(b"component"),"revalidate":1,"expire":2,"tags":["nested"],"paths":["page:/components"]}),
            1000,
        );
        assert_eq!(committed["stored"], true);
        assert_eq!(read(&mut database, 1, 1999)["state"], "fresh");
        assert_eq!(read(&mut database, 1, 2000)["state"], "stale");
        assert_eq!(read(&mut database, 1, 3000)["state"], "pending");
        call(
            &mut database,
            json!({"op":"invalidate","tags":["nested"],"mode":"expire"}),
            3001,
        );
        assert_eq!(read(&mut database, 1, 3002)["state"], "miss");
        let lease = read(&mut database, 2, 4000)["lease"].clone();
        call(
            &mut database,
            json!({"op":"invalidate","tags":["not-yet-discovered"],"mode":"expire"}),
            4001,
        );
        assert_eq!(
            call(
                &mut database,
                json!({"op":"commit","key":cache_key(2),"lease":lease,"value":STANDARD.encode(b"stale"),"tags":["not-yet-discovered"]}),
                4002
            )["stored"],
            false
        );
    }

    #[test]
    fn commit_bounds_combined_read_and_render_associations() {
        let (_directory, mut database) = database();
        let tags: Vec<String> = (0..128).map(|i| format!("read-{i}")).collect();
        let result = call(
            &mut database,
            json!({"op":"read","key":cache_key(1),"tags":tags}),
            1000,
        );
        assert_eq!(
            call(
                &mut database,
                json!({"op":"commit","key":cache_key(1),"lease":result["lease"],"value":STANDARD.encode(b"oversized"),"tags":["extra"]}),
                1001
            )["stored"],
            false
        );
        assert_eq!(read(&mut database, 1, 1002)["state"], "miss");
    }

    #[test]
    fn invalidation_expands_shared_data_consumers_without_layout_or_pattern_ancestors() {
        let (_directory, mut database) = database();
        let first = call(
            &mut database,
            json!({"op":"read","key":cache_key(1),"tags":["shared"],"paths":["page:/items/a","page:/items/[id]","layout:/","layout:/items"]}),
            1000,
        );
        commit(&mut database, 1, &first["lease"], b"value", None, 1000);
        call(
            &mut database,
            json!({"op":"read","key":cache_key(1),"tags":[],"paths":["page:/other","layout:/"]}),
            1001,
        );
        let unrelated = call(
            &mut database,
            json!({"op":"read","key":cache_key(2),"tags":["other"],"paths":["page:/unrelated","layout:/"]}),
            1002,
        );
        commit(&mut database, 2, &unrelated["lease"], b"value", None, 1002);
        for request in [
            json!({"op":"invalidate","tags":["shared"],"mode":"expire"}),
            json!({"op":"invalidate","paths":["page:/items/a"],"mode":"stale","expire":2}),
        ] {
            let invalid = database
                .route_invalidation(&operation(request))
                .unwrap()
                .unwrap();
            assert_eq!(invalid.consumers, vec!["page:/items/a", "page:/other"]);
            assert!(!invalid.all);
        }
    }

    #[test]
    fn persistent_values_and_cross_connection_leases_survive_restart() {
        let (directory, mut first) = database();
        seed(&mut first, 1, 1000);
        let pending = read(&mut first, 2, 1000);
        let mut second = Database::open(
            &directory.path().join("cache/data.sqlite3"),
            Limits::default(),
        )
        .unwrap();
        assert_eq!(
            read(&mut second, 1, 1001)["value"],
            STANDARD.encode(b"cached")
        );
        assert_eq!(read(&mut second, 2, 1001)["state"], "pending");
        assert_eq!(
            commit(
                &mut second,
                2,
                &pending["lease"],
                b"from another connection",
                None,
                1002
            )["stored"],
            true
        );
        drop(first);
        drop(second);
        let mut restarted = Database::open(
            &directory.path().join("cache/data.sqlite3"),
            Limits::default(),
        )
        .unwrap();
        assert_eq!(
            read(&mut restarted, 2, 1003)["value"],
            STANDARD.encode(b"from another connection")
        );
        assert_eq!(
            restarted
                .connection
                .query_row("PRAGMA cache_size", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            -2048
        );
        assert_eq!(
            restarted
                .connection
                .query_row("PRAGMA mmap_size", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn fresh_hits_do_not_write_and_external_invalidation_still_wins() {
        let (_directory, mut database) = database();
        seed(&mut database, 1, 1000);
        let before = database.connection.total_changes();
        for now in 1001..1100 {
            assert_eq!(read(&mut database, 1, now)["state"], "fresh");
        }
        assert_eq!(database.connection.total_changes(), before);
        let input = json!({"op":"read", "key":cache_key(1), "tags":["new-tag"], "revalidate":null});
        assert_eq!(call(&mut database, input.clone(), 1100)["state"], "fresh");
        assert!(database.connection.total_changes() > before);
        let file = database.connection.path().unwrap().to_owned();
        let mut other = Database::open(Path::new(&file), Limits::default()).unwrap();
        call(
            &mut other,
            json!({"op":"invalidate", "tags":["new-tag"], "mode":"expire"}),
            1101,
        );
        assert_eq!(call(&mut database, input, 1102)["state"], "miss");
    }

    #[test]
    fn sampled_lru_never_bypasses_shorter_ttl_or_expired_leases() {
        let (_directory, mut database) = database();
        seed(&mut database, 1, 1000);
        assert_eq!(
            call(
                &mut database,
                json!({"op":"read","key":cache_key(1),"revalidate":0.001}),
                1002
            )["state"],
            "stale"
        );
        let first = read(&mut database, 2, 1003);
        let renewed = read(&mut database, 2, 1003 + LEASE_MS);
        assert_eq!(renewed["state"], "miss");
        assert_ne!(first["lease"], renewed["lease"]);
    }

    #[test]
    fn ttl_stale_revalidation_has_one_lease_and_release_preserves_last_good() {
        let (_directory, mut database) = database();
        let first = read(&mut database, 1, 1000);
        assert_eq!(
            commit(&mut database, 1, &first["lease"], b"good", Some(1.0), 1000)["stored"],
            true
        );
        assert_eq!(read(&mut database, 1, 1999)["state"], "fresh");
        let stale = read(&mut database, 1, 2000);
        assert_eq!(stale["state"], "stale");
        assert!(stale["lease"].is_string());
        let follower = read(&mut database, 1, 2001);
        assert_eq!(follower["state"], "stale");
        assert!(follower.get("lease").is_none());
        let pending = call(
            &mut database,
            json!({"op":"read","key":cache_key(1),"forceFresh":true,"revalidate":null}),
            2002,
        );
        assert_eq!(pending["state"], "pending");
        assert!(pending.get("value").is_none());
        call(
            &mut database,
            json!({"op":"release","key":cache_key(1),"lease":stale["lease"]}),
            2003,
        );
        let retry = read(&mut database, 1, 2004);
        assert_eq!(retry["value"], STANDARD.encode(b"good"));
        assert!(retry["lease"].is_string());
        assert_eq!(
            commit(&mut database, 1, &retry["lease"], b"new", Some(1.0), 2004)["stored"],
            true
        );
        assert_eq!(
            call(
                &mut database,
                json!({"op":"read","key":cache_key(1),"forceFresh":true,"revalidate":null}),
                2005
            )["state"],
            "fresh"
        );
    }

    #[test]
    fn tag_path_merges_hard_expiry_and_generation_reject_obsolete_commits() {
        let (_directory, mut database) = database();
        seed(&mut database, 1, 1000);
        call(
            &mut database,
            json!({"op":"read","key":cache_key(1),"tags":["tag"],"paths":["page:/one"],"revalidate":null}),
            1001,
        );
        let obsolete = read(&mut database, 2, 1001);
        call(
            &mut database,
            json!({"op":"invalidate","tags":["tag"],"mode":"stale","expire":0.5}),
            1100,
        );
        assert_eq!(
            commit(
                &mut database,
                2,
                &obsolete["lease"],
                b"obsolete",
                None,
                1101
            )["stored"],
            false
        );
        let replacement = read(&mut database, 2, 1101);
        assert_ne!(replacement["lease"], obsolete["lease"]);
        assert_eq!(read(&mut database, 1, 1101)["state"], "stale");
        assert_eq!(read(&mut database, 1, 1600)["state"], "pending");
        call(
            &mut database,
            json!({"op":"invalidate","paths":["page:/one"],"mode":"expire"}),
            1601,
        );
        let fresh_miss = read(&mut database, 1, 1602);
        assert_eq!(fresh_miss["state"], "miss");
        assert_eq!(
            commit(
                &mut database,
                2,
                &replacement["lease"],
                b"obsolete again",
                None,
                1602
            )["stored"],
            false
        );
        let clean = read(&mut database, 2, 1603);
        assert!(clean["lease"].is_string());
        assert_eq!(
            commit(&mut database, 2, &clean["lease"], b"new", None, 1603)["stored"],
            true
        );
    }

    #[test]
    fn shorter_reader_ttl_affects_inflight_computation_and_association_overflow_evicts() {
        let (_directory, mut database) = database();
        let first = read(&mut database, 1, 1000);
        call(
            &mut database,
            json!({"op":"read","key":cache_key(1),"revalidate":0.25}),
            1001,
        );
        assert_eq!(
            commit(
                &mut database,
                1,
                &first["lease"],
                b"short",
                Some(100.0),
                1002
            )["stored"],
            true
        );
        assert_eq!(read(&mut database, 1, 1252)["state"], "stale");
        for (index, field) in [(2, "tags"), (3, "paths")] {
            let mut request = json!({"op":"read","key":cache_key(index),"revalidate":null});
            request[field] = json!((0..128)
                .map(|index| format!("entry-{index}"))
                .collect::<Vec<_>>());
            let lease = call(&mut database, request, 2000);
            assert_eq!(
                commit(&mut database, index, &lease["lease"], b"old", None, 2000)["stored"],
                true
            );
            let mut request = json!({"op":"read","key":cache_key(index),"revalidate":null});
            request[field] = json!(["new-association"]);
            let result = call(&mut database, request, 2001);
            assert_eq!(result["state"], "miss");
            assert!(result.get("value").is_none());
        }
    }

    #[test]
    fn leases_expire_are_bounded_and_stale_commit_cannot_release_new_owner() {
        let (_directory, mut database) = database();
        database.limits.leases = 1;
        let first = read(&mut database, 1, 1000);
        assert_eq!(read(&mut database, 2, 1001)["state"], "pending");
        let replacement = read(&mut database, 1, 31_000);
        assert_eq!(replacement["state"], "miss");
        assert_ne!(replacement["lease"], first["lease"]);
        call(
            &mut database,
            json!({"op":"release","key":cache_key(1),"lease":first["lease"]}),
            31_001,
        );
        assert_eq!(
            commit(&mut database, 1, &first["lease"], b"old", None, 31_002)["stored"],
            false
        );
        assert_eq!(
            commit(
                &mut database,
                1,
                &replacement["lease"],
                b"new",
                None,
                31_002
            )["stored"],
            true
        );
        assert_eq!(read(&mut database, 2, 31_003)["state"], "miss");
    }

    #[test]
    fn lru_entry_and_byte_bounds_include_associations_and_maintain_accounting() {
        let (_directory, mut database) = database();
        database.limits.entries = 2;
        seed(&mut database, 1, 1000);
        seed(&mut database, 2, 1000);
        // Touch sampling coalesces hits within one second; after that window
        // the recently read entry must survive eviction of an older entry.
        read(&mut database, 1, 2001);
        seed(&mut database, 3, 2002);
        assert_eq!(read(&mut database, 2, 2003)["state"], "miss");
        database.limits.bytes = 700;
        let lease = read(&mut database, 4, 1004);
        assert_eq!(
            commit(&mut database, 4, &lease["lease"], &[7; 600], None, 1004)["stored"],
            false
        );
        let (entries, bytes): (i64, i64) = database
            .connection
            .query_row("SELECT entries,bytes FROM cache_meta", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert!(entries <= 2);
        assert!((0..=700).contains(&bytes));
        let actual: i64 = database.connection.query_row("SELECT coalesce(sum(256+value_size),0)+(SELECT coalesce(sum(192+2*length(CAST(token AS BLOB))),0) FROM cache_associations) FROM cache_records", [], |row| row.get(0)).unwrap();
        assert_eq!(bytes, actual);
    }

    #[test]
    fn invalid_protocol_inputs_are_rejected_before_database_work() {
        for request in [
            json!({"op":"read","key":"oops"}),
            json!({"op":"read","key":cache_key(1),"revalidate":-1}),
            json!({"op":"read","key":cache_key(1),"tags":vec!["tag";129]}),
            json!({"op":"read","key":cache_key(1),"paths":["x".repeat(8193)]}),
            json!({"op":"read","key":cache_key(1),"extra":true}),
            json!({"op":"commit","key":cache_key(1),"lease":cache_key(2),"value":"%%%"}),
            json!({"op":"commit","key":cache_key(1),"lease":cache_key(2),"value":STANDARD.encode(vec![0;MAX_VALUE+1])}),
        ] {
            assert!(serde_json::from_value::<CacheRequest>(request)
                .map_err(anyhow::Error::from)
                .and_then(CacheRequest::validate)
                .is_err());
        }
    }

    #[tokio::test]
    async fn private_http_auth_body_limits_and_lazy_database_creation() {
        let directory = tempfile::tempdir().unwrap();
        let state = Arc::new(CacheState {
            memory_budget: None,
            file: directory.path().join("cache/data.sqlite3"),
            token: "a".repeat(64),
            database: Mutex::new(None),
            slots: Arc::new(Semaphore::new(8)),
            pages: Arc::new(OnceLock::new()),
            page_slots: Arc::new(Semaphore::new(5)),
        });
        let app = Router::new()
            .route("/cache", post(handle))
            .with_state(state.clone());
        for auth in [None, Some("Bearer wrong"), Some("Basic wrong")] {
            let mut request = Request::builder().method("POST").uri("/cache");
            if let Some(auth) = auth {
                request = request.header(header::AUTHORIZATION, auth);
            }
            assert_eq!(
                app.clone()
                    .oneshot(request.body(Body::from("{}")).unwrap())
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert!(!state.file.exists());
        let request = Request::builder()
            .method("POST")
            .uri("/cache")
            .header(header::AUTHORIZATION, format!("Bearer {}", state.token))
            .body(Body::from(vec![b'x'; MAX_BODY + 1]))
            .unwrap();
        assert_eq!(
            app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        assert!(!state.file.exists());
        let request = Request::builder()
            .method("POST")
            .uri("/cache")
            .header(header::AUTHORIZATION, format!("Bearer {}", state.token))
            .body(Body::from(
                json!({"op":"read","key":cache_key(1)}).to_string(),
            ))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let result: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(result["state"], "miss");
        assert!(state.file.exists());
    }

    #[test]
    fn empty_and_nul_tags_remain_exact_invalidation_tokens() {
        let (_directory, mut database) = database();
        for (index, tag) in [(1, ""), (2, "before\0after"), (3, "before")] {
            let lease = call(
                &mut database,
                json!({"op":"read","key":cache_key(index),"tags":[tag]}),
                1000,
            );
            assert_eq!(
                commit(&mut database, index, &lease["lease"], b"cached", None, 1000)["stored"],
                true
            );
        }
        call(
            &mut database,
            json!({"op":"invalidate","tags":["before\0after"],"mode":"expire"}),
            1001,
        );
        assert_eq!(read(&mut database, 2, 1002)["state"], "miss");
        assert_eq!(read(&mut database, 3, 1002)["state"], "fresh");
        assert_eq!(read(&mut database, 1, 1002)["state"], "fresh");
        call(
            &mut database,
            json!({"op":"invalidate","tags":[""],"mode":"expire"}),
            1003,
        );
        assert_eq!(read(&mut database, 1, 1004)["state"], "miss");
        assert_eq!(read(&mut database, 3, 1004)["state"], "fresh");
    }

    #[tokio::test]
    async fn unread_large_replies_hold_admission_until_consumed_or_dropped() {
        let (directory, mut database) = database();
        let first = read(&mut database, 1, 1000);
        assert_eq!(
            commit(
                &mut database,
                1,
                &first["lease"],
                &vec![7; MAX_VALUE],
                None,
                1000
            )["stored"],
            true
        );
        let state = Arc::new(CacheState {
            memory_budget: None,
            file: directory.path().join("cache/data.sqlite3"),
            token: "a".repeat(64),
            database: Mutex::new(Some(database)),
            slots: Arc::new(Semaphore::new(8)),
            pages: Arc::new(OnceLock::new()),
            page_slots: Arc::new(Semaphore::new(5)),
        });
        let app = Router::new()
            .route("/cache", post(handle))
            .with_state(state.clone());
        let request = || {
            Request::builder()
                .method("POST")
                .uri("/cache")
                .header(header::AUTHORIZATION, format!("Bearer {}", state.token))
                .body(Body::from(
                    json!({"op":"read","key":cache_key(1)}).to_string(),
                ))
                .unwrap()
        };
        let mut replies = Vec::new();
        for _ in 0..8 {
            let reply = app.clone().oneshot(request()).await.unwrap();
            assert_eq!(reply.status(), StatusCode::OK);
            replies.push(reply);
        }
        assert_eq!(state.slots.available_permits(), 0);
        assert_eq!(
            app.clone().oneshot(request()).await.unwrap().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        let mut body = replies.pop().unwrap().into_body().into_data_stream();
        let frame = std::future::poll_fn(|cx| Pin::new(&mut body).poll_next(cx))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.len(), RESPONSE_CHUNK_BYTES);
        assert_eq!(
            state.slots.available_permits(),
            0,
            "a first frame must not release response admission"
        );
        drop(frame);
        drop(body);
        assert_eq!(state.slots.available_permits(), 1);
        let replacement = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(replacement.status(), StatusCode::OK);
        assert_eq!(state.slots.available_permits(), 0);
        let bytes = to_bytes(replies.pop().unwrap().into_body(), MAX_BODY)
            .await
            .unwrap();
        let decoded: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            STANDARD.decode(decoded["value"].as_str().unwrap()).unwrap(),
            vec![7; MAX_VALUE]
        );
        assert_eq!(state.slots.available_permits(), 1);
        drop(replacement);
        drop(replies);
        assert_eq!(state.slots.available_permits(), 8);
    }
    #[test]
    fn shared_consumer_expansion_preserves_embedded_nul_tags() {
        let (_directory, mut database) = database();
        for (index, tag, path) in [
            (1, "tag\0a", "page:/a"),
            (2, "tag\0b", "page:/b"),
            (3, "tag", "page:/prefix"),
        ] {
            let value = call(
                &mut database,
                json!({"op":"read","key":cache_key(index),"tags":[tag],"paths":[path]}),
                1000,
            );
            commit(&mut database, index, &value["lease"], b"value", None, 1000);
        }
        for (tag, expected) in [("tag\0a", "page:/a"), ("tag", "page:/prefix")] {
            let invalid = database
                .route_invalidation(&operation(
                    json!({"op":"invalidate","tags":[tag],"mode":"expire"}),
                ))
                .unwrap()
                .unwrap();
            assert_eq!(invalid.consumers, vec![expected]);
        }
    }
}
