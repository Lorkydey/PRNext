//! Keep interactive and streamed HTTP replies out of Nagle's delayed-ACK cycle.
//! A response header followed by a small body/chunk must not wait for another
//! request to fill a TCP packet, including a single keep-alive SSR connection.
use axum::serve::{Listener, ListenerExt};
use std::net::SocketAddr;
use tokio::net::{TcpListener, TcpStream};

pub(crate) fn low_latency(
    listener: TcpListener,
) -> impl Listener<Io = TcpStream, Addr = SocketAddr> {
    listener.tap_io(|stream| {
        if let Err(error) = stream.set_nodelay(true) {
            tracing::debug!(%error, "could not disable the TCP small-packet delay");
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn accepted_connections_disable_nagle_before_http_uses_them() {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let mut listener = low_latency(listener);
        let (client, (accepted, _)) = tokio::join!(TcpStream::connect(address), listener.accept());
        let _client = client.unwrap();
        assert!(accepted.nodelay().unwrap());
    }
}
