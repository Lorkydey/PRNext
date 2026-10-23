use crate::pool::{RenderedBody, WorkerBody, WorkerPool, WorkerRequest};
use futures_util::StreamExt;
use std::{collections::BTreeMap, time::Duration};
pub(super) async fn preload(pool: &WorkerPool, timeout_ms: u64) {
    let request = WorkerRequest {
        max_duration: Some(Duration::from_millis(timeout_ms.clamp(100, 30000))),
        id: 0,
        route_id: "__prnext_preload".into(),
        method: "GET".into(),
        url: "http://localhost/".into(),
        original_url: None,
        headers: BTreeMap::new(),
        routing_request_headers: None,
        routing_resolver: None,
        body: WorkerBody::default(),
        params: Default::default(),
        stream: false,
        render_mode: Some("preload".into()),
        revalidate_reason: None,
        page_failure: None,
        document_request: None,
        middleware_matched: false,
    };
    match pool.request(request, None).await {
        Ok(response) => {
            if response.status != 204 {
                tracing::warn!(
                    "Worker preloading was incomplete; normal requests remain available"
                );
            }
            match response.body {
                RenderedBody::Stream(mut body) => while body.next().await.is_some() {},
                RenderedBody::Compact(mut body) => while body.next().await.is_some() {},
                _ => {}
            }
        }
        Err(error) => tracing::warn!(
            ?error,
            "Worker preloading failed; normal requests remain available"
        ),
    }
}
