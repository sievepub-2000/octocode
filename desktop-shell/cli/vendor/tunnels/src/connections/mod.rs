// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

mod errors;
mod io;
mod relay_tunnel_client;
mod relay_tunnel_host;
mod ws;

pub use relay_tunnel_client::*;
pub use relay_tunnel_host::*;

#[cfg(test)]
async fn tcp_pair() -> (tokio::net::TcpStream, tokio::net::TcpStream) {
	let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
	let (client, server) = tokio::join!(
		tokio::net::TcpStream::connect(listener.local_addr().unwrap()),
		listener.accept(),
	);
	(server.unwrap().0, client.unwrap())
}
