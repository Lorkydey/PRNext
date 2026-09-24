use crate::{
    manifest::{Manifest, Prerendered, Route, RouteKind},
    pool::{
        HeaderValues, PoolError, RenderedBody, RenderedResponse, WorkerConfig, WorkerPool,
        WorkerRequest, MAX_BODY_BYTES,
    },
    routing::{decode_path, Params, RoutePattern},
};
use anyhow::{bail, Context, Result};
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, Response, StatusCode, Uri},
    Router,
};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::Arc,
};
use tower::ServiceExt;
use tower_http::{compression::CompressionLayer, services::ServeFile, trace::TraceLayer};

mod adaptive;
mod admission;
mod branch_resolver;
mod file_cache;
mod small_file;

pub struct ServerConfig {
    pub root: PathBuf,
    pub hostname: String,
    pub port: u16,
    pub workers: usize,
    pub worker: PathBuf,
    pub node: PathBuf,
}

struct CompiledRoute {
    route: Route,
    pattern: RoutePattern,
}

struct RouteTable {
    exact: HashMap<String, Route>,
    dynamic: Vec<CompiledRoute>,
}

impl RouteTable {
    fn new(routes: Vec<Route>) -> Result<Self> {
        let mut exact = HashMap::new();
        let mut dynamic = Vec::new();
        for route in routes {
            if route.internal {
                continue;
            }
            let pattern = RoutePattern::parse(&route.pattern)?;
            if let Some(path) = pattern.static_path() {
                if exact.insert(path, route).is_some() {
                    bail!("duplicate exact route in build manifest");
                }
            } else {
                dynamic.push(CompiledRoute { route, pattern });
            }
        }
        dynamic.sort_by(|a, b| {
            b.pattern
                .specificity
                .cmp(&a.pattern.specificity)
                .then(a.route.pattern.cmp(&b.route.pattern))
        });
        Ok(Self { exact, dynamic })
    }

    fn resolve(&self, path: &str, parts: &[String]) -> Option<(&Route, Params)> {
        if let Some(route) = self.exact.get(path) {
            return Some((route, Params::new()));
        }
        self.dynamic.iter().find_map(|compiled| {
            compiled
                .pattern
                .matches(parts)
                .map(|params| (&compiled.route, params))
        })
    }
}

struct AppState {
    routing_resolver: Option<crate::pool::RoutingResolver>,
    images: Option<Arc<crate::images::Images>>,
    dist: PathBuf,
    public: Option<PathBuf>,
    assets: Option<PathBuf>,
    routes: RouteTable,
    prerendered: HashMap<String, Prerendered>,
    pool: WorkerPool,
    render_admission: admission::Admission,
    api_admission: admission::Admission,
    default_host: String,
    build_id: Option<String>,
    preview_mode_id: Option<String>,
    dev: Option<crate::dev::DevState>,
    pages: Option<Arc<crate::pages::PageCache>>,
    custom: crate::custom_routes::CompiledRoutes,
    proxy: crate::proxy::Proxy,
    middleware: Option<crate::middleware::Middleware>,
    config: crate::manifest::NativeConfig,
    errors: ErrorRoutes,
}

#[derive(Default)]
struct ErrorRoutes {
    localized: BTreeMap<String, ErrorRoutes>,
    not_found: Option<Route>,
    server_error: Option<Route>,
    error: Option<Route>,
    app_not_found: Option<Route>,
}
impl ErrorRoutes {
    fn route(&self, status: u16) -> Option<&Route> {
        if status == 404 {
            self.app_not_found
                .as_ref()
                .or(self.not_found.as_ref())
                .or(self.error.as_ref())
        } else {
            self.server_error.as_ref().or(self.error.as_ref())
        }
    }
}

pub async fn start(config: ServerConfig) -> Result<()> {
    if !(1..=64).contains(&config.workers) {
        bail!("--workers must be between 1 and 64");
    }
    let project = tokio::fs::canonicalize(&config.root)
        .await
        .context("project root does not exist")?;
    let dist = crate::build_directory::resolve(&project).await?;
    let manifest = Manifest::load(&dist).await?;
    let routes = RouteTable::new(manifest.routes.clone())?;
    let prerendered = manifest
        .prerendered
        .clone()
        .into_iter()
        .map(|page| {
            let path = format!("/{}", decode_path(&page.path)?.join("/"));
            Ok((path, page))
        })
        .collect::<Result<HashMap<_, _>>>()?;
    let host = if config.hostname.contains(':') {
        format!("[{}]:{}", config.hostname, config.port)
    } else {
        format!("{}:{}", config.hostname, config.port)
    };
    let cache_service =
        crate::cache::CacheService::start(&project, manifest.config.cache_max_memory_size).await?;
    let worker = WorkerConfig {
        node: config.node,
        script: config.worker,
        project: project.clone(),
        dist: dist.clone(),
        cache: Some(cache_service.credentials.clone()),
    };
    let pages = crate::pages::PageCache::new(&project, &dist, &manifest, worker.clone())?;
    if let Some(pages) = &pages {
        cache_service.set_pages(pages.clone());
    }
    let build_id = pages
        .as_ref()
        .map(|pages| pages.build_id().to_owned())
        .or_else(|| manifest.build_id.clone());
    let branch_resolver = if manifest
        .routes
        .iter()
        .any(|route| route.router.as_deref() == Some("app") && route.kind == RouteKind::Page)
    {
        Some(branch_resolver::Service::start().await?)
    } else {
        None
    };
    // Older builds and custom --worker scripts retain the stdio protocol.
    // Socket transport is opt-in so upgrading the native binary is safe.
    let worker_source = tokio::fs::read_to_string(&worker.script).await?;
    let lanes = if worker_source.lines().any(|line| {
        matches!(
            line,
            "// rustyx-transport:socket-v1" | "// rustyx-transport:socket-v2"
        )
    }) {
        if worker_source
            .lines()
            .any(|line| line == "// rustyx-concurrency:512")
        {
            512
        } else {
            16
        }
    } else {
        1
    };
    let render_pool = WorkerPool::new(worker.clone(), config.workers).concurrent(lanes);
    let render_admission = if lanes > 1 {
        admission::Admission::concurrent(config.workers, lanes.min(16))
    } else {
        admission::Admission::new(config.workers)
    };
    let mut api_admission = admission::Admission::concurrent(config.workers, lanes);
    api_admission.bodies = render_admission.bodies.clone();
    let state = Arc::new(AppState {
        routing_resolver: branch_resolver
            .as_ref()
            .map(|service| service.credentials.clone()),
        images: Some(Arc::new(crate::images::Images::new(
            project.clone(),
            dist.clone(),
            manifest.config.images.clone(),
            manifest.config.base_path.clone(),
            manifest.config.asset_base.clone(),
            format!(
                "http://{}:{}",
                if config.hostname.contains(':') {
                    format!(
                        "[{}]",
                        if config.hostname == "::" {
                            "::1"
                        } else {
                            &config.hostname
                        }
                    )
                } else if config.hostname == "0.0.0.0" {
                    "127.0.0.1".into()
                } else {
                    config.hostname.clone()
                },
                config.port
            ),
        ))),
        dev: manifest
            .dev
            .then(|| crate::dev::DevState::new(&project, manifest.build_id.as_deref())),
        errors: ErrorRoutes {
            localized: manifest
                .config
                .i18n
                .as_ref()
                .map(|config| {
                    config
                        .locales
                        .iter()
                        .map(|locale| {
                            let find = |id: &Option<String>| {
                                id.as_ref().and_then(|id| {
                                    let id = if locale == &config.default_locale {
                                        id.clone()
                                    } else {
                                        format!("{id}-locale-{locale}")
                                    };
                                    manifest.routes.iter().find(|route| route.id == id).cloned()
                                })
                            };
                            (
                                locale.clone(),
                                ErrorRoutes {
                                    not_found: find(&manifest.pages_errors.not_found),
                                    server_error: find(&manifest.pages_errors.server_error),
                                    error: find(&manifest.pages_errors.error),
                                    ..Default::default()
                                },
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
            not_found: manifest
                .routes
                .iter()
                .find(|route| Some(&route.id) == manifest.pages_errors.not_found.as_ref())
                .cloned(),
            server_error: manifest
                .routes
                .iter()
                .find(|route| Some(&route.id) == manifest.pages_errors.server_error.as_ref())
                .cloned(),
            error: manifest
                .routes
                .iter()
                .find(|route| Some(&route.id) == manifest.pages_errors.error.as_ref())
                .cloned(),
            app_not_found: manifest
                .routes
                .iter()
                .find(|route| Some(&route.id) == manifest.app_not_found.as_ref())
                .cloned(),
        },
        middleware: crate::middleware::Middleware::new(
            manifest.middleware.clone(),
            worker.clone(),
        )?
        .map(|middleware| {
            let middleware = middleware.with_bodies(render_admission.bodies.clone());
            if lanes > 1 {
                middleware.with_pool(render_pool.clone())
            } else {
                middleware
            }
        }),
        custom: crate::custom_routes::CompiledRoutes::new(manifest.custom_routes.clone())?,
        proxy: crate::proxy::Proxy::default(),
        config: manifest.config.clone(),
        public: tokio::fs::canonicalize(project.join("public")).await.ok(),
        assets: tokio::fs::canonicalize(dist.join("assets")).await.ok(),
        pool: render_pool,
        pages,
        render_admission,
        api_admission,
        dist,
        routes,
        prerendered,
        default_host: host,
        build_id,
        preview_mode_id: manifest.preview_mode_id.clone(),
    });
    if let Some(service) = &branch_resolver {
        service.attach(&state);
    }
    let dev_shutdown = state.dev.clone();
    let app = Router::new()
        .fallback(handle)
        .with_state(state)
        .layer(CompressionLayer::new().gzip(manifest.config.compress))
        .layer(TraceLayer::new_for_http().on_failure(|failure: tower_http::classify::ServerErrorsFailureClass, latency: std::time::Duration, _span: &tracing::Span| {
            // Admission 503s already carry Retry-After. Logging every refused
            // request amplifies overload; retain unexpected failures instead.
            if !matches!(failure, tower_http::classify::ServerErrorsFailureClass::StatusCode(code) if code == StatusCode::SERVICE_UNAVAILABLE) {
                tracing::error!(%failure, ?latency, "HTTP response failed");
            }
        }));
    let listener = tokio::net::TcpListener::bind((config.hostname.as_str(), config.port))
        .await
        .with_context(|| format!("cannot listen on {}:{}", config.hostname, config.port))?;
    let address = listener.local_addr()?;
    println!(
        "Rustyx {} · http://{address} · {} lazy render worker(s)",
        env!("CARGO_PKG_VERSION"),
        config.workers
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            if let Some(dev) = dev_shutdown {
                dev.close();
            }
        })
        .await?;
    Ok(())
}

async fn handle(State(state): State<Arc<AppState>>, request: Request) -> Response<Body> {
    let powered = state.config.powered_by_header;
    let mut response = match handle_inner(state, request).await {
        Ok(response) => response,
        Err(error) if error.is::<crate::custom_routes::UnsupportedRegexInput>() => error_response(
            StatusCode::BAD_REQUEST,
            "Custom route regex requires unsupported UTF-16 code-unit matching",
        ),
        Err(error) if error.is::<crate::pool::DocumentRequestTooLarge>() => error_response(
            StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
            "Document request context exceeds 64 KiB",
        ),
        Err(error) if error.is::<crate::pages::PageBusy>() => {
            let mut response = error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Page regeneration queue is full; retry shortly",
            );
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
            response
        }
        Err(error) => {
            tracing::error!(%error, "request failed");
            error_response(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
        }
    };
    if powered {
        response
            .headers_mut()
            .entry("x-powered-by")
            .or_insert(HeaderValue::from_static("Rustyx"));
    }
    response
}

#[derive(Clone, Default)]
struct RoutingContext {
    data: bool,
    compress: bool,
    original_url: Option<String>,
    rewrite: Option<serde_json::Value>,
    middleware_matched: bool,
    routing_request_headers: Option<Arc<BTreeMap<String, String>>>,
}
fn document_request(request: &Request) -> crate::pool::DocumentRequestSource<'_> {
    crate::pool::DocumentRequestSource {
        uri: request.uri(),
        method: request.method(),
        headers: request.headers(),
        original_url: request
            .extensions()
            .get::<RoutingContext>()
            .and_then(|context| context.original_url.as_deref()),
    }
}
async fn handle_inner(state: Arc<AppState>, mut request: Request) -> Result<Response<Body>> {
    use crate::custom_routes::MAX_URL;
    crate::middleware::strip_incoming(request.headers_mut());
    remember_action_origin(
        &mut request,
        &state.default_host,
        &state.config.server_actions.allowed_origins,
    );
    if request
        .uri()
        .path_and_query()
        .is_some_and(|value| value.as_str().len() > MAX_URL)
    {
        return Ok(error_response(
            StatusCode::URI_TOO_LONG,
            "Request URL exceeds 16 KiB",
        ));
    }
    let host = match request.headers().get(header::HOST) {
        Some(value) => match value.to_str() {
            Ok(value) => value,
            Err(_) => {
                return Ok(error_response(
                    StatusCode::BAD_REQUEST,
                    "Invalid Host header",
                ))
            }
        },
        None => &state.default_host,
    };
    if host.contains('@') || host.parse::<axum::http::uri::Authority>().is_err() {
        return Ok(error_response(
            StatusCode::BAD_REQUEST,
            "Invalid Host header",
        ));
    }
    let original_url = format!(
        "http://{host}{}",
        request
            .uri()
            .path_and_query()
            .map(|value| value.as_str())
            .unwrap_or("/")
    );
    let mut context = RoutingContext {
        compress: state.config.compress,
        original_url: (!state.config.base_path.is_empty()).then(|| original_url.clone()),
        ..Default::default()
    };
    // Restored App branches must re-run middleware under ingress credentials,
    // never under headers transformed for a different destination subtree.
    if request.headers().contains_key("x-rustyx-router-state") {
        let size: usize = request
            .headers()
            .iter()
            .map(|(key, value)| key.as_str().len() + value.len() + 4)
            .sum();
        if size > 64 * 1024 {
            return Ok(error_response(
                StatusCode::REQUEST_HEADER_FIELDS_TOO_LARGE,
                "Routing request headers exceed 64 KiB",
            ));
        }
        context.routing_request_headers = Some(Arc::new(request_headers(request.headers())));
    }
    // Priority redirects precede application redirects and middleware. Match
    // the original transport path so a JSON alias never becomes /page/ here.
    if let Some(location) = trailing_slash_location(&state.config, request.uri(), request.headers())
    {
        let mut response = Response::builder()
            .status(StatusCode::PERMANENT_REDIRECT)
            .header(header::LOCATION, location)
            .body(Body::empty())?;
        // Repeated-slash cleanup precedes all routing; trailing-slash redirects
        // follow configured headers, just like ordinary redirect rules.
        if !request.uri().path().contains("//") && !request.uri().path().contains('\\') {
            let mut headers = HeaderMap::new();
            for rule in &state.custom.headers {
                if let Some(params) = rule.captures(request.uri(), request.headers())? {
                    rule.headers(&params, &mut headers)?;
                }
            }
            apply_custom_headers(&mut response, headers);
        }
        return Ok(response);
    }
    // Browser data URLs carry a public build identifier. Resolve their page alias
    // through the same rewrite phases, while retaining the JSON response mode.
    let data_path = mounted_path(request.uri().path(), &state.config.base_path)
        .unwrap_or("")
        .to_owned();
    if data_path == "/_rustyx/dev" {
        if request
            .extensions()
            .get::<branch_resolver::Probe>()
            .is_some()
        {
            return Ok(error_response(StatusCode::NOT_FOUND, "Not an App page"));
        }
        return Ok(match &state.dev {
            Some(dev) => dev.response(request.method(), request.headers()),
            None => error_response(StatusCode::NOT_FOUND, "Not Found"),
        });
    }
    let parts = data_path
        .trim_matches('/')
        .split('/')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if parts
        .first()
        .is_some_and(|part| part == "_rustyx" || part == "_next")
        && parts.get(1).is_some_and(|part| part == "data")
    {
        let Some(build_id) = &state.build_id else {
            return Ok(data_not_found());
        };
        if !matches!(*request.method(), Method::GET | Method::HEAD)
            || parts.get(2).is_none_or(|build| build != build_id)
            || parts.len() < 4
        {
            return Ok(data_not_found());
        }
        // Retain original percent escapes for custom route matching.
        let mut raw = data_path
            .split('/')
            .skip(4)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let Some(last) = raw.last_mut() else {
            return Ok(data_not_found());
        };
        let Some(name) = last.strip_suffix(".json").filter(|name| !name.is_empty()) else {
            return Ok(data_not_found());
        };
        *last = name.to_owned();
        if raw.len() == 2
            && raw.last().is_some_and(|value| value == "index")
            && state
                .config
                .i18n
                .as_ref()
                .is_some_and(|config| config.locale(&raw[0]).is_some())
        {
            raw.pop();
        }
        if raw == ["index"] {
            raw.clear();
        } else if raw.first().is_some_and(|part| part == "index") {
            raw.remove(0);
        }
        let query = request
            .uri()
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default();
        *request.uri_mut() =
            format!("{}/{}{query}", state.config.base_path, raw.join("/")).parse()?;
        request
            .headers_mut()
            .insert("x-nextjs-data", HeaderValue::from_static("1"));
        context.data = true;
        context.original_url = Some(original_url.clone());
    }
    let app_path = state.config.i18n.is_some()
        && mounted_path(request.uri().path(), &state.config.base_path)
            .and_then(|path| decode_path(path).ok())
            .is_some_and(|parts| {
                state
                    .routes
                    .resolve(&format!("/{}", parts.join("/")), &parts)
                    .is_some_and(|(route, _)| route.router.as_deref() == Some("app"))
            });
    if let Some(i18n) = state.config.i18n.as_ref().filter(|_| !app_path) {
        if let Some(resolution) = i18n.resolve(
            request.uri(),
            request.headers(),
            &state.config.base_path,
            context.data,
        ) {
            match resolution {
                crate::i18n::Resolution::Redirect(location) => {
                    return Ok(Response::builder()
                        .status(StatusCode::TEMPORARY_REDIRECT)
                        .header(header::LOCATION, location)
                        .header(header::VARY, "Accept-Language, Cookie")
                        .body(Body::empty())?)
                }
                crate::i18n::Resolution::Rewrite(target) => {
                    context.original_url = Some(original_url.clone());
                    *request.uri_mut() = target.parse()?;
                }
            }
        }
    }
    let initial = request.uri().clone();
    let mut custom_headers = HeaderMap::new();
    for rule in &state.custom.headers {
        if let Some(params) = rule.captures(request.uri(), request.headers())? {
            rule.headers(&params, &mut custom_headers)?;
        }
    }
    for rule in &state.custom.redirects {
        if let Some(params) = rule.captures(request.uri(), request.headers())? {
            let target = rule.target(request.uri(), &params)?;
            let mut response = Response::builder()
                .status(rule.status())
                .header(header::LOCATION, &target.url)
                .body(Body::empty())?;
            apply_custom_headers(&mut response, custom_headers);
            return Ok(response);
        }
    }
    let mut middleware_headers = HeaderMap::new();
    // Retain the bounded upload allocation until the downstream route has
    // accepted or discarded it. Final streams use the worker pool's admission
    // guard, which is also released when its idle watchdog cancels a socket.
    let mut _middleware_admission = None;
    if let Some(middleware) = &state.middleware {
        if middleware.matches(request.uri(), request.headers())? {
            context.middleware_matched = true;
            let (next, mut rendered, permit) =
                match middleware.execute(request, &original_url).await {
                    Ok(result) => result,
                    Err(mut response) => {
                        apply_custom_headers(&mut response, custom_headers);
                        return Ok(*response);
                    }
                };
            request = next;
            let middleware_uri = request.uri().clone();
            let effects = crate::middleware::effects(
                std::mem::take(&mut rendered.headers),
                request.headers_mut(),
                &original_url,
                &middleware_uri,
                !state.config.skip_middleware_url_normalize,
            )?;
            match effects.action {
                crate::middleware::Action::Response => {
                    rendered.headers = crate::middleware::wire_headers(effects.headers)?;
                    let mut response = render_response(rendered, request.method() == Method::HEAD)?;
                    apply_custom_headers(&mut response, custom_headers);
                    drop(permit);
                    return Ok(response);
                }
                action => {
                    crate::middleware::drain_control(rendered.body).await?;
                    _middleware_admission = Some(permit);
                    middleware_headers = effects.headers;
                    context.original_url = Some(original_url.clone());
                    if let crate::middleware::Action::Rewrite(target) = action {
                        if target.external {
                            let mut response =
                                branch_resolver::forward_or_probe(&state, request, &target.url)
                                    .await?;
                            apply_final_headers(&mut response, custom_headers, middleware_headers);
                            return Ok(response);
                        }
                        *request.uri_mut() = target.url.parse()?;
                    }
                }
            }
        }
    }
    if state.custom.before.is_empty()
        && state.custom.after.is_empty()
        && state.custom.fallback.is_empty()
        && request.uri() == &initial
    {
        request.extensions_mut().insert(context);
        let mut response = handle_routed(state, request).await?;
        apply_final_headers(&mut response, custom_headers, middleware_headers);
        return Ok(response);
    }
    for rule in &state.custom.before {
        if let Some(params) = rule.captures(request.uri(), request.headers())? {
            let target = rule.target(request.uri(), &params)?;
            if target.external {
                let mut response =
                    branch_resolver::forward_or_probe(&state, request, &target.url).await?;
                apply_final_headers(&mut response, custom_headers, middleware_headers);
                return Ok(response);
            }
            *request.uri_mut() = target.url.split('#').next().unwrap_or("/").parse()?;
        }
    }
    let mut found = route_exists(
        &state,
        request.uri(),
        matches!(*request.method(), Method::GET | Method::HEAD),
        context.data,
        false,
    )
    .await?;
    if !found {
        for rule in &state.custom.after {
            if let Some(params) = rule.captures(request.uri(), request.headers())? {
                let target = rule.target(request.uri(), &params)?;
                if target.external {
                    let mut response =
                        branch_resolver::forward_or_probe(&state, request, &target.url).await?;
                    apply_final_headers(&mut response, custom_headers, middleware_headers);
                    return Ok(response);
                }
                *request.uri_mut() = target.url.split('#').next().unwrap_or("/").parse()?;
                if route_exists(
                    &state,
                    request.uri(),
                    matches!(*request.method(), Method::GET | Method::HEAD),
                    context.data,
                    true,
                )
                .await?
                {
                    found = true;
                    break;
                }
            }
        }
    }
    if !found {
        found = route_exists(
            &state,
            request.uri(),
            matches!(*request.method(), Method::GET | Method::HEAD),
            context.data,
            true,
        )
        .await?;
    }
    if !found {
        for rule in &state.custom.fallback {
            if let Some(params) = rule.captures(request.uri(), request.headers())? {
                let target = rule.target(request.uri(), &params)?;
                if target.external {
                    let mut response =
                        branch_resolver::forward_or_probe(&state, request, &target.url).await?;
                    apply_final_headers(&mut response, custom_headers, middleware_headers);
                    return Ok(response);
                }
                *request.uri_mut() = target.url.split('#').next().unwrap_or("/").parse()?;
                if route_exists(
                    &state,
                    request.uri(),
                    matches!(*request.method(), Method::GET | Method::HEAD),
                    context.data,
                    true,
                )
                .await?
                {
                    break;
                }
            }
        }
    }
    if request.uri() != &initial {
        context.original_url = Some(original_url);
        let target = mounted_path(request.uri().path(), &state.config.base_path)
            .unwrap_or(request.uri().path());
        let parts = decode_path(target)?;
        let path = format!("/{}", parts.join("/"));
        let params = state
            .routes
            .resolve(&path, &parts)
            .map(|(_, params)| params)
            .unwrap_or_default();
        context.rewrite = Some(
            serde_json::json!({"url":format!("{}{}", target, request.uri().query().map(|query|format!("?{query}")).unwrap_or_default()),"params":params}),
        );
    }
    request.extensions_mut().insert(context);
    let mut response = handle_routed(state, request).await?;
    apply_final_headers(&mut response, custom_headers, middleware_headers);
    Ok(response)
}
#[derive(Clone, Copy)]
struct PublicFile;
#[derive(Clone, Copy)]
struct RewritePrivate;
// Keep duplicate-cookie semantics aligned with CookieStore (last value wins).
// This check stays native: a normal cache HIT never starts a JavaScript worker.
fn is_draft_request(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(id) = state.preview_mode_id.as_deref() else {
        return false;
    };
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|header| header.to_str().ok())
        .flat_map(|header| header.split(';'))
        .filter_map(|part| part.trim().split_once('='))
        .rfind(|(name, _)| name.trim() == "__prerender_bypass")
        .is_some_and(|(_, value)| {
            percent_encoding::percent_decode_str(value.trim())
                .decode_utf8()
                .is_ok_and(|value| value == id)
        })
}
fn protect_draft_response(response: &mut Response<Body>) {
    response.extensions_mut().insert(RewritePrivate);
    for name in [
        header::ETAG,
        header::LAST_MODIFIED,
        header::ACCEPT_RANGES,
        header::CONTENT_RANGE,
    ] {
        response.headers_mut().remove(name);
    }
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache, no-store, max-age=0"),
    );
}
fn apply_final_headers(response: &mut Response<Body>, custom: HeaderMap, middleware: HeaderMap) {
    apply_custom_headers(response, custom);
    let private = response.extensions().get::<RewritePrivate>().is_some();
    for name in middleware.keys() {
        if name.as_str() == "x-rustyx-rewrite"
            || name.as_str().starts_with("x-middleware-") && name.as_str() != "x-middleware-rewrite"
            || private
                && matches!(
                    name.as_str(),
                    "cache-control"
                        | "etag"
                        | "last-modified"
                        | "accept-ranges"
                        | "content-range"
                        | "content-length"
                )
        {
            continue;
        }
        let mut values = middleware.get_all(name).iter().cloned().collect::<Vec<_>>();
        if name == header::SET_COOKIE || name == header::VARY {
            for value in response.headers().get_all(name) {
                if !values.contains(value) {
                    values.push(value.clone());
                }
            }
        }
        response.headers_mut().remove(name);
        for value in values {
            response.headers_mut().append(name.clone(), value);
        }
    }
}

fn trailing_slash_location(
    config: &crate::manifest::NativeConfig,
    uri: &Uri,
    headers: &HeaderMap,
) -> Option<String> {
    let path = uri.path();
    // Next normalizes repeated slashes/backslashes even when trailing slash
    // redirects are disabled. A Location starting // would change the origin.
    if path.contains("//") || path.contains('\\') {
        let mut normalized = String::with_capacity(path.len());
        let mut slash = false;
        for character in path.chars() {
            let character = if character == '\\' { '/' } else { character };
            if character != '/' || !slash {
                normalized.push(character);
            }
            slash = character == '/';
        }
        return Some(format!(
            "{normalized}{}",
            uri.query()
                .map(|query| format!("?{query}"))
                .unwrap_or_default()
        ));
    }
    if config.skip_trailing_slash_redirect {
        return None;
    }
    if path.trim_end_matches('/') == config.images.path.trim_end_matches('/') {
        return None;
    }
    let internal = mounted_path(path, &config.base_path)?;
    // Framework transports are not document URLs. Image and SSE requests
    // already have dedicated handlers and must not gain a routing slash.
    if matches!(
        internal.trim_end_matches('/'),
        "/_rustyx/dev" | "/_rustyx/image" | "/_next/image"
    ) {
        return None;
    }
    let target = if !config.trailing_slash {
        if path != "/" && path.ends_with('/') {
            path.trim_end_matches('/').to_owned()
        } else {
            return None;
        }
    } else if internal == "/" && !config.base_path.is_empty() {
        if path.ends_with('/') {
            return None;
        }
        format!("{path}/")
    } else {
        if internal == "/.well-known" || internal.starts_with("/.well-known/") {
            return None;
        }
        let last = internal.trim_end_matches('/').rsplit('/').next()?;
        if path.ends_with('/') {
            let extension = last.rsplit_once('.').map(|(_, extension)| extension);
            if headers.contains_key("x-nextjs-data")
                || extension.is_none_or(|value| {
                    value.is_empty()
                        || !value
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                })
            {
                return None;
            }
            path.trim_end_matches('/').to_owned()
        } else {
            if last.is_empty() || last.contains('.') {
                return None;
            }
            format!("{path}/")
        }
    };
    Some(format!(
        "{target}{}",
        uri.query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    ))
}

fn mounted_path<'a>(path: &'a str, base_path: &str) -> Option<&'a str> {
    if base_path.is_empty() {
        return Some(path);
    }
    let rest = path.strip_prefix(base_path)?;
    if rest.is_empty() {
        Some("/")
    } else if rest.starts_with('/') {
        Some(rest)
    } else {
        None
    }
}

fn asset_path(config: &crate::manifest::NativeConfig, path: &str) -> Option<String> {
    let base = if !config.asset_base.is_empty() {
        config.asset_base.clone()
    } else {
        format!(
            "{}/_rustyx/assets",
            if config.asset_prefix.is_empty() {
                &config.base_path
            } else {
                &config.asset_prefix
            }
            .trim_end_matches('/')
        )
    };
    let pathname = if base.starts_with("http://") || base.starts_with("https://") {
        reqwest::Url::parse(&base).ok()?.path().to_owned()
    } else {
        base
    };
    let relative = path.strip_prefix(&format!("{}/", pathname.trim_end_matches('/')))?;
    Some(format!("/_rustyx/assets/{relative}"))
}
fn apply_custom_headers(response: &mut Response<Body>, headers: HeaderMap) {
    let public = response.extensions().get::<PublicFile>().is_some();
    for name in headers.keys() {
        if name.as_str() == "x-rustyx-rewrite"
            || response.extensions().get::<RewritePrivate>().is_some()
                && matches!(
                    name.as_str(),
                    "etag" | "last-modified" | "accept-ranges" | "content-range" | "content-length"
                )
        {
            continue;
        }
        if name == header::VARY {
            for value in headers.get_all(name) {
                response.headers_mut().append(name.clone(), value.clone());
            }
        } else if !response.headers().contains_key(name) || public && name == header::CACHE_CONTROL
        {
            response.headers_mut().remove(name);
            for value in headers.get_all(name) {
                response.headers_mut().append(name.clone(), value.clone());
            }
        }
    }
}
async fn route_exists(
    state: &AppState,
    uri: &axum::http::Uri,
    is_read: bool,
    data: bool,
    dynamic: bool,
) -> Result<bool> {
    if !data
        && state
            .images
            .as_ref()
            .is_some_and(|images| images.matches(uri.path()))
    {
        return Ok(true);
    }
    let asset = (!data && is_read)
        .then(|| asset_path(&state.config, uri.path()))
        .flatten();
    let Some(internal) = asset
        .as_deref()
        .or_else(|| mounted_path(uri.path(), &state.config.base_path))
    else {
        return Ok(false);
    };
    let Ok(parts) = decode_path(internal) else {
        return Ok(false);
    };
    let path = format!("/{}", parts.join("/"));
    // Route existence is independent of its eventual status or fallback policy.
    if state.routes.exact.contains_key(&path) {
        return Ok(true);
    }
    if !data && is_read {
        if state.prerendered.contains_key(&path) {
            return Ok(true);
        }
        if let Some(root) = &state.public {
            if contained_file(root, path.trim_start_matches('/'))
                .await?
                .is_some()
            {
                return Ok(true);
            }
        }
        if let Some(relative) = path.strip_prefix("/_rustyx/assets/") {
            if let Some(root) = &state.assets {
                if contained_file(root, relative).await?.is_some() {
                    return Ok(true);
                }
            }
        }
    }
    Ok(dynamic && state.routes.resolve(&path, &parts).is_some())
}

async fn handle_routed(state: Arc<AppState>, mut request: Request) -> Result<Response<Body>> {
    if request
        .extensions()
        .get::<branch_resolver::Probe>()
        .is_some()
    {
        return branch_resolver::resolve(&state, request).await;
    }
    if let Some(images) = &state.images {
        if images.matches(request.uri().path()) {
            return Ok(images.handle(request).await);
        }
    }
    let data = request
        .extensions()
        .get::<RoutingContext>()
        .is_some_and(|context| context.data);
    let asset = (!data && matches!(*request.method(), Method::GET | Method::HEAD))
        .then(|| asset_path(&state.config, request.uri().path()))
        .flatten();
    let Some(internal) = asset
        .as_deref()
        .or_else(|| mounted_path(request.uri().path(), &state.config.base_path))
    else {
        return Ok(if data {
            data_not_found()
        } else {
            error_response(StatusCode::NOT_FOUND, "Not Found")
        });
    };
    let internal = format!(
        "{}{}",
        internal,
        request
            .uri()
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default()
    );
    *request.uri_mut() = internal.parse()?;
    let parts = match decode_path(request.uri().path()) {
        Ok(parts) => parts,
        Err(_) => {
            return Ok(error_response(
                StatusCode::BAD_REQUEST,
                "Invalid request path",
            ))
        }
    };
    let path = format!("/{}", parts.join("/"));
    let is_read = request.method() == Method::GET || request.method() == Method::HEAD;
    let draft = is_draft_request(&state, request.headers());
    let router_state = request
        .headers()
        .get("rsc")
        .is_some_and(|value| value == "1")
        && request.headers().contains_key("x-rustyx-router-state");
    let is_data = request
        .extensions()
        .get::<RoutingContext>()
        .is_some_and(|context| context.data);
    let explicit_app = state
        .routes
        .resolve(&path, &parts)
        .is_some_and(|(route, _)| route.router.as_deref() == Some("app"));
    if is_read
        && !explicit_app
        && ((!is_data && path == "/404" && state.errors.app_not_found.is_some())
            || path == "/500" && state.errors.route(500).is_some())
    {
        return serve_error_page(
            &state,
            request,
            if path == "/500" { 500 } else { 404 },
            BTreeMap::new(),
        )
        .await;
    }
    if is_data {
        if !is_read
            || state
                .routes
                .resolve(&path, &parts)
                .is_none_or(|(route, _)| {
                    route.kind != RouteKind::Page
                        || route.router.as_deref() == Some("app")
                        || !route.allows(&path)
                })
        {
            return Ok(data_not_found());
        }
        if state
            .routes
            .resolve(&path, &parts)
            .is_some_and(|(route, _)| route.ssg && !draft && !router_state)
        {
            let Some(pages) = &state.pages else {
                return Ok(data_not_found());
            };
            return match pages
                .select_request(&path, &parts, true, "GET", Some(document_request(&request)))
                .await
            {
                Ok(Some(selected)) => serve_page(&state, selected, request, true).await,
                Ok(None) => Ok(data_not_found()),
                Err(error)
                    if error.is::<crate::pages::PageBusy>()
                        || error.is::<crate::pool::DocumentRequestTooLarge>() =>
                {
                    Err(error)
                }
                Err(error) => {
                    tracing::error!(%error, "Pages data generation failed");
                    if let Some(failure) = error.downcast_ref::<crate::pages::PageGenerationError>()
                    {
                        request.extensions_mut().insert(failure.0.clone());
                    }
                    serve_error_page(&state, request, 500, BTreeMap::new()).await
                }
            };
        }
    }
    if parts.first().is_some_and(|s| s == "_rustyx") {
        if parts.get(1).is_some_and(|s| s == "assets") {
            if let Some(root) = &state.assets {
                let relative = path.strip_prefix("/_rustyx/assets/").unwrap_or("");
                if let Some(file) = contained_file(root, relative).await? {
                    return serve_file(
                        file,
                        request,
                        "public, max-age=31536000, immutable",
                        None,
                        true,
                    )
                    .await;
                }
            }
        }
        return serve_error_page(&state, request, 404, BTreeMap::new()).await;
    }
    if state
        .routes
        .resolve(&path, &parts)
        .is_some_and(|(route, _)| !route.allows(&path))
    {
        return serve_error_page(&state, request, 404, BTreeMap::new()).await;
    }
    if is_read && !is_data {
        if let Some(root) = &state.public {
            if let Some(file) = contained_file(root, path.trim_start_matches('/')).await? {
                return serve_file(
                    file,
                    request,
                    "public, max-age=0, must-revalidate",
                    None,
                    false,
                )
                .await;
            }
        }
        if state
            .routes
            .resolve(&path, &parts)
            .is_some_and(|(route, _)| route.ssg && !draft && !router_state)
        {
            if let Some(pages) = &state.pages {
                let crawler = request
                    .headers()
                    .get(header::USER_AGENT)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|agent| {
                        let agent = agent.to_ascii_lowercase();
                        ["bot", "crawler", "spider", "slurp", "facebookexternalhit"]
                            .iter()
                            .any(|name| agent.contains(name))
                    });
                match pages
                    .select_request(
                        &path,
                        &parts,
                        crawler,
                        if request.method() == Method::HEAD {
                            "HEAD"
                        } else {
                            "GET"
                        },
                        state
                            .routes
                            .resolve(&path, &parts)
                            .filter(|(route, _)| route.router.as_deref() != Some("app"))
                            .map(|_| document_request(&request)),
                    )
                    .await
                {
                    Ok(Some(selected)) => {
                        if selected.page.is_handler() {
                            return serve_handler(selected, request).await;
                        }
                        let flight = selected.page.is_app()
                            && request
                                .headers()
                                .get("rsc")
                                .is_some_and(|value| value == "1");
                        return serve_page(&state, selected, request, flight).await;
                    }
                    Ok(None) => {
                        return serve_error_page(&state, request, 404, BTreeMap::new()).await
                    }
                    Err(error) if error.is::<crate::pages::PageDynamic>() => {}
                    Err(error)
                        if !error.is::<crate::pages::PageBusy>()
                            && !error.is::<crate::pool::DocumentRequestTooLarge>()
                            && state
                                .routes
                                .resolve(&path, &parts)
                                .is_some_and(|(route, _)| {
                                    route.kind == RouteKind::Page
                                        && route.router.as_deref() != Some("app")
                                }) =>
                    {
                        tracing::error!(%error, "Pages generation failed");
                        if let Some(failure) =
                            error.downcast_ref::<crate::pages::PageGenerationError>()
                        {
                            request.extensions_mut().insert(failure.0.clone());
                        }
                        return serve_error_page(&state, request, 500, BTreeMap::new()).await;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        if let Some(page) = state.prerendered.get(&path).filter(|_| {
            !draft
                && !state
                    .routes
                    .resolve(&path, &parts)
                    .is_some_and(|(route, _)| route.router.as_deref() == Some("app"))
        }) {
            let file = contained_file(&state.dist, &page.file)
                .await?
                .context("prerendered file is missing or outside the build directory")?;
            return serve_file(
                file,
                request,
                "public, max-age=0, must-revalidate",
                Some(page),
                true,
            )
            .await;
        }
    }
    let Some((route, params)) = state.routes.resolve(&path, &parts) else {
        return serve_error_page(&state, request, 404, BTreeMap::new()).await;
    };
    let app_page = route.kind == RouteKind::Page && route.router.as_deref() == Some("app");
    let action_request = app_page && request.method() == Method::POST;
    if route.kind == RouteKind::Page && !is_read && !action_request {
        let mut response = error_response(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed");
        response.headers_mut().insert(
            header::ALLOW,
            HeaderValue::from_static(if app_page {
                "GET, HEAD, POST"
            } else {
                "GET, HEAD"
            }),
        );
        return Ok(response);
    }
    if action_request
        && !request_action_origin_allowed(
            &request,
            &state.default_host,
            &state.config.server_actions.allowed_origins,
        )
    {
        return Ok(error_response(
            StatusCode::FORBIDDEN,
            "Server Action origin does not match this host",
        ));
    }
    if route.kind == RouteKind::Page
        && !app_page
        && !draft
        && route.fallback.as_ref() == Some(&serde_json::Value::Bool(false))
    {
        return serve_error_page(&state, request, 404, BTreeMap::new()).await;
    }
    request_worker(&state, route, params, request, is_data, None).await
}

async fn request_worker(
    state: &AppState,
    route: &Route,
    params: Params,
    request: Request,
    is_data: bool,
    error_mode: Option<&str>,
) -> Result<Response<Body>> {
    let draft = is_draft_request(state, request.headers());
    let router_state = request
        .headers()
        .get("rsc")
        .is_some_and(|value| value == "1")
        && request.headers().contains_key("x-rustyx-router-state");
    let action_request = route.router.as_deref() == Some("app")
        && route.kind == RouteKind::Page
        && request.method() == Method::POST;
    // Reserve capacity before buffering a request body, so overload cannot
    // allocate unbounded request buffers outside the worker queue.
    let admission = if route.kind == RouteKind::Page {
        &state.render_admission
    } else {
        &state.api_admission
    };
    let slot = match admission.acquire().await {
        Ok(slot) => slot,
        Err(admission::AdmissionError::Timeout) => {
            return Ok(error_response(
                StatusCode::GATEWAY_TIMEOUT,
                "Render admission timed out",
            ));
        }
        Err(admission::AdmissionError::Full) => {
            let mut response = error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Render queue is full; retry shortly",
            );
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
            return Ok(response);
        }
    };
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or(&state.default_host);
    if host.parse::<axum::http::uri::Authority>().is_err() {
        return Ok(error_response(
            StatusCode::BAD_REQUEST,
            "Invalid Host header",
        ));
    }
    let url = format!(
        "http://{host}{}",
        request
            .uri()
            .path_and_query()
            .map(|v| v.as_str())
            .unwrap_or("/")
    );
    let original_url = request
        .extensions()
        .get::<RoutingContext>()
        .and_then(|context| context.original_url.clone());
    let data_rewrite = is_data
        .then(|| {
            request
                .extensions()
                .get::<RoutingContext>()
                .and_then(|context| context.rewrite.clone())
        })
        .flatten();
    let method = request.method().clone();
    let headers = request_headers(request.headers());
    let body_limit = if action_request {
        state.config.server_actions.body_size_limit
    } else {
        MAX_BODY_BYTES
    };
    let mut body_budget = match state
        .render_admission
        .bodies
        .request(&request, body_limit)
        .await
    {
        Ok(permit) => permit,
        Err(message) => return Ok(error_response(StatusCode::REQUEST_TIMEOUT, message)),
    };
    let (request_parts, request_body) = request.into_parts();
    let bytes = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        to_bytes(request_body, body_limit),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => {
            return Ok(error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                if action_request {
                    "Server Action body exceeds its configured limit or could not be read"
                } else {
                    "Request body exceeds 8 MiB or could not be read"
                },
            ))
        }
        Err(_) => {
            return Ok(error_response(
                StatusCode::REQUEST_TIMEOUT,
                "Request body timed out",
            ))
        }
    };
    body_budget.shrink_to(bytes.len());
    let worker_request = WorkerRequest {
        id: 0,
        route_id: route.id.clone(),
        method: method.to_string(),
        url,
        headers,
        routing_request_headers: (route.router.as_deref() == Some("app"))
            .then(|| {
                request_parts
                    .extensions
                    .get::<RoutingContext>()
                    .and_then(|context| context.routing_request_headers.as_deref().cloned())
            })
            .flatten(),
        body: crate::pool::WorkerBody::new(bytes, body_budget),
        params,
        stream: true,
        original_url,
        render_mode: error_mode
            .map(str::to_owned)
            .or_else(|| is_data.then(|| "data".to_owned())),
        revalidate_reason: None,
        document_request: None,
        routing_resolver: (route.router.as_deref() == Some("app") && router_state)
            .then(|| state.routing_resolver.clone())
            .flatten(),
        middleware_matched: request_parts
            .extensions
            .get::<RoutingContext>()
            .is_some_and(|context| context.middleware_matched),
        page_failure: (error_mode == Some("error500"))
            .then(|| {
                request_parts
                    .extensions
                    .get::<Arc<crate::pool::PageFailure>>()
                    .map(|failure| (**failure).clone())
            })
            .flatten(),
    };
    let started = admission.start_sample();
    let rendered = state.pool.request(worker_request, Some(slot)).await;
    admission.record(started, rendered.is_ok());
    match rendered {
        Ok(rendered)
            if rendered.page_error.is_some()
                && route.kind == RouteKind::Page
                && route.router.as_deref() != Some("app")
                && error_mode.is_none() =>
        {
            let status = rendered.page_error.unwrap();
            crate::middleware::drain_control(rendered.body).await?;
            Box::pin(serve_error_page(
                state,
                Request::from_parts(request_parts, Body::empty()),
                status,
                rendered.headers,
            ))
            .await
        }
        Ok(rendered) => match render_response(rendered, method == Method::HEAD) {
            Ok(mut response) => {
                if router_state {
                    response.headers_mut().append(
                        header::VARY,
                        HeaderValue::from_static("x-rustyx-router-state"),
                    );
                }
                if draft
                    || router_state
                    || response
                        .headers()
                        .get_all(header::SET_COOKIE)
                        .iter()
                        .any(|value| {
                            value
                                .to_str()
                                .is_ok_and(|value| value.starts_with("__prerender_bypass="))
                        })
                {
                    protect_draft_response(&mut response);
                }
                if let Some(rewrite) = data_rewrite.as_ref() {
                    mark_rewrite_private(&mut response, rewrite)?;
                }
                Ok(response)
            }
            Err(error) => {
                tracing::error!(%error, "invalid worker response");
                Ok(error_response(
                    StatusCode::BAD_GATEWAY,
                    "Invalid render response",
                ))
            }
        },
        Err(PoolError::Overloaded) => {
            let mut response = error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Render queue is full; retry shortly",
            );
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
            Ok(response)
        }
        Err(PoolError::Timeout) => Ok(error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "Render request timed out",
        )),
        Err(PoolError::Worker(error)) => {
            tracing::error!(%error, "render failed");
            Ok(error_response(
                StatusCode::BAD_GATEWAY,
                "Render worker failed",
            ))
        }
    }
}

async fn serve_error_page(
    state: &AppState,
    mut request: Request,
    status: u16,
    extra: BTreeMap<String, HeaderValues>,
) -> Result<Response<Body>> {
    let locale = state.config.i18n.as_ref().map(|config| {
        config
            .locale(
                mounted_path(request.uri().path(), &state.config.base_path)
                    .unwrap_or(request.uri().path())
                    .trim_start_matches('/')
                    .split('/')
                    .next()
                    .unwrap_or(""),
            )
            .unwrap_or(&config.default_locale)
    });
    let errors = locale
        .filter(|locale| {
            state.errors.app_not_found.is_none()
                || state
                    .config
                    .i18n
                    .as_ref()
                    .is_some_and(|config| *locale != config.default_locale)
        })
        .and_then(|locale| state.errors.localized.get(locale))
        .unwrap_or(&state.errors);
    let Some(route) = errors.route(status).or_else(|| state.errors.route(status)) else {
        return Ok(error_response(
            StatusCode::from_u16(status)?,
            if status == 404 {
                "Not Found"
            } else {
                "Internal Server Error"
            },
        ));
    };
    strip_file_conditions(request.headers_mut());
    let flight = route.router.as_deref() == Some("app")
        && request
            .headers()
            .get("rsc")
            .is_some_and(|value| value == "1");
    let draft = is_draft_request(state, request.headers());
    let selected = if route.ssg && !draft {
        if let Some(pages) = &state.pages {
            match pages
                .select_request(
                    &route.pattern,
                    &decode_path(&route.pattern)?,
                    true,
                    "GET",
                    (route.router.as_deref() != Some("app")).then(|| document_request(&request)),
                )
                .await
            {
                Ok(selected) => selected,
                Err(error)
                    if error.is::<crate::pages::PageBusy>()
                        || error.is::<crate::pool::DocumentRequestTooLarge>() =>
                {
                    return Err(error)
                }
                Err(error) => {
                    tracing::error!(%error, "error page generation failed");
                    return Ok(error_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Internal Server Error",
                    ));
                }
            }
        } else {
            None
        }
    } else {
        None
    };
    let mut response = if let Some(selected) = selected {
        let mut metadata = selected.page.metadata(flight);
        metadata.status = status;
        let mut response = serve_file(
            selected.page.file(flight),
            request,
            &selected.page.cache_control(),
            Some(&metadata),
            true,
        )
        .await?;
        response
            .headers_mut()
            .insert("x-nextjs-cache", HeaderValue::from_static(selected.state));
        if selected.page.is_app() {
            for field in ["RSC", "Next-Router-State-Tree", "Next-Router-Prefetch"] {
                append_vary(response.headers_mut(), field);
            }
        }
        let (parts, body) = response.into_parts();
        Response::from_parts(
            parts,
            Body::from_stream(PageBody {
                stream: body.into_data_stream(),
                _page: selected.page,
            }),
        )
    } else if let Some(page) = state.prerendered.get(&route.pattern).filter(|_| !draft) {
        let file = contained_file(&state.dist, &page.file)
            .await?
            .context("prerendered error page is missing")?;
        let mut metadata = page.clone();
        metadata.status = status;
        serve_file(
            file,
            request,
            "public, max-age=0, must-revalidate",
            Some(&metadata),
            true,
        )
        .await?
    } else {
        request_worker(
            state,
            route,
            Params::new(),
            request,
            false,
            Some(if status == 404 {
                "error404"
            } else {
                "error500"
            }),
        )
        .await?
    };
    let private = status == 500 || !extra.is_empty();
    for (name, values) in extra {
        if matches!(
            name.as_str(),
            "content-type"
                | "content-length"
                | "content-encoding"
                | "transfer-encoding"
                | "connection"
                | "etag"
                | "last-modified"
        ) {
            continue;
        }
        let name = HeaderName::from_bytes(name.as_bytes())?;
        for value in values.values() {
            if name == header::SET_COOKIE {
                response
                    .headers_mut()
                    .append(name.clone(), HeaderValue::from_str(value)?);
            } else {
                response
                    .headers_mut()
                    .insert(name.clone(), HeaderValue::from_str(value)?);
            }
        }
    }
    if private {
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-cache, no-store, max-age=0, must-revalidate"),
        );
        for name in [header::ETAG, header::LAST_MODIFIED, header::ACCEPT_RANGES] {
            response.headers_mut().remove(name);
        }
        response.extensions_mut().insert(RewritePrivate);
    }
    Ok(response)
}

fn data_not_found() -> Response<Body> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from("{\"notFound\":true}"))
        .unwrap()
}

async fn serve_handler(
    selected: crate::pages::Selection,
    mut request: Request,
) -> Result<Response<Body>> {
    let metadata = selected.page.handler_metadata();
    let configured = metadata
        .headers
        .get("cache-control")
        .and_then(HeaderValues::first);
    let cache = configured
        .map(str::to_owned)
        .unwrap_or_else(|| selected.page.cache_control());
    let has_type = metadata.headers.contains_key("content-type");
    // These are user response bytes, including when Content-Type is HTML.
    // Rewrites select the cached handler but never mutate its representation.
    let mut context = request
        .extensions()
        .get::<RoutingContext>()
        .cloned()
        .unwrap_or(RoutingContext {
            compress: true,
            ..Default::default()
        });
    context.rewrite = None;
    if metadata.headers.contains_key("content-encoding") {
        context.compress = false;
    }
    request.extensions_mut().insert(context);
    if metadata.status != 200 {
        strip_file_conditions(request.headers_mut());
    }
    let etag = metadata
        .headers
        .get("etag")
        .and_then(HeaderValues::first)
        .unwrap_or("");
    let conditional = request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok());
    let matched = conditional.is_some_and(|value| {
        value.split(',').any(|value| {
            value.trim() == "*"
                || value.trim().trim_start_matches("W/") == etag.trim_start_matches("W/")
        })
    });
    let mut response = if matched && metadata.status == 200 {
        let mut response = Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .body(Body::empty())?;
        for (name, values) in &metadata.headers {
            let name = HeaderName::try_from(name.as_str())?;
            for value in values.values() {
                response
                    .headers_mut()
                    .append(name.clone(), HeaderValue::try_from(value)?);
            }
        }
        response
            .headers_mut()
            .entry(header::CACHE_CONTROL)
            .or_insert(HeaderValue::try_from(&cache)?);
        if let Some(etag) = response
            .headers()
            .get(header::ETAG)
            .and_then(|value| value.to_str().ok())
            .filter(|etag| !etag.starts_with("W/"))
        {
            let etag = HeaderValue::from_str(&format!("W/{etag}"))?;
            response.headers_mut().insert(header::ETAG, etag);
        }
        response
    } else {
        if conditional.is_some() {
            request.headers_mut().remove(header::IF_MODIFIED_SINCE);
        }
        serve_file(
            selected.page.file(false),
            request,
            &cache,
            Some(&metadata),
            true,
        )
        .await?
    };
    if !has_type {
        response.headers_mut().remove(header::CONTENT_TYPE);
    }
    response
        .headers_mut()
        .insert("x-nextjs-cache", HeaderValue::from_static(selected.state));
    let (parts, body) = response.into_parts();
    Ok(Response::from_parts(
        parts,
        Body::from_stream(PageBody {
            stream: body.into_data_stream(),
            _page: selected.page,
        }),
    ))
}

async fn serve_page(
    state: &AppState,
    selected: crate::pages::Selection,
    mut request: Request,
    data: bool,
) -> Result<Response<Body>> {
    let rewrite = request
        .extensions()
        .get::<RoutingContext>()
        .and_then(|context| context.rewrite.clone());
    let mut page = selected.page.metadata(data);
    if !data
        && !selected.page.is_app()
        && page.status == 404
        && !state
            .errors
            .route(404)
            .is_some_and(|route| route.pattern == request.uri().path())
    {
        return serve_error_page(state, request, 404, BTreeMap::new()).await;
    }
    if data
        && !selected.page.is_app()
        && state
            .errors
            .not_found
            .as_ref()
            .is_some_and(|route| route.pattern == request.uri().path())
    {
        page.status = 200;
    }
    if request
        .extensions()
        .get::<RoutingContext>()
        .is_some_and(|context| context.rewrite.is_some())
    {
        strip_file_conditions(request.headers_mut());
    }
    if page.status != 200 {
        for name in [
            header::RANGE,
            header::IF_RANGE,
            header::IF_MODIFIED_SINCE,
            header::IF_UNMODIFIED_SINCE,
            header::IF_NONE_MATCH,
            header::IF_MATCH,
        ] {
            request.headers_mut().remove(name);
        }
    }
    let cache = selected.page.cache_control();
    let etag = page
        .headers
        .get("etag")
        .and_then(HeaderValues::first)
        .unwrap();
    let conditional = request
        .headers()
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok());
    let matched = conditional.is_some_and(|value| {
        value.split(',').any(|value| {
            let value = value.trim();
            value == "*" || value.trim_start_matches("W/") == etag.trim_start_matches("W/")
        })
    });
    let mut response = if matched && page.status == 200 && !selected.fallback {
        Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, etag)
            .header(header::CACHE_CONTROL, cache.as_str())
            .header(header::VARY, "Accept-Encoding")
            .body(Body::empty())?
    } else {
        // If-None-Match takes precedence over the lower-resolution mtime.
        if conditional.is_some() {
            request.headers_mut().remove(header::IF_MODIFIED_SINCE);
        }
        serve_file(selected.page.file(data), request, &cache, Some(&page), true).await?
    };
    response
        .headers_mut()
        .insert("x-nextjs-cache", HeaderValue::from_static(selected.state));
    if let Some(rewrite) = rewrite {
        response.headers_mut().insert(
            "x-rustyx-rewrite",
            HeaderValue::from_str(
                &percent_encoding::utf8_percent_encode(
                    &serde_json::to_string(&rewrite)?,
                    percent_encoding::NON_ALPHANUMERIC,
                )
                .to_string(),
            )?,
        );
    }
    if selected.page.is_app() {
        for field in ["RSC", "Next-Router-State-Tree", "Next-Router-Prefetch"] {
            append_vary(response.headers_mut(), field);
        }
    }
    // An evicted generation remains on disk until all responses that selected
    // it finish, including a socket still streaming its HTML or JSON file.
    let (parts, body) = response.into_parts();
    Ok(Response::from_parts(
        parts,
        Body::from_stream(PageBody {
            stream: body.into_data_stream(),
            _page: selected.page,
        }),
    ))
}

struct PageBody {
    stream: axum::body::BodyDataStream,
    _page: Arc<crate::pages::Page>,
}
impl futures_core::Stream for PageBody {
    type Item = std::result::Result<axum::body::Bytes, axum::Error>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.stream).poll_next(cx)
    }
}

#[derive(Clone, Copy)]
struct OriginalActionOrigin(bool);

fn remember_action_origin(request: &mut Request, default_host: &str, allowed_origins: &[String]) {
    if request.method() == Method::POST {
        let allowed =
            action_origin_allowed_with_options(request.headers(), default_host, allowed_origins);
        request
            .extensions_mut()
            .insert(OriginalActionOrigin(allowed));
    }
}

fn request_action_origin_allowed(
    request: &Request,
    default_host: &str,
    allowed_origins: &[String],
) -> bool {
    request
        .extensions()
        .get::<OriginalActionOrigin>()
        .map(|origin| origin.0)
        .unwrap_or_else(|| {
            action_origin_allowed_with_options(request.headers(), default_host, allowed_origins)
        })
}

fn action_origin_allowed_with_options(
    headers: &HeaderMap,
    default_host: &str,
    allowed: &[String],
) -> bool {
    if action_origin_allowed(headers, default_host) {
        return true;
    }
    if allowed.is_empty() || headers.get_all(header::ORIGIN).iter().count() != 1 {
        return false;
    }
    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Ok(origin) = origin.parse::<axum::http::Uri>() else {
        return false;
    };
    let default_port = match origin.scheme_str() {
        Some("http") => 80,
        Some("https") => 443,
        _ => return false,
    };
    if origin.query().is_some() || !matches!(origin.path(), "" | "/") {
        return false;
    }
    let Some(authority) = origin.authority() else {
        return false;
    };
    if authority.as_str().contains('@') {
        return false;
    }
    let host = match authority.port_u16() {
        Some(port) if port != default_port => format!("{}:{port}", authority.host()),
        _ => authority.host().to_owned(),
    };
    allowed
        .iter()
        .any(|pattern| action_host_matches(&host, pattern))
}

fn action_host_matches(host: &str, pattern: &str) -> bool {
    if host.eq_ignore_ascii_case(pattern) {
        return true;
    }
    let host: Vec<_> = host.split('.').collect();
    let pattern: Vec<_> = pattern.split('.').collect();
    if pattern.len() < 2 || host.len() < pattern.len() {
        return false;
    }
    let mut position = host.len();
    for (index, part) in pattern.iter().enumerate().rev() {
        position -= 1;
        if *part == "**" {
            return index == 0 && !host[position].is_empty();
        }
        if part.is_empty()
            || (*part == "*" && host[position].is_empty())
            || (*part != "*" && !part.eq_ignore_ascii_case(host[position]))
        {
            return false;
        }
    }
    position == 0
}

// Browsers supply Origin for action POSTs. Allow clients without Origin (such
// as server-to-server calls), but never a browser that reports cross-site use.
// A reverse proxy must replace X-Forwarded-Host with the original public host.
fn action_origin_allowed(headers: &HeaderMap, default_host: &str) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return !headers
            .get("sec-fetch-site")
            .is_some_and(|value| value == "cross-site");
    };
    if headers.get_all(header::ORIGIN).iter().count() != 1 {
        return false;
    }
    let Ok(origin) = origin
        .to_str()
        .ok()
        .unwrap_or("")
        .parse::<axum::http::Uri>()
    else {
        return false;
    };
    let default_port = match origin.scheme_str() {
        Some("http") => 80,
        Some("https") => 443,
        _ => return false,
    };
    if origin.query().is_some() || !matches!(origin.path(), "" | "/") {
        return false;
    }
    let Some(origin_host) = origin.authority() else {
        return false;
    };
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST));
    let host = match host {
        Some(value) => match value.to_str() {
            Ok(value) => value.split(',').next().unwrap_or("").trim(),
            Err(_) => return false,
        },
        None => default_host,
    };
    let Ok(host) = host.parse::<axum::http::uri::Authority>() else {
        return false;
    };
    !origin_host.as_str().contains('@')
        && !host.as_str().contains('@')
        && origin_host.host().eq_ignore_ascii_case(host.host())
        && origin_host.port_u16().unwrap_or(default_port) == host.port_u16().unwrap_or(default_port)
}

async fn serve_file(
    file: PathBuf,
    mut request: Request,
    cache: &str,
    page: Option<&Prerendered>,
    build_output: bool,
) -> Result<Response<Body>> {
    let context = request
        .extensions()
        .get::<RoutingContext>()
        .cloned()
        .unwrap_or(RoutingContext {
            compress: true,
            ..Default::default()
        });
    let rewrite = context.rewrite.as_ref().filter(|_| page.is_some());
    let html = rewrite.is_some()
        && page
            .and_then(|page| page.headers.get("content-type"))
            .and_then(HeaderValues::first)
            .is_none_or(|value| value.starts_with("text/html"));
    let head = request.method() == Method::HEAD;
    if rewrite.is_some() {
        strip_file_conditions(request.headers_mut());
    }
    // ServeFile does not evaluate If-Range. Returning the complete selected
    // representation is valid when its validator cannot be established, and
    // avoids joining an identity prefix to a compressed representation suffix.
    if request.headers().contains_key(header::IF_RANGE) {
        request.headers_mut().remove(header::RANGE);
    }
    let precompressed = build_output && context.compress && !html;
    let mut response =
        match small_file::response(&file, request.method(), request.headers(), precompressed)
            .await?
        {
            Some(response) => response,
            None => {
                let mut service = ServeFile::new(&file);
                if precompressed
                    && small_file::simple_gzip(request.headers()) != Some(false)
                    && fresh_gzip_sidecar(&file).await?
                {
                    service = service.precompressed_gzip();
                }
                match service.oneshot(request).await {
                    Ok(response) => response.map(Body::new),
                    Err(error) => match error {},
                }
            }
        };
    if response.status().is_success() || response.status() == StatusCode::NOT_MODIFIED {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_str(cache)?);
        if let Some(page) = page {
            if response.status() == StatusCode::OK {
                *response.status_mut() = StatusCode::from_u16(page.status)?;
            }
            for (name, value) in &page.headers {
                let name = HeaderName::try_from(name.as_str())?;
                if !is_hop_header(&name) && name != header::CONTENT_LENGTH {
                    response.headers_mut().remove(&name);
                    for value in value.values() {
                        response
                            .headers_mut()
                            .append(name.clone(), HeaderValue::try_from(value)?);
                    }
                }
            }
        }
    }
    if build_output {
        append_vary(response.headers_mut(), "Accept-Encoding");
    }
    // A user-supplied strong tag describes the identity bytes. It cannot remain
    // strong after selecting a compressed representation of the same document.
    if build_output || response.headers().contains_key(header::CONTENT_ENCODING) {
        if let Some(etag) = response
            .headers()
            .get(header::ETAG)
            .and_then(|etag| etag.to_str().ok())
        {
            if !etag.starts_with("W/") {
                let weak = HeaderValue::from_str(&format!("W/{etag}"))?;
                response.headers_mut().insert(header::ETAG, weak);
            }
        }
    }
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    if !build_output {
        response.extensions_mut().insert(PublicFile);
    }
    if let Some(rewrite) = rewrite {
        let metadata = mark_rewrite_private(&mut response, rewrite)?;
        if html && !head {
            response = insert_rewrite_marker(response, &metadata);
        }
    }
    Ok(response)
}

fn mark_rewrite_private(
    response: &mut Response<Body>,
    rewrite: &serde_json::Value,
) -> Result<String> {
    response.extensions_mut().insert(RewritePrivate);
    let metadata = serde_json::to_string(rewrite)?;
    response.headers_mut().insert(
        "x-rustyx-rewrite",
        HeaderValue::from_str(
            &percent_encoding::utf8_percent_encode(&metadata, percent_encoding::NON_ALPHANUMERIC)
                .to_string(),
        )?,
    );
    for name in [
        header::ETAG,
        header::LAST_MODIFIED,
        header::CONTENT_LENGTH,
        header::ACCEPT_RANGES,
        header::CONTENT_RANGE,
    ] {
        response.headers_mut().remove(name);
    }
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-cache, no-store, max-age=0, must-revalidate"),
    );
    Ok(metadata)
}
fn strip_file_conditions(headers: &mut HeaderMap) {
    for header in [
        header::RANGE,
        header::IF_RANGE,
        header::IF_NONE_MATCH,
        header::IF_MATCH,
        header::IF_MODIFIED_SINCE,
        header::IF_UNMODIFIED_SINCE,
    ] {
        headers.remove(header);
    }
}
fn insert_rewrite_marker(response: Response<Body>, metadata: &str) -> Response<Body> {
    use futures_util::StreamExt;
    let safe = metadata
        .replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    let marker =
        format!("<script id=\"__RUSTYX_REWRITE__\" type=\"application/json\">{safe}</script>")
            .into_bytes();
    let (parts, body) = response.into_parts();
    let stream = futures_util::stream::unfold(
        (
            body.into_data_stream(),
            Vec::<u8>::new(),
            Some(marker),
            false,
        ),
        |(mut input, mut tail, mut marker, mut done)| async move {
            if done {
                return None;
            }
            loop {
                match input.next().await {
                    Some(Ok(bytes)) => {
                        tail.extend_from_slice(&bytes);
                        if tail.len() > 16 * 1024 {
                            let remainder = tail.split_off(tail.len() - 16 * 1024);
                            let output = std::mem::replace(&mut tail, remainder);
                            return Some((
                                Ok(axum::body::Bytes::from(output)),
                                (input, tail, marker, done),
                            ));
                        }
                    }
                    Some(Err(error)) => return Some((Err(error), (input, Vec::new(), None, true))),
                    None => {
                        let marker = marker.take().unwrap_or_default();
                        let position = tail
                            .windows(7)
                            .rposition(|value| value.eq_ignore_ascii_case(b"</body>"))
                            .unwrap_or(tail.len());
                        tail.splice(position..position, marker);
                        done = true;
                        return Some((
                            Ok(axum::body::Bytes::from(tail)),
                            (input, Vec::new(), None, done),
                        ));
                    }
                }
            }
        },
    );
    // Compressors may ask for EOF more than once while flushing their trailer.
    // `unfold` panics if polled again after None unless its termination is fused.
    Response::from_parts(parts, Body::from_stream(stream.fuse()))
}

async fn fresh_gzip_sidecar(file: &Path) -> Result<bool> {
    let file = file.to_path_buf();
    tokio::task::spawn_blocking(move || fresh_gzip_sidecar_sync(&file))
        .await
        .context("gzip sidecar check failed")?
        .map_err(Into::into)
}

fn fresh_gzip_sidecar_sync(file: &Path) -> std::io::Result<bool> {
    let Some(parent) = file.parent() else {
        return Ok(false);
    };
    let mut sibling = file.as_os_str().to_owned();
    sibling.push(".gz");
    let gzip = match std::fs::canonicalize(sibling) {
        Ok(gzip) => gzip,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound
                    | std::io::ErrorKind::NotADirectory
                    | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            return Ok(false)
        }
        Err(error) => return Err(error),
    };
    if !gzip.starts_with(parent) {
        return Ok(false);
    }
    let compressed = std::fs::metadata(gzip)?;
    let original = std::fs::metadata(file)?;
    // Build normalizes both timestamps with the same filesystem operation.
    // Editing a built source file invalidates its stale compressed sibling.
    Ok(compressed.is_file()
        && compressed
            .modified()
            .ok()
            .zip(original.modified().ok())
            .is_some_and(|(compressed, original)| compressed == original))
}

fn append_vary(headers: &mut HeaderMap, field: &'static str) {
    if !headers
        .get_all(header::VARY)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .any(|value| {
            value
                .split(',')
                .any(|name| name.trim() == "*" || name.trim().eq_ignore_ascii_case(field))
        })
    {
        headers.append(header::VARY, HeaderValue::from_static(field));
    }
}

/// Canonicalizing the final file also checks every symlink in the path. Files
/// that resolve outside their public root are never sent by the native server.
pub async fn contained_file(root: &Path, relative: &str) -> Result<Option<PathBuf>> {
    let root = root.to_path_buf();
    let relative = relative.to_owned();
    tokio::task::spawn_blocking(move || contained_file_sync(&root, &relative))
        .await
        .context("file containment check failed")?
}

// Call only from blocking tasks; lets page lookup batch all its filesystem work.
pub(crate) fn contained_file_sync(root: &Path, relative: &str) -> Result<Option<PathBuf>> {
    if relative.is_empty() || crate::manifest::validate_relative_file(relative).is_err() {
        return Ok(None);
    }
    let candidate = root.join(relative);
    // Most page requests first probe public/ and miss. Check existence
    // before realpath walks every directory of the absolute project path.
    // Successful probes still canonicalize the entire path for containment.
    let metadata = match std::fs::metadata(&candidate) {
        Ok(metadata) => metadata,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound
                    | std::io::ErrorKind::NotADirectory
                    | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            return Ok(None)
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() {
        return Ok(None);
    }
    let file = match std::fs::canonicalize(candidate) {
        Ok(file) => file,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound
                    | std::io::ErrorKind::NotADirectory
                    | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            return Ok(None)
        }
        Err(error) => return Err(error.into()),
    };
    if !file.starts_with(root) {
        return Ok(None);
    }
    Ok(Some(file))
}

pub(crate) fn request_headers(headers: &HeaderMap) -> BTreeMap<String, String> {
    let mut result = BTreeMap::new();
    for name in headers.keys() {
        let separator = if name == header::COOKIE { "; " } else { ", " };
        let value = headers
            .get_all(name)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .collect::<Vec<_>>()
            .join(separator);
        result.insert(name.to_string(), value);
    }
    result
}

fn render_response(rendered: RenderedResponse, is_head: bool) -> Result<Response<Body>> {
    let status = StatusCode::from_u16(rendered.status)?;
    let length = match &rendered.body {
        RenderedBody::Buffered(body) => Some(body.len()),
        RenderedBody::Compact(body) => Some(body.len()),
        RenderedBody::Stream(_) => None,
    };
    let no_body = matches!(
        status,
        StatusCode::NO_CONTENT | StatusCode::RESET_CONTENT | StatusCode::NOT_MODIFIED
    );
    let body = match rendered.body {
        _ if is_head || no_body => Body::empty(),
        RenderedBody::Buffered(bytes) => Body::from(bytes),
        RenderedBody::Stream(stream) => Body::from_stream(stream),
        RenderedBody::Compact(body) => Body::from_stream(body),
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    // Connection can nominate additional hop-by-hop fields. Never leak those
    // names into the downstream response, even when the worker supplied them.
    let connection_headers: Vec<String> = rendered
        .headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("connection"))
        .flat_map(|(_, values)| match values {
            HeaderValues::Single(value) => vec![value],
            HeaderValues::Multiple(values) => values.iter().collect(),
        })
        .flat_map(|value| {
            value
                .split(',')
                .map(|name| name.trim().to_ascii_lowercase())
        })
        .collect();
    for (name, values) in rendered.headers {
        let name = HeaderName::try_from(name)?;
        if is_hop_header(&name)
            || name == header::CONTENT_LENGTH
            || connection_headers.iter().any(|hop| hop == name.as_str())
        {
            continue;
        }
        let values = match values {
            HeaderValues::Single(value) => vec![value],
            HeaderValues::Multiple(values) => values,
        };
        for value in values {
            response
                .headers_mut()
                .append(name.clone(), HeaderValue::try_from(value)?);
        }
    }
    if let Some(length) = length.filter(|_| !no_body) {
        response.headers_mut().insert(
            header::CONTENT_LENGTH,
            HeaderValue::try_from(length.to_string())?,
        );
    }
    response
        .headers_mut()
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static(
            "private, no-cache, no-store, max-age=0, must-revalidate",
        ));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

pub(crate) fn is_hop_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn error_response(status: StatusCode, message: &'static str) -> Response<Body> {
    let mut response = Response::new(Body::from(message));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    tracing::info!("shutting down HTTP server");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(pattern: &str) -> Route {
        Route {
            id: pattern.to_owned(),
            pattern: pattern.to_owned(),
            kind: RouteKind::Page,
            module: "server/test.cjs".to_owned(),
            router: None,
            fallback: None,
            ssg: false,
            fallback_file: None,
            allowed_paths: None,
            dynamic_paths: None,
            cache_config: None,
            internal: false,
            error_status: None,
        }
    }

    #[test]
    fn trailing_slash_policy_preserves_queries_mounts_and_transport_exceptions() {
        let mut config = crate::manifest::NativeConfig::default();
        let headers = HeaderMap::new();
        for (input, expected) in [
            ("/path/?a=1&a=2", Some("/path?a=1&a=2")),
            ("/", None),
            ("/file.txt/", Some("/file.txt")),
        ] {
            assert_eq!(
                trailing_slash_location(&config, &input.parse().unwrap(), &headers).as_deref(),
                expected
            );
        }
        config.trailing_slash = true;
        for (input, expected) in [
            ("/page?q=a%2Fb", Some("/page/?q=a%2Fb")),
            ("/page/", None),
            ("/file.txt", None),
            ("/file.txt/", Some("/file.txt")),
            ("/.well-known/token", None),
            ("/.well-known/token/", None),
            ("/a.b/c", Some("/a.b/c/")),
            ("/_next/data/build/page.json", None),
            ("/_rustyx/image?url=x", None),
        ] {
            assert_eq!(
                trailing_slash_location(&config, &input.parse().unwrap(), &headers).as_deref(),
                expected
            );
        }
        config.base_path = "/docs".into();
        assert_eq!(
            trailing_slash_location(&config, &"/docs?a=1".parse().unwrap(), &headers).as_deref(),
            Some("/docs/?a=1")
        );
        assert_eq!(
            trailing_slash_location(&config, &"/outside".parse().unwrap(), &headers),
            None
        );
        config.skip_trailing_slash_redirect = true;
        assert_eq!(
            trailing_slash_location(
                &config,
                &"//outside.test/path/?q=1".parse().unwrap(),
                &headers
            )
            .as_deref(),
            Some("/outside.test/path/?q=1")
        );
        assert_eq!(
            trailing_slash_location(&config, &"/docs/page".parse().unwrap(), &headers),
            None
        );
    }

    #[test]
    fn server_actions_check_origin_host_ports_and_proxy_authority() {
        for (origin, host, forwarded, allowed) in [
            ("http://localhost:3000", "localhost:3000", None, true),
            ("http://LOCALHOST:3000", "localhost:3000", None, true),
            ("https://example.test", "example.test:443", None, true),
            ("http://[::1]:3000", "[::1]:3000", None, true),
            (
                "https://example.test",
                "backend:3000",
                Some("example.test"),
                true,
            ),
            ("https://attacker.test", "example.test", None, false),
            ("https://example.test:444", "example.test:443", None, false),
            ("https://example.test/path", "example.test", None, false),
            ("https://user@example.test", "example.test", None, false),
            ("null", "example.test", None, false),
            ("file:///example.test", "example.test", None, false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
            headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
            if let Some(forwarded) = forwarded {
                headers.insert(
                    "x-forwarded-host",
                    HeaderValue::from_str(forwarded).unwrap(),
                );
            }
            assert_eq!(
                action_origin_allowed(&headers, "localhost"),
                allowed,
                "{origin} -> {host}"
            );
        }
        let mut headers = HeaderMap::new();
        assert!(action_origin_allowed(&headers, "localhost"));
        headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
        assert!(!action_origin_allowed(&headers, "localhost"));
        headers.insert(header::ORIGIN, HeaderValue::from_static("http://localhost"));
        headers.append(
            header::ORIGIN,
            HeaderValue::from_static("http://attacker.test"),
        );
        assert!(!action_origin_allowed(&headers, "localhost"));
    }

    #[test]
    fn server_action_configured_origins_match_complete_labels_and_ports() {
        for (host, pattern, expected) in [
            ("portal.example.test", "*.example.test", true),
            ("portal.EXAMPLE.test", "*.example.test", true),
            ("example.test", "*.example.test", false),
            ("nested.portal.example.test", "*.example.test", false),
            ("nested.portal.example.test", "**.example.test", true),
            ("example.test", "**.example.test", false),
            ("portal.example.test:8443", "*.example.test", false),
            ("portal.example.test:8443", "*.example.test:8443", true),
            ("portal.example.test.evil", "**.example.test", false),
            ("portal.example.test", "portal-*.example.test", false),
            ("portal.example.test", "*", false),
        ] {
            assert_eq!(
                action_host_matches(host, pattern),
                expected,
                "{host} / {pattern}"
            );
        }
        let allowed = vec!["*.example.test".to_owned()];
        for (origin, expected) in [
            ("https://portal.example.test", true),
            ("https://portal.example.test:443", true),
            ("https://portal.example.test:8443", false),
            ("https://portal.example.test/path", false),
            ("https://attacker@portal.example.test", false),
            ("null", false),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
            headers.insert(header::HOST, HeaderValue::from_static("internal.test"));
            assert_eq!(
                action_origin_allowed_with_options(&headers, "localhost", &allowed),
                expected
            );
            headers.append(
                header::ORIGIN,
                HeaderValue::from_static("https://evil.test"),
            );
            assert!(!action_origin_allowed_with_options(
                &headers,
                "localhost",
                &allowed
            ));
        }
    }

    #[test]
    fn middleware_header_replacement_cannot_change_original_action_origin_permission() {
        for (origin, site, allowed) in [
            (Some("https://foreign.test"), Some("cross-site"), false),
            (Some("http://example.test"), Some("same-origin"), true),
            (None, Some("cross-site"), false),
            (None, None, true),
        ] {
            let mut request = Request::builder()
                .method(Method::POST)
                .uri("/action")
                .header(header::HOST, "example.test")
                .body(Body::empty())
                .unwrap();
            if let Some(origin) = origin {
                request
                    .headers_mut()
                    .insert(header::ORIGIN, HeaderValue::from_static(origin));
            }
            if let Some(site) = site {
                request
                    .headers_mut()
                    .insert("sec-fetch-site", HeaderValue::from_static(site));
            }
            remember_action_origin(&mut request, "example.test", &[]);
            crate::middleware::effects(
                BTreeMap::from([
                    ("x-middleware-next".into(), "1".into()),
                    ("x-middleware-override-headers".into(), "x-added".into()),
                    ("x-middleware-request-x-added".into(), "middleware".into()),
                ]),
                request.headers_mut(),
                "http://example.test/action",
                &"/action".parse().unwrap(),
                true,
            )
            .unwrap();
            assert!(!request.headers().contains_key(header::ORIGIN));
            assert!(!request.headers().contains_key("sec-fetch-site"));
            assert!(action_origin_allowed(request.headers(), "example.test"));
            assert_eq!(
                request_action_origin_allowed(&request, "example.test", &[]),
                allowed
            );
        }
        let request = Request::builder()
            .method(Method::POST)
            .header(header::HOST, "example.test")
            .header(header::ORIGIN, "https://foreign.test")
            .body(Body::empty())
            .unwrap();
        assert!(!request_action_origin_allowed(
            &request,
            "example.test",
            &[]
        ));
    }

    #[test]
    fn exact_route_index_scales_without_changing_dynamic_precedence() {
        let mut routes: Vec<_> = (0..2048)
            .map(|index| route(&format!("/catalog/item-{index}")))
            .collect();
        routes.extend([
            route("/"),
            route("/catalog/[id]"),
            route("/[...slug]"),
            route("/catalog/[[...slug]]"),
        ]);
        let table = RouteTable::new(routes).unwrap();
        assert_eq!(table.exact.len(), 2049);
        assert_eq!(table.dynamic.len(), 3);
        for path in [
            "/",
            "/catalog/item-0",
            "/catalog/item-1024",
            "/catalog/item-2047",
        ] {
            let (matched, params) = table.resolve(path, &decode_path(path).unwrap()).unwrap();
            assert_eq!(matched.pattern, path);
            assert!(params.is_empty());
        }
        for (path, expected) in [
            ("/catalog/unknown", "/catalog/[id]"),
            ("/catalog", "/catalog/[[...slug]]"),
            ("/catalog/a/b", "/catalog/[[...slug]]"),
            ("/elsewhere/a/b", "/[...slug]"),
        ] {
            let (matched, _) = table.resolve(path, &decode_path(path).unwrap()).unwrap();
            assert_eq!(matched.pattern, expected);
        }
    }

    #[tokio::test]
    async fn cached_handler_html_is_not_rewritten_as_a_page_and_binary_type_is_not_invented() {
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        let html = b"<html><body>exact handler bytes</body></html>";
        std::fs::write(root.join("handler.body"), html).unwrap();
        std::fs::write(root.join("binary.body"), [0, 255, 128]).unwrap();
        let manifest:Manifest=serde_json::from_value(serde_json::json!({"version":1,"buildId":"handlers","routes":[{"id":"handler","pattern":"/[slug]","kind":"api","router":"app","module":"server/handler.cjs","ssg":true,"fallback":"blocking"}],"prerendered":[{"path":"/handler","file":"handler.body","headers":{"content-type":"text/html","set-cookie":["a=1","b=2"],"cache-control":"private, no-store"},"revalidate":false,"generatedAt":1},{"path":"/binary","file":"binary.body","headers":{},"revalidate":false,"generatedAt":1}]})).unwrap();
        manifest.validate().unwrap();
        let cache = crate::pages::PageCache::new(
            &root,
            &root,
            &manifest,
            WorkerConfig {
                node: root.join("missing-node"),
                script: root.join("missing-worker"),
                project: root.clone(),
                dist: root.clone(),
                cache: None,
            },
        )
        .unwrap()
        .unwrap();
        let mut etag = None;
        for method in [Method::GET, Method::HEAD] {
            let selected = cache
                .select("/handler", &["handler".into()], true)
                .await
                .unwrap()
                .unwrap();
            let mut request = Request::builder()
                .method(method.clone())
                .uri("/alias?private=yes")
                .header("rsc", "1")
                .body(Body::empty())
                .unwrap();
            request.extensions_mut().insert(RoutingContext {
                compress: true,
                rewrite: Some(serde_json::json!({"url":"/handler?private=yes","params":{}})),
                ..Default::default()
            });
            let response = serve_handler(selected, request).await.unwrap();
            assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html");
            assert_eq!(
                response
                    .headers()
                    .get_all(header::SET_COOKIE)
                    .iter()
                    .count(),
                2
            );
            assert_eq!(
                response.headers()[header::CACHE_CONTROL],
                "private, no-store"
            );
            assert!(!response.headers().contains_key("x-rustyx-rewrite"));
            assert!(!response
                .headers()
                .get_all(header::VARY)
                .iter()
                .any(|value| value.to_str().unwrap().contains("RSC")));
            etag = Some(response.headers()[header::ETAG].clone());
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            assert_eq!(
                body.as_ref(),
                if method == Method::HEAD {
                    b"".as_slice()
                } else {
                    html.as_slice()
                }
            );
        }
        let selected = cache
            .select("/handler", &["handler".into()], true)
            .await
            .unwrap()
            .unwrap();
        let request = Request::builder()
            .uri("/handler")
            .header(header::IF_NONE_MATCH, etag.unwrap())
            .body(Body::empty())
            .unwrap();
        let response = serve_handler(selected, request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(
            response
                .headers()
                .get_all(header::CACHE_CONTROL)
                .iter()
                .count(),
            1
        );
        assert_eq!(
            response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count(),
            2
        );
        let selected = cache
            .select("/binary", &["binary".into()], true)
            .await
            .unwrap()
            .unwrap();
        let response = serve_handler(
            selected,
            Request::builder()
                .uri("/binary")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert!(!response.headers().contains_key(header::CONTENT_TYPE));
        assert_eq!(
            to_bytes(response.into_body(), 10).await.unwrap().as_ref(),
            [0, 255, 128]
        );
    }

    #[test]
    fn configured_headers_cannot_overwrite_handler_policy_or_restore_private_rewrite_validators() {
        let mut response = Response::builder()
            .header(header::CACHE_CONTROL, "private, no-store")
            .header(header::SET_COOKIE, "handler=1")
            .header(header::SET_COOKIE, "second=2")
            .body(Body::empty())
            .unwrap();
        response.extensions_mut().insert(RewritePrivate);
        let mut configured = HeaderMap::new();
        configured.insert(
            header::CACHE_CONTROL,
            "public, max-age=3600".parse().unwrap(),
        );
        configured.append(header::SET_COOKIE, "configured=1".parse().unwrap());
        configured.insert(header::ETAG, "\"static\"".parse().unwrap());
        configured.insert("x-rustyx-rewrite", "forged".parse().unwrap());
        configured.insert("x-configured", "yes".parse().unwrap());
        apply_custom_headers(&mut response, configured);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert_eq!(
            response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count(),
            2
        );
        assert!(!response.headers().contains_key(header::ETAG));
        assert!(!response.headers().contains_key("x-rustyx-rewrite"));
        assert_eq!(response.headers()["x-configured"], "yes");
    }

    #[tokio::test]
    async fn custom_rewrites_respect_files_phases_and_matched_route_404s() {
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        std::fs::write(root.join("file"), "public file").unwrap();
        std::fs::write(root.join("target"), "rewritten target").unwrap();
        let rewrite = |source: &str, destination: &str| serde_json::json!({"source":source,"regex":format!("^{source}$"),"keys":[],"has":[],"missing":[],"destination":{"external":false,"pathname":[destination],"query":[],"hash":[],"appendParamsToQuery":false}});
        let routes = serde_json::json!({"version":1,"headers":[],"redirects":[],"rewrites":{"beforeFiles":[rewrite("/alias","/middle"),rewrite("/middle","/target")],"afterFiles":[rewrite("/file","/target"),rewrite("/after","/target")],"fallback":[rewrite("/missing","/target")]}});
        let mut dynamic = route("/[slug]");
        dynamic.fallback = Some(serde_json::Value::Bool(false));
        let state = Arc::new(AppState {
            routing_resolver: None,
            images: None,
            dist: root.clone(),
            public: Some(root.clone()),
            assets: None,
            routes: RouteTable::new(vec![dynamic]).unwrap(),
            prerendered: HashMap::new(),
            pool: WorkerPool::new(
                WorkerConfig {
                    node: root.join("missing"),
                    script: root.join("missing"),
                    project: root.clone(),
                    dist: root,
                    cache: None,
                },
                1,
            ),
            render_admission: admission::Admission::new(1),
            api_admission: admission::Admission::new(1),
            default_host: "localhost".into(),
            build_id: Some("test-build".into()),
            preview_mode_id: None,
            dev: None,
            pages: None,
            custom: crate::custom_routes::CompiledRoutes::new(Some(
                serde_json::from_value(routes).unwrap(),
            ))
            .unwrap(),
            proxy: Default::default(),
            middleware: None,
            errors: Default::default(),
            config: Default::default(),
        });
        for (path, status, expected) in [
            ("/alias", 200, "rewritten target"),
            ("/file", 200, "public file"),
            ("/after", 200, "rewritten target"),
            ("/missing", 404, "Not Found"),
        ] {
            let request = Request::builder().uri(path).body(Body::empty()).unwrap();
            let response = handle_inner(state.clone(), request).await.unwrap();
            assert_eq!(response.status().as_u16(), status, "{path}");
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap(),
                expected,
                "{path}"
            );
        }
    }

    #[test]
    fn middleware_response_headers_win_and_cookies_merge_without_overriding_private_rewrite_policy()
    {
        let mut response = Response::builder()
            .header("x-order", "handler")
            .header(header::CACHE_CONTROL, "private, no-store")
            .header(header::SET_COOKIE, "shared=handler")
            .header(header::SET_COOKIE, "same=value")
            .body(Body::empty())
            .unwrap();
        response.extensions_mut().insert(RewritePrivate);
        let mut middleware = HeaderMap::new();
        middleware.insert("x-order", HeaderValue::from_static("middleware"));
        middleware.insert(header::CACHE_CONTROL, HeaderValue::from_static("public"));
        middleware.insert(header::ETAG, HeaderValue::from_static("\"incorrect\""));
        middleware.insert(
            "x-middleware-rewrite",
            HeaderValue::from_static("/destination"),
        );
        middleware.append(
            header::SET_COOKIE,
            HeaderValue::from_static("shared=middleware"),
        );
        middleware.append(header::SET_COOKIE, HeaderValue::from_static("same=value"));
        let mut configured = HeaderMap::new();
        configured.insert("x-order", HeaderValue::from_static("config"));
        apply_final_headers(&mut response, configured, middleware);
        assert_eq!(response.headers()["x-order"], "middleware");
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert!(!response.headers().contains_key(header::ETAG));
        assert_eq!(response.headers()["x-middleware-rewrite"], "/destination");
        assert_eq!(
            response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .map(|value| value.to_str().unwrap())
                .collect::<Vec<_>>(),
            ["shared=middleware", "same=value", "shared=handler"]
        );
    }

    #[tokio::test]
    async fn rewrite_marker_is_escaped_inserted_once_and_retains_streaming_prefix() {
        use futures_util::StreamExt;
        let prefix = "a".repeat(40 * 1024);
        let input = Body::from_stream(futures_util::stream::iter([
            Ok::<_, std::io::Error>(axum::body::Bytes::from(prefix.clone())),
            Ok(axum::body::Bytes::from_static(b"<body>tail</bo")),
            Ok(axum::body::Bytes::from_static(b"dy></html>")),
        ]));
        let response = insert_rewrite_marker(
            Response::new(input),
            r#"{"url":"/target?x=</script>&","params":{}}"#,
        );
        let mut stream = response.into_body().into_data_stream();
        let first = stream.next().await.unwrap().unwrap();
        assert_eq!(first.len(), 24 * 1024);
        let mut output = first.to_vec();
        while let Some(chunk) = stream.next().await {
            output.extend_from_slice(&chunk.unwrap());
        }
        let text = String::from_utf8(output).unwrap();
        assert!(text.starts_with(&prefix));
        assert_eq!(text.matches("id=\"__RUSTYX_REWRITE__\"").count(), 1);
        assert!(text.ends_with("</script></body></html>"));
        assert!(text.contains(r"\u003c/script\u003e\u0026"));
        assert!(stream.next().await.is_none());
        assert!(stream.next().await.is_none());
    }

    #[tokio::test]
    async fn small_rewritten_html_flushes_a_complete_gzip_stream() {
        use std::io::Read;
        use tower::Layer;
        let service =
            CompressionLayer::new()
                .gzip(true)
                .layer(tower::service_fn(|_: Request| async {
                    let response = Response::builder()
                        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                        .body(Body::from(format!(
                            "<html><body>{}</body></html>",
                            "cached HTML ".repeat(100)
                        )))
                        .unwrap();
                    Ok::<_, std::convert::Infallible>(insert_rewrite_marker(
                        response,
                        r#"{"url":"/static?dest=middleware","params":{}}"#,
                    ))
                }));
        let response = service
            .oneshot(
                Request::builder()
                    .header(header::ACCEPT_ENCODING, "gzip")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CONTENT_ENCODING], "gzip");
        let bytes = to_bytes(Body::new(response.into_body()), 8192)
            .await
            .unwrap();
        let mut html = String::new();
        flate2::read::GzDecoder::new(bytes.as_ref())
            .read_to_string(&mut html)
            .unwrap();
        assert_eq!(html.matches("id=\"__RUSTYX_REWRITE__\"").count(), 1);
        assert!(html.ends_with("</script></body></html>"));
        assert_eq!(html.matches("cached HTML ").count(), 100);
    }

    #[tokio::test]
    async fn prerendered_paths_win_over_exact_and_parameterized_routes() {
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        tokio::fs::write(root.join("offer.html"), "<h1>Prerendered offer</h1>")
            .await
            .unwrap();
        let state = Arc::new(AppState {
            routing_resolver: None,
            images: None,
            dist: root.clone(),
            public: None,
            assets: None,
            routes: RouteTable::new(vec![route("/offers/current"), route("/offers/[slug]")])
                .unwrap(),
            prerendered: HashMap::from([(
                "/offers/current".to_owned(),
                Prerendered {
                    path: "/offers/current".to_owned(),
                    file: "offer.html".to_owned(),
                    status: 200,
                    headers: BTreeMap::new(),
                    data_file: None,
                    revalidate: Default::default(),
                    generated_at: 0,
                    tags: Vec::new(),
                    paths: Vec::new(),
                },
            )]),
            // Any accidental worker invocation fails this test without needing Node.
            pool: WorkerPool::new(
                WorkerConfig {
                    node: root.join("nonexistent-node"),
                    script: root.join("nonexistent-worker"),
                    project: root.clone(),
                    dist: root,
                    cache: None,
                },
                1,
            ),
            render_admission: admission::Admission::new(1),
            api_admission: admission::Admission::new(1),
            default_host: "localhost".to_owned(),
            build_id: Some("test-build".into()),
            preview_mode_id: None,
            dev: None,
            pages: None,
            custom: Default::default(),
            proxy: Default::default(),
            middleware: None,
            errors: Default::default(),
            config: Default::default(),
        });
        let request = Request::builder()
            .uri("/offers/current")
            .body(Body::empty())
            .unwrap();
        let response = handle_inner(state, request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap(),
            "<h1>Prerendered offer</h1>"
        );
    }

    #[tokio::test]
    async fn pages_data_without_ssg_cache_dispatches_only_the_data_worker_and_checks_build_id() {
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        let script = root.join("worker.mjs");
        std::fs::write(
            &script,
            r#"
            import {createInterface} from 'node:readline';
            for await (const line of createInterface({input:process.stdin})) {
                const request=JSON.parse(line);
                process.stdout.write(JSON.stringify({id:request.id,status:200,
                    headers:{'content-type':'application/json'},
                    body:Buffer.from(JSON.stringify(request)).toString('base64')})+'\n');
            }
        "#,
        )
        .unwrap();
        std::fs::write(root.join("offer.html"), "HTML MUST NOT BE USED FOR DATA").unwrap();
        let mut api = route("/api/hello");
        api.kind = RouteKind::Api;
        let mut app = route("/app");
        app.router = Some("app".into());
        let state = Arc::new(AppState {
            routing_resolver: None,
            images: None,
            dist: root.clone(),
            public: None,
            assets: None,
            routes: RouteTable::new(vec![route("/offers/[slug]"), api, app]).unwrap(),
            prerendered: HashMap::from([(
                "/offers/current".into(),
                serde_json::from_value(
                    serde_json::json!({"path":"/offers/current","file":"offer.html"}),
                )
                .unwrap(),
            )]),
            pool: WorkerPool::new(
                WorkerConfig {
                    node: "node".into(),
                    script,
                    project: root.clone(),
                    dist: root,
                    cache: None,
                },
                1,
            ),
            render_admission: admission::Admission::new(1),
            api_admission: admission::Admission::new(1),
            default_host: "localhost".into(),
            build_id: Some("data-build".into()),
            preview_mode_id: None,
            dev: None,
            pages: None,
            custom: Default::default(),
            proxy: Default::default(),
            middleware: None,
            errors: Default::default(),
            config: Default::default(),
        });
        for prefix in ["_rustyx", "_next"] {
            let uri = format!("/{prefix}/data/data-build/offers/current.json?tag=a&tag=b");
            let response = handle_inner(
                state.clone(),
                Request::builder().uri(&uri).body(Body::empty()).unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(request["renderMode"], "data");
            assert_eq!(
                request["url"],
                "http://localhost/offers/current?tag=a&tag=b"
            );
            assert_eq!(request["originalUrl"], format!("http://localhost{uri}"));
            assert_eq!(request["params"]["slug"], "current");
            assert_eq!(request["headers"]["x-nextjs-data"], "1");
            let head = handle_inner(
                state.clone(),
                Request::builder()
                    .method(Method::HEAD)
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(head.status(), StatusCode::OK);
            assert!(to_bytes(head.into_body(), 4096).await.unwrap().is_empty());
        }
        for uri in [
            "/_rustyx/data/old/offers/current.json",
            "/_rustyx/data/data-build/api/hello.json",
            "/_rustyx/data/data-build/app.json",
            "/_rustyx/data/data-build/missing.json",
        ] {
            let response = handle_inner(
                state.clone(),
                Request::builder().uri(uri).body(Body::empty()).unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap(),
                r#"{"notFound":true}"#
            );
        }
    }

    #[tokio::test]
    async fn base_path_mounts_pages_public_and_assets_without_exposing_unmounted_routes() {
        let directory = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(directory.path()).unwrap();
        std::fs::write(root.join("page.html"), "mounted page").unwrap();
        std::fs::write(root.join("public.txt"), "mounted public").unwrap();
        std::fs::write(root.join("main.js"), "mounted asset").unwrap();
        let state = Arc::new(AppState {
            routing_resolver: None,
            images: None,
            dist: root.clone(),
            public: Some(root.clone()),
            assets: Some(root.clone()),
            routes: RouteTable::new(vec![route("/fixed"), route("/ssr")]).unwrap(),
            prerendered: HashMap::from([(
                "/fixed".into(),
                serde_json::from_value(serde_json::json!({"path":"/fixed","file":"page.html"}))
                    .unwrap(),
            )]),
            pool: WorkerPool::new(
                WorkerConfig {
                    node: root.join("missing-node"),
                    script: root.join("missing-worker"),
                    project: root.clone(),
                    dist: root,
                    cache: None,
                },
                1,
            ),
            render_admission: admission::Admission::new(1),
            api_admission: admission::Admission::new(1),
            default_host: "localhost".into(),
            build_id: Some("mounted-build".into()),
            preview_mode_id: None,
            dev: None,
            pages: None,
            custom: Default::default(),
            proxy: Default::default(),
            middleware: None,
            errors: Default::default(),
            config: crate::manifest::NativeConfig {
                base_path: "/docs".into(),
                asset_prefix: "https://cdn.test/cdn".into(),
                asset_base: "https://cdn.test/cdn/_rustyx/assets".into(),
                ..Default::default()
            },
        });
        for (path, expected) in [
            ("/docs/fixed", "mounted page"),
            ("/docs/public.txt", "mounted public"),
            ("/docs/_rustyx/assets/main.js", "mounted asset"),
            ("/cdn/_rustyx/assets/main.js", "mounted asset"),
        ] {
            let response = handle_inner(
                state.clone(),
                Request::builder().uri(path).body(Body::empty()).unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap(),
                expected
            );
        }
        for path in [
            "/fixed",
            "/public.txt",
            "/_rustyx/assets/main.js",
            "/docsmith/fixed",
            "/cdn/public.txt",
            "/_rustyx/data/mounted-build/ssr.json",
            "/docs/_rustyx/data/old/ssr.json",
        ] {
            let response = handle_inner(
                state.clone(),
                Request::builder().uri(path).body(Body::empty()).unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        }
        let root_redirect = handle_inner(
            state.clone(),
            Request::builder()
                .uri("/docs/?q=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(root_redirect.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(root_redirect.headers()[header::LOCATION], "/docs?q=1");
        // A valid mounted data URL reaches the worker even without any SSG cache.
        let data = handle_inner(
            state,
            Request::builder()
                .uri("/docs/_rustyx/data/mounted-build/ssr.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(data.status(), StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn static_file_containment_rejects_traversal_and_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        tokio::fs::write(root.join("hello.txt"), "hello")
            .await
            .unwrap();
        assert!(contained_file(&root, "hello.txt").await.unwrap().is_some());
        assert!(contained_file(&root, "../secret").await.unwrap().is_none());
        assert!(contained_file(&root, "").await.unwrap().is_none());
        assert!(contained_file(&root, "missing").await.unwrap().is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn static_file_containment_rejects_symlink_escape() {
        let public = tempfile::tempdir().unwrap();
        let private = tempfile::tempdir().unwrap();
        std::fs::write(private.path().join("secret"), "secret").unwrap();
        std::os::unix::fs::symlink(private.path().join("secret"), public.path().join("leak"))
            .unwrap();
        let root = std::fs::canonicalize(public.path()).unwrap();
        assert!(contained_file(&root, "leak").await.unwrap().is_none());
    }

    fn compressed_fixture() -> (tempfile::TempDir, PathBuf, Vec<u8>, Vec<u8>) {
        let directory = tempfile::tempdir().unwrap();
        let file = std::fs::canonicalize(directory.path())
            .unwrap()
            .join("page.html");
        let source = b"<h1>hello from a compiled page</h1>".to_vec();
        let gzip = vec![
            31, 139, 8, 0, 0, 0, 0, 0, 2, 255, 179, 201, 48, 180, 203, 72, 205, 201, 201, 87, 72,
            43, 202, 207, 85, 72, 84, 72, 206, 207, 45, 200, 204, 73, 77, 81, 40, 72, 76, 79, 181,
            209, 7, 74, 3, 0, 169, 197, 103, 84, 35, 0, 0, 0,
        ];
        std::fs::write(&file, &source).unwrap();
        std::fs::write(file.with_file_name("page.html.gz"), &gzip).unwrap();
        let modified =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        for file in [&file, &file.with_file_name("page.html.gz")] {
            std::fs::File::open(file)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(modified))
                .unwrap();
        }
        (directory, file, source, gzip)
    }

    #[tokio::test]
    async fn build_sidecars_preserve_negotiation_head_ranges_and_validators() {
        let (_directory, file, source, gzip) = compressed_fixture();
        let page = Prerendered {
            path: "/".into(),
            file: "page.html".into(),
            data_file: None,
            revalidate: Default::default(),
            generated_at: 0,
            tags: Vec::new(),
            paths: Vec::new(),
            status: 200,
            headers: BTreeMap::from([
                ("etag".into(), "\"source\"".into()),
                ("vary".into(), "RSC".into()),
            ]),
        };
        for (encoding, expected) in [
            ("gzip", &gzip),
            ("identity", &source),
            ("gzip;q=0", &source),
        ] {
            let request = Request::builder()
                .header(header::ACCEPT_ENCODING, encoding)
                .body(Body::empty())
                .unwrap();
            let response = serve_file(file.clone(), request, "public", Some(&page), true)
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers().contains_key(header::CONTENT_ENCODING),
                encoding == "gzip"
            );
            assert_eq!(response.headers()[header::ETAG], "W/\"source\"");
            assert!(response
                .headers()
                .get_all(header::VARY)
                .iter()
                .any(|value| value == "Accept-Encoding"));
            assert!(response
                .headers()
                .get_all(header::VARY)
                .iter()
                .any(|value| value == "RSC"));
            assert_eq!(
                to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
                expected
            );
        }
        let request = Request::builder()
            .method(Method::HEAD)
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap();
        let response = serve_file(file.clone(), request, "public", Some(&page), true)
            .await
            .unwrap();
        assert_eq!(response.headers()[header::CONTENT_ENCODING], "gzip");
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            gzip.len().to_string()
        );
        let modified = response.headers()[header::LAST_MODIFIED].clone();
        assert!(to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .is_empty());

        let request = Request::builder()
            .header(header::ACCEPT_ENCODING, "gzip")
            .header(header::RANGE, "bytes=0-9")
            .body(Body::empty())
            .unwrap();
        let response = serve_file(file.clone(), request, "public", None, true)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers()[header::CONTENT_RANGE],
            format!("bytes 0-9/{}", gzip.len())
        );
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
            &gzip[..10]
        );

        let request = Request::builder()
            .header(header::ACCEPT_ENCODING, "gzip")
            .header(header::RANGE, "bytes=10-")
            .header(header::IF_RANGE, "\"source\"")
            .body(Body::empty())
            .unwrap();
        let response = serve_file(file.clone(), request, "public", Some(&page), true)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
            &gzip
        );

        let request = Request::builder()
            .header(header::ACCEPT_ENCODING, "gzip")
            .header(header::IF_MODIFIED_SINCE, modified)
            .body(Body::empty())
            .unwrap();
        let response = serve_file(file.clone(), request, "public", Some(&page), true)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers()[header::ETAG], "W/\"source\"");
        assert!(response
            .headers()
            .get_all(header::VARY)
            .iter()
            .any(|value| value == "Accept-Encoding"));
        assert!(to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .is_empty());

        // The same files in public/ stay under normal runtime compression.
        let request = Request::builder()
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap();
        let response = serve_file(file, request, "public", None, false)
            .await
            .unwrap();
        assert!(!response.headers().contains_key(header::CONTENT_ENCODING));
        assert_eq!(
            to_bytes(response.into_body(), 1024).await.unwrap().as_ref(),
            &source
        );
    }

    #[tokio::test]
    async fn stale_build_sidecars_are_ignored() {
        let (_directory, file, _, _) = compressed_fixture();
        assert!(fresh_gzip_sidecar(&file).await.unwrap());
        std::fs::File::open(&file)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(
                std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_001),
            ))
            .unwrap();
        assert!(!fresh_gzip_sidecar(&file).await.unwrap());
        let request = Request::builder()
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap();
        let response = serve_file(file, request, "public", None, true)
            .await
            .unwrap();
        assert!(!response.headers().contains_key(header::CONTENT_ENCODING));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn build_sidecars_cannot_escape_through_symlinks() {
        let (_directory, file, _, gzip) = compressed_fixture();
        let private = tempfile::tempdir().unwrap();
        let external = private.path().join("secret.gz");
        std::fs::write(&external, gzip).unwrap();
        let sibling = file.with_file_name("page.html.gz");
        std::fs::remove_file(&sibling).unwrap();
        std::os::unix::fs::symlink(external, sibling).unwrap();
        assert!(!fresh_gzip_sidecar(&file).await.unwrap());
    }

    #[tokio::test]
    async fn responses_preserve_repeated_cookies_and_suppress_head_body() {
        let response = render_response(
            RenderedResponse {
                status: 200,
                body: RenderedBody::Buffered(b"hello".to_vec()),
                isr: None,
                page_error: None,
                page_failure: None,
                headers: BTreeMap::from([
                    (
                        "set-cookie".into(),
                        HeaderValues::Multiple(vec!["a=1".into(), "b=2".into()]),
                    ),
                    (
                        "connection".into(),
                        HeaderValues::Single("close, X-Hop-Secret".into()),
                    ),
                    (
                        "x-hop-secret".into(),
                        HeaderValues::Single("private".into()),
                    ),
                    ("content-length".into(), HeaderValues::Single("999".into())),
                ]),
            },
            true,
        )
        .unwrap();
        assert_eq!(
            response
                .headers()
                .get_all(header::SET_COOKIE)
                .iter()
                .count(),
            2
        );
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "5");
        assert!(!response.headers().contains_key(header::CONNECTION));
        assert!(!response.headers().contains_key("x-hop-secret"));
        assert!(to_bytes(response.into_body(), 100)
            .await
            .unwrap()
            .is_empty());
    }
}
