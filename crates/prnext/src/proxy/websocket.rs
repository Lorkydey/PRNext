//! Transparent, bounded HTTP/1 WebSocket tunnels. No protocol termination,
//! payload buffering, retries, CONNECT, or public administration endpoint.
use super::*;
use axum::http::{HeaderValue, Method, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha1::{Digest, Sha1};
use std::future::Future;

fn token(headers: &HeaderMap, name: HeaderName, expected: &str) -> bool {
    headers
        .get_all(name)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|v| v.trim().eq_ignore_ascii_case(expected))
}
fn failure(status: StatusCode) -> anyhow::Result<Response<Body>> {
    Ok(Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from("WebSocket handshake failed"))?)
}
impl Proxy {
    pub async fn websocket<L, F>(
        &self,
        mut request: Request,
        destination: &str,
        preserve_host: bool,
        set_forwarded_host: bool,
        lease: L,
        cancel: F,
    ) -> anyhow::Result<Response<Body>>
    where
        L: Send + 'static,
        F: Future<Output = ()> + Send + 'static,
    {
        let mut cancel = Box::pin(cancel);
        if request.method() != Method::GET
            || request.version() != Version::HTTP_11
            || !token(request.headers(), header::CONNECTION, "upgrade")
            || request
                .headers()
                .get(header::UPGRADE)
                .and_then(|v| v.to_str().ok())
                .is_none_or(|v| !v.eq_ignore_ascii_case("websocket"))
            || request
                .headers()
                .get("sec-websocket-version")
                .is_none_or(|v| v != "13")
            || request.headers().contains_key(header::TRANSFER_ENCODING)
            || request
                .headers()
                .get(header::CONTENT_LENGTH)
                .is_some_and(|v| v != "0")
        {
            return failure(StatusCode::BAD_REQUEST);
        }
        let Some(key) = request
            .headers()
            .get("sec-websocket-key")
            .and_then(|v| v.to_str().ok())
            .filter(|v| STANDARD.decode(v).is_ok_and(|bytes| bytes.len() == 16))
        else {
            return failure(StatusCode::BAD_REQUEST);
        };
        let expected = STANDARD.encode(Sha1::digest(
            format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes(),
        ));
        let protocols = request
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let extensions = request.headers().contains_key("sec-websocket-extensions");
        let incoming = hyper::upgrade::on(&mut request);
        let permit = match self.acquire().await {
            Ok(value) => value,
            Err(status) => return failure(status),
        };
        let client = self
            .client
            .get_or_try_init(|| async {
                let _ = rustls::crypto::ring::default_provider().install_default();
                reqwest::Client::builder()
                    .http1_only()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .retry(reqwest::retry::never())
                    .connect_timeout(Duration::from_secs(10))
                    .read_timeout(self.idle)
                    .no_gzip()
                    .no_brotli()
                    .no_deflate()
                    .no_zstd()
                    .build()
            })
            .await?;
        let mut headers = request.headers().clone();
        let host = headers.get(header::HOST).cloned();
        strip_hop(&mut headers);
        if set_forwarded_host {
            headers.remove("x-forwarded-host");
            if let Some(host) = host {
                headers.insert("x-forwarded-host", host);
            }
        }
        if !preserve_host {
            headers.remove(header::HOST);
        }
        headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        // Connection-nominated security fields must not be silently restored.
        if !headers.contains_key("sec-websocket-key")
            || !headers.contains_key("sec-websocket-version")
        {
            return failure(StatusCode::BAD_REQUEST);
        }
        let response = match tokio::select! {result=tokio::time::timeout(Duration::from_secs(10),client.get(destination).headers(headers).send())=>result,_=&mut cancel=>return failure(StatusCode::SERVICE_UNAVAILABLE)}
        {
            Ok(Ok(value)) => value,
            _ => return failure(StatusCode::BAD_GATEWAY),
        };
        if response.status() != StatusCode::SWITCHING_PROTOCOLS {
            let status = response.status();
            let mut headers = response.headers().clone();
            strip_hop(&mut headers);
            let stream = ProxyStream::new(Box::pin(response.bytes_stream()), permit, self.idle);
            let held =
                futures_util::stream::unfold((stream, lease), |(mut stream, lease)| async move {
                    stream.next().await.map(|chunk| (chunk, (stream, lease)))
                });
            let mut output = Response::new(Body::from_stream(held));
            *output.status_mut() = status;
            *output.headers_mut() = headers;
            return Ok(output);
        }
        let selected = response
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|v| v.to_str().ok());
        if !token(response.headers(), header::CONNECTION, "upgrade")
            || response
                .headers()
                .get(header::UPGRADE)
                .and_then(|v| v.to_str().ok())
                .is_none_or(|v| !v.eq_ignore_ascii_case("websocket"))
            || response
                .headers()
                .get("sec-websocket-accept")
                .and_then(|v| v.to_str().ok())
                != Some(expected.as_str())
            || selected.is_some_and(|v| !protocols.split(',').any(|p| p.trim() == v))
            || response.headers().contains_key("sec-websocket-extensions") && !extensions
        {
            return failure(StatusCode::BAD_GATEWAY);
        }
        let mut headers = response.headers().clone();
        strip_hop(&mut headers);
        headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        tokio::spawn(async move {
            let _held = (lease, permit);
            let transfer = async {
                let (client, mut backend) =
                    tokio::try_join!(async { incoming.await.map_err(io::Error::other) }, async {
                        response.upgrade().await.map_err(io::Error::other)
                    })?;
                let mut client = hyper_util::rt::TokioIo::new(client);
                tokio::io::copy_bidirectional(&mut client, &mut backend).await
            };
            tokio::select! {_ = transfer=>{},_ = cancel=>{}}
        });
        let mut output = Response::new(Body::empty());
        *output.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        *output.headers_mut() = headers;
        Ok(output)
    }
}
