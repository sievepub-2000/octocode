// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

use std::{
	collections::HashMap,
	env, io,
	net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
	pin::Pin,
	sync::Arc,
	task::Poll,
	time::Duration,
};

use crate::{
	contracts::{TunnelConnectionMode, TunnelEndpoint, TunnelPort},
	management::{
		Authorization, HttpError, TunnelLocator, TunnelManagementClient, TunnelRequestOptions,
		NO_REQUEST_OPTIONS,
	},
};
use futures_util::{stream::FuturesUnordered, StreamExt};
use russh::{keys::PublicKeyBase64, server::Server as ServerTrait};
use tokio::{
	io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
	net::TcpStream,
	sync::{mpsc, oneshot, watch},
	task::JoinHandle,
};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

use super::{
	errors::TunnelError,
	ws::{build_websocket_request, connect_directly, connect_via_proxy, AsyncRWWebSocket},
};

/// Mapping of port numbers to senders to which new port connections should be
/// sent. Shared by the host relay to each connected session.
type PortMap = HashMap<u32, mpsc::UnboundedSender<ForwardedPortConnection>>;

// WebSocket writes can arrive here as a single large frame. If we hand that
// whole buffer to russh and report it fully written, russh may queue data until
// the SSH channel window is exhausted before the caller gets another chance to
// poll and drain the other side. 32 KiB matches the SSH channel max packet size
// used by the relay, so each accepted write maps to at most one SSH packet.
// Reporting bounded chunks preserves normal AsyncWrite backpressure and lets
// large responses continue making progress.
const CHANNEL_WRITE_CHUNK_SIZE: usize = 32 * 1024;

/// The RelayTunnelHost can host connections via the tunneling service. After
/// creating it, you will generally want to run `connect()` to create a new
/// a new connection.
///
/// Note that, while ports can be added and remove dynamically from running
/// tunnels via the appropriate methods on the RelayTunnelHost, no ports will be
/// hosted until those methods are called.
pub struct RelayTunnelHost {
	pub proxy: Option<String>,
	locator: TunnelLocator,
	host_id: Uuid,
	ports_tx: watch::Sender<PortMap>,
	ports_rx: watch::Receiver<PortMap>,
	mgmt: TunnelManagementClient,
	host_keypair: russh::keys::PrivateKey,
}

/// Hello friend. You're probably here because you want to change how tunnel
/// connections work! Here's how it works.
///
/// ## Overall Communication
///
/// Tunneling communicates via SSH over websockets. Data is sent fairly opaquely in
/// binary websocket messages. We use Tungstenite for the websocket, and then
/// wrap it into an AsyncRead/AsyncWrite type that we can give to the websocket
/// library, russh.
///
/// We then connect over SSH. Today, Tunneling doesn't require additional auth in
/// the SSH connection, and also has a somewhat non-standard "none" value for
/// its key exchange. This prevents many off-the-shelf SSH implementations from
/// working. Once a client connects to the other end of the tunnel, it'll
/// open a new Channel from the server (of type "client-ssh-session-stream").
///
/// The stream of data over this channel is actually an SSH client connection.
/// So, for each client, we create an SSH server instance, and do some more
/// work to make that channel AsyncRead/AsyncWrite as well. (Note that this
/// client actually does do a key exchange and it data is encrypted.) Once
/// established, the host (this program) requests the client to forward the
/// ports that it via `tcpip-forward` requests. Clients then open
/// `forwarded-tcpip` channels for each new connection.
///
/// ```text
///        ┌───────────┐     ┌───────┐      ┌───────┐
///        │Host (this)│     │Service│      │Client │
///        └─────┬─────┘     └───┬───┘      └───┬───┘
///              │ Connect as    │              │
///              ├─SSH client────▶              │
///              │               │  Connect to  │
///              │               ◀──service ws──┤
///              │   Create new  │              │
///              ◀───SSH tunnel──┤              │
///              │               │              │
///              │    SSH server handshake.     │
///              ├────(Service just proxies ────▶
///              │      traffic through)        │
///              │               │              │
///              ├────tcpip-forward for ports───▶
///              │               │              │
///              │               │              ◀───asked to
///              │               │              │   connect
///              ◀────create forwarded-tcpip ───┤
///      make    │            channel           │
/// local tcp ◀──┤               │              │
/// connection   │               │              │
///              ◀ ─ ─ ─ ─forward traffic─ ─ ─ ─▶
///              │               │              │
///              │               │              │
///              ▼               ▼              ▼
/// ```
///
/// ## How this Package Works
///
/// The RelayTunnelHost allows the consumer to `connect()` to a tunnel. It's legal
/// to call this in parallel (though not generally useful...) The host keeps
/// a map of the forwarded ports in a tokio watch channel, which allows
/// connected channels to update them in realtime. Each port also has a channel
/// on which incoming connections can be received.
///
/// When the client creates a new channel for a client, that's sent back on
/// a channel, where it's wrapepd in the "AsyncRWChannel" to provide
/// AsyncRead/Write traits, and then spawned in its own Tokio task.
///
/// It watches the ports list, and when new forwarded channels are made, it
/// wraps those in a ForwardedPortConnection struct, and sends those to the
/// channel on the port record.
///
/// Ports are handled by a client calling `add_port()` or `add_port_raw()`,
/// which either forward to a local TCP connection or return the
/// ForwardedPortConnection directly, respectively.
#[allow(dead_code)]
impl RelayTunnelHost {
	pub fn new(locator: TunnelLocator, mgmt: TunnelManagementClient) -> Self {
		let host_id = Uuid::new_v4();
		let (ports_tx, ports_rx) = watch::channel(HashMap::new());
		RelayTunnelHost {
			proxy: env::var("HTTPS_PROXY").or(env::var("https_proxy")).ok(),
			host_id,
			locator,
			ports_tx,
			ports_rx,
			mgmt,
			host_keypair: russh::keys::ssh_key::private::RsaKeypair::random(
				&mut rand_new::rng(),
				2048,
			)
			.expect("expected to generate rsa keypair")
			.into(),
		}
	}

	/// Creates a connection and returns a handle to the tunnel relay. When
	/// created, the tunnel will forward all ports currently on the tunnel.
	/// The returned handle is a future that completes when the tunnel closes.
	/// For example:
	///
	/// ```ignore
	/// let handle = relay.connect("host_token").await?;
	///
	/// tokio::spawn(async move || {
	///     loop {
	///       tokio::select! {
	///         port = add_port.recv() => handle.add_port(port).await?;
	///         handle => break,
	///       }
	///     }
	/// });
	/// ```
	///
	/// The handle may be dropped in order to disconnect from the relay, and
	/// will be closed if connection to the relay fails. Consumers should
	/// reconnect if this happens, and they can reconnect using the same
	/// RelayTunnelHost.
	pub async fn connect(&mut self, host_token: &str) -> Result<RelayHandle, TunnelError> {
		let (cnx, endpoint) = self.create_websocket(host_token).await?;
		let cnx = AsyncRWWebSocket::new(super::ws::AsyncRWWebSocketOptions {
			websocket: cnx,
			ping_interval: Duration::from_secs(60),
			ping_timeout: Duration::from_secs(10),
		});

		let (client_session, mut rx) = RelayTunnelHost::make_ssh_client(cnx)
			.await
			.map_err(TunnelError::TunnelRelayDisconnected)?;
		let client_session = Arc::new(client_session);
		let client_session_ret = client_session.clone();

		log::debug!("established host relay primary session");

		let mut channels = HashMap::new();
		let ports_rx = self.ports_rx.clone();
		let host_keypair = self.host_keypair.clone();
		let join = tokio::spawn(async move {
			let mut server = RelayTunnelHost::make_ssh_server(host_keypair.clone());
			loop {
				tokio::select! {
					Some(op) = rx.recv() => match op {
						ChannelOp::Open(id) => {
							let (rw, sender) = AsyncRWChannel::new(id, client_session.clone());
							server.run_stream(rw, ports_rx.clone());
							// do we need to store the JoinHandle for any reason?
							channels.insert(id, sender);
							log::info!("Opened new client on channel {}", id);
						},
						ChannelOp::Close(id) => {
							channels.remove(&id);
						},
						ChannelOp::Data(id, data) => {
							if let Some(ch) = channels.get(&id) {
								if ch.send(data).is_err() { // rx was dropped
									channels.remove(&id);
								}
							}
						},
					},
					else => break,
				}
			}

			client_session
				.disconnect(russh::Disconnect::ByApplication, "going away", "en")
				.await
				.ok();

			log::debug!("disconnected primary session after EOF");

			Ok(())
		});

		Ok(RelayHandle {
			endpoint,
			join,
			session: client_session_ret,
		})
	}

	/// Unregisters relay from the tunnel's list of hosts.
	pub async fn unregister(&self) -> Result<bool, TunnelError> {
		self.mgmt
			.delete_tunnel_endpoints(
				&self.locator,
				&format!("{}-relay", &self.host_id.to_string()),
				NO_REQUEST_OPTIONS,
			)
			.await
			.map_err(|e| TunnelError::HttpError {
				error: e,
				reason: "could not unregister relay",
			})
	}

	/// Adds a new port to the relay and returns a receiver for connections
	/// that are made to that port. This is a "low level" type that you can use
	/// if you want to deal with forwarding manually, but the `add_port` method
	/// is appropriate and simpler for most use cases.
	///
	/// Calling this method multiple times with the same port will result in
	/// an error. Dropping the receiver **will not** remove the port, you must
	/// call `remove_port()` to do that.
	pub async fn add_port_raw(
		&self,
		port_to_add: &TunnelPort,
	) -> Result<mpsc::UnboundedReceiver<ForwardedPortConnection>, TunnelError> {
		let n = port_to_add.port_number as u32;
		if self.ports_tx.borrow().get(&n).is_some() {
			return Err(TunnelError::PortAlreadyExists(n));
		}

		let tunnel_port = self
			.mgmt
			.create_tunnel_port(&self.locator, port_to_add, NO_REQUEST_OPTIONS)
			.await;

		match tunnel_port {
			// created the port:
			Ok(_) => {}
			// the port's already registered, nothing we need to do:
			Err(HttpError::ResponseError(e)) if e.status_code == 409 => {}
			Err(e) => {
				return Err(TunnelError::HttpError {
					error: e,
					reason: "failed to add port to tunnel",
				})
			}
		}

		let (tx, rx) = mpsc::unbounded_channel();
		self.ports_tx.send_modify(|v| {
			v.insert(n, tx);
		});

		Ok(rx)
	}

	/// Adds a new port to the tunnel and forwards TCP/IP connections made
	/// over that port to the local machine. Calling this method multiple times
	/// with the same port will result in an error.
	pub async fn add_port(&self, port_to_add: &TunnelPort) -> Result<(), TunnelError> {
		let rx = self.add_port_raw(port_to_add).await?;
		tokio::spawn(forward_port_to_tcp(port_to_add.port_number, rx));
		Ok(())
	}

	/// Removes a port from the tunnel connection. Any channel returned from
	/// `add_port_raw`, and any connections made within `add_port`, will close
	/// shortly after this is called.
	pub async fn remove_port(&self, port_number: u16) -> Result<(), TunnelError> {
		self.mgmt
			.delete_tunnel_port(&self.locator, port_number, NO_REQUEST_OPTIONS)
			.await
			.map_err(|e| TunnelError::HttpError {
				error: e,
				reason: "failed to remove port from tunnel",
			})?;

		self.ports_tx.send_modify(|v| {
			v.remove(&(port_number as u32));
		});

		Ok(())
	}

	fn make_ssh_server(keypair: russh::keys::PrivateKey) -> Server {
		let c = russh::server::Config {
			inactivity_timeout: None,
			auth_rejection_time: std::time::Duration::from_secs(5),
			keys: vec![keypair],
			window_size: 1024 * 1024,
			preferred: russh::Preferred::COMPRESSED,
			limits: russh::Limits {
				rekey_read_limit: usize::MAX,
				rekey_time_limit: Duration::MAX,
				rekey_write_limit: usize::MAX,
			},
			..Default::default()
		};

		let config = Arc::new(c);
		Server { config }
	}

	fn host_public_keys_for_endpoint(&self) -> Vec<String> {
		encode_host_public_keys(&self.host_keypair)
	}

	async fn make_ssh_client(
		rw: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
	) -> Result<
		(
			russh::client::Handle<Client>,
			mpsc::UnboundedReceiver<ChannelOp>,
		),
		russh::Error,
	> {
		let config = russh::client::Config {
			anonymous: true,
			window_size: 1024 * 1024 * 5,
			preferred: russh::Preferred {
				kex: vec![russh::kex::NONE].into(),
				key: russh::Preferred::DEFAULT.key,
				cipher: vec![russh::cipher::NONE].into(),
				mac: russh::Preferred::DEFAULT.mac,
				compression: vec![russh::compression::NONE].into(),
				..Default::default()
			},
			limits: russh::Limits {
				rekey_read_limit: 1024 * 1024 * 8,
				rekey_time_limit: std::time::Duration::from_secs(60),
				rekey_write_limit: 1024 * 1024 * 8,
			},
			..Default::default()
		};

		let config = Arc::new(config);
		let (client, rx) = Client::new();
		let session = russh::client::connect_stream(config, rw, client).await?;

		Ok((session, rx))
	}

	async fn create_websocket(
		&self,
		host_token: &str,
	) -> Result<(WebSocketStream<MaybeTlsStream<TcpStream>>, TunnelEndpoint), TunnelError> {
		let endpoint = self
			.mgmt
			.update_tunnel_relay_endpoints(
				&self.locator,
				&TunnelEndpoint {
					id: Some(format!("{}-relay", self.host_id)),
					connection_mode: TunnelConnectionMode::TunnelRelay,
					host_id: self.host_id.to_string(),
					host_public_keys: self.host_public_keys_for_endpoint(),
					port_uri_format: None,
					port_ssh_command_format: None,
					ssh_gateway_public_key: None,
					tunnel_ssh_command: None,
					tunnel_uri: None,
					local_network_tunnel_endpoint: Default::default(),
					tunnel_relay_tunnel_endpoint: Default::default(),
				},
				&TunnelRequestOptions {
					authorization: Some(Authorization::Tunnel(host_token.to_string())),
					..TunnelRequestOptions::default()
				},
			)
			.await
			.map_err(|e| TunnelError::HttpError {
				error: e,
				reason: "failed to update tunnel endpoint for hosting",
			})?;

		let url = endpoint
			.tunnel_relay_tunnel_endpoint
			.host_relay_uri
			.as_deref()
			.ok_or(TunnelError::MissingHostEndpoint)?;

		let req = build_websocket_request(
			url,
			&[
				("Sec-WebSocket-Protocol", "tunnel-relay-host"),
				("Authorization", &format!("tunnel {}", host_token)),
				("User-Agent", self.mgmt.user_agent.to_str().unwrap()),
			],
		)?;

		let cnx = if let Some(proxy) = &self.proxy {
			log::debug!("connecting via http_proxy on {}", proxy);
			connect_via_proxy(req, proxy).await?
		} else {
			connect_directly(req).await?
		};

		Ok((cnx, endpoint))
	}
}

/// Encodes the host's public key(s) for advertisement in a TunnelEndpoint.
///
/// We use the canonical SSH wire-format encoding of the public key (for RSA,
/// this is the "ssh-rsa" blob, regardless of which signature-hash variant the
/// keypair was generated with). This is the same form the russh client
/// recovers from the server's host key during key exchange and base64-encodes
/// via `PublicKey::public_key_base64()`, which is what `RelayTunnelClient`
/// compares against.
///
/// Note: `KeyPair::public_key_base64()` is *not* equivalent — for RSA it
/// includes the hash variant (e.g. "rsa-sha2-256") in the blob, which would
/// never match what the client sees on the wire.
fn encode_host_public_keys(keypair: &russh::keys::PrivateKey) -> Vec<String> {
	let public_key = keypair.public_key();
	vec![public_key.public_key_base64()]
}

/// Type returned in a channel from `add_forwarded_port_raw`, implementing
/// `AsyncRead` and `AsyncWrite`.
pub struct ForwardedPortConnection {
	port: u32,
	channel: russh::ChannelId,
	handle: russh::server::Handle,
	receiver: mpsc::Receiver<Vec<u8>>,
}

impl ForwardedPortConnection {
	/// Sends data on the connection.
	pub async fn send(&mut self, d: &[u8]) -> Result<(), ()> {
		self.handle
			.data(self.channel, d.to_vec())
			.await
			.map_err(|_| ())
	}

	/// Receives data from the connection, returning None when it's closed.
	pub async fn recv(&mut self) -> Option<Vec<u8>> {
		self.receiver.recv().await
	}

	/// Closes the forwarded connection.
	pub async fn close(self) {
		self.handle.close(self.channel).await.ok();
	}

	/// Returns an AsyncRead/AsyncWrite implementation for the connection.
	pub fn into_rw(self) -> ForwardedPortRW {
		let (w, r) = self.into_split();
		ForwardedPortRW(r, w)
	}

	/// Returns a split AsyncRead/AsyncWrite half for the connection.
	pub fn into_split(self) -> (ForwardedPortWriter, ForwardedPortReader) {
		(
			ForwardedPortWriter {
				channel: self.channel,
				handle: self.handle,
				is_write_fut_valid: false,
				write_len: 0,
				write_fut: tokio_util::sync::ReusableBoxFuture::new(make_server_write_fut(None)),
			},
			ForwardedPortReader {
				receiver: self.receiver,
				readbuf: super::io::ReadBuffer::default(),
			},
		)
	}
}

/// AsyncWrite implementation that can be obtained from the ForwardedPortConnection.
pub struct ForwardedPortWriter {
	channel: russh::ChannelId,
	handle: russh::server::Handle,
	is_write_fut_valid: bool,
	write_len: usize,
	write_fut: tokio_util::sync::ReusableBoxFuture<'static, Result<(), bytes::Bytes>>,
}

/// Makes a future that writes to the russh handle. This general approach was
/// taken from https://docs.rs/tokio-util/0.7.3/tokio_util/sync/struct.PollSender.html
/// This is just like make_client_write_fut, but for clients (they don't share a trait...)
async fn make_server_write_fut(
	data: Option<(russh::server::Handle, russh::ChannelId, Vec<u8>)>,
) -> Result<(), bytes::Bytes> {
	match data {
		Some((client, id, data)) => client.data(id, data).await,
		None => unreachable!("this future should not be pollable in this state"),
	}
}

impl AsyncWrite for ForwardedPortWriter {
	fn poll_write(
		mut self: Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
		buf: &[u8],
	) -> Poll<Result<usize, io::Error>> {
		if buf.is_empty() {
			return Poll::Ready(Ok(0));
		}

		if !self.is_write_fut_valid {
			let handle = self.handle.clone();
			let id = self.channel;
			let write_len = buf.len().min(CHANNEL_WRITE_CHUNK_SIZE);
			self.write_len = write_len;
			self.write_fut.set(make_server_write_fut(Some((
				handle,
				id,
				buf[..write_len].to_vec(),
			))));
			self.is_write_fut_valid = true;
		}

		let write_len = self.write_len;
		self.poll_flush(cx).map(|r| r.map(|_| write_len))
	}

	fn poll_flush(
		mut self: Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
	) -> Poll<Result<(), io::Error>> {
		if !self.is_write_fut_valid {
			return Poll::Ready(Ok(()));
		}

		match self.write_fut.poll(cx) {
			Poll::Pending => Poll::Pending,
			Poll::Ready(Ok(_)) => {
				self.is_write_fut_valid = false;
				Poll::Ready(Ok(()))
			}
			Poll::Ready(Err(_)) => {
				self.is_write_fut_valid = false;
				Poll::Ready(Err(io::Error::other("EOF")))
			}
		}
	}

	fn poll_shutdown(
		self: Pin<&mut Self>,
		_cx: &mut std::task::Context<'_>,
	) -> Poll<Result<(), io::Error>> {
		Poll::Ready(Ok(()))
	}
}

/// AsyncRead implementation that can be obtained from the ForwardedPortConnection.
pub struct ForwardedPortReader {
	receiver: mpsc::Receiver<Vec<u8>>,
	readbuf: super::io::ReadBuffer,
}

impl AsyncRead for ForwardedPortReader {
	fn poll_read(
		mut self: Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
		buf: &mut tokio::io::ReadBuf<'_>,
	) -> Poll<io::Result<()>> {
		if let Some((v, s)) = self.readbuf.take_data() {
			return self.readbuf.put_data(buf, v, s);
		}

		match self.receiver.poll_recv(cx) {
			Poll::Ready(Some(msg)) => self.readbuf.put_data(buf, msg, 0),
			Poll::Ready(None) => Poll::Ready(Err(io::Error::other("EOF"))),
			Poll::Pending => Poll::Pending,
		}
	}
}

pub struct ForwardedPortRW(ForwardedPortReader, ForwardedPortWriter);

impl AsyncRead for ForwardedPortRW {
	fn poll_read(
		mut self: Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
		buf: &mut tokio::io::ReadBuf<'_>,
	) -> Poll<io::Result<()>> {
		Pin::new(&mut self.0).poll_read(cx, buf)
	}
}

impl AsyncWrite for ForwardedPortRW {
	fn poll_write(
		mut self: Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
		buf: &[u8],
	) -> Poll<Result<usize, io::Error>> {
		Pin::new(&mut self.1).poll_write(cx, buf)
	}
	fn poll_flush(
		mut self: Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
	) -> Poll<Result<(), io::Error>> {
		Pin::new(&mut self.1).poll_flush(cx)
	}
	fn poll_shutdown(
		mut self: Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
	) -> Poll<Result<(), io::Error>> {
		Pin::new(&mut self.1).poll_shutdown(cx)
	}
}

#[derive(Clone)]
struct Server {
	config: Arc<russh::server::Config>,
}

impl Server {
	pub fn run_stream(
		&mut self,
		rw: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,
		mut ports: watch::Receiver<PortMap>,
	) -> JoinHandle<Result<(), russh::Error>> {
		let mut server_session = self.new_client(None);
		let mut server_connection_rx = server_session.take_rx().expect("expected to have tx");
		let authed_tx = server_session.take_authed().expect("expected to have tx");

		let config = self.config.clone();
		tokio::spawn(async move {
			log::debug!("starting to serve host relay client session");
			let session = match russh::server::run_stream(config, rw, server_session).await {
				Ok(s) => s,
				Err(e) => {
					log::error!("error handshaking session: {}", e);
					return Err(e);
				}
			};

			if authed_tx.await.is_err() {
				log::debug!("connection closed before auth");
				return Ok(()); // session closed
			}

			log::debug!("host relay client session successfully authed");
			let mut known_ports: PortMap = HashMap::new();
			tokio::pin!(session);

			loop {
				tokio::select! {
					r = &mut session => return r,
					cnx = server_connection_rx.recv() => match cnx {
						Some(cnx) => {
							if let Some(p) = known_ports.get(&cnx.port) {
								p.send(cnx).ok(); // ignore error, could have dropped in the meantime
							} else {
								log::debug!("rejecting connection to unknown port {}", cnx.port);
								cnx.close().await;
							}
						},
						None => {
							log::debug!("no more connections on host relay client session, ending");
							return Ok(());
						},
					},
					_ = ports.changed() => {
						let new_ports = ports.borrow().clone();
						for port in new_ports.keys() {
							if !known_ports.contains_key(port) {
								session.handle().forward_tcpip("127.0.0.1".to_string(), *port).await.ok();
							}
						}
						for port in known_ports.keys() {
							if !new_ports.contains_key(port) {
								session.handle().cancel_forward_tcpip("127.0.0.1".to_string(), *port).await.ok();
							}
						}

						known_ports = new_ports;
					},
				}
			}
		})
	}
}

/// Connects connections that are sent to the receiver to TCP services locally.
/// Runs until the receiver is closed (usually via `delete_port()`).
async fn forward_port_to_tcp(port: u16, mut rx: mpsc::UnboundedReceiver<ForwardedPortConnection>) {
	let ipv4_addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
	let ipv6_addr = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port);
	while let Some(mut conn) = rx.recv().await {
		// Try connecting to ipv4 and ipv6 in parallel, using the first successful
		// connection in the stream. A downside is that it means if different sevices
		// are listening on the ports, the forwarded application is non-deterministic.
		//
		// But that's rare, and in other cases, one interface will time out and
		// one interface will work, so this lets us respond as quickly as possible.
		let mut futs = FuturesUnordered::new();
		futs.push(TcpStream::connect(&ipv4_addr));
		futs.push(TcpStream::connect(&ipv6_addr));

		let mut last_result = None;
		while let Some(r) = futs.next().await {
			let ok = r.is_ok();
			last_result = Some(r);
			// stop on first successful:
			if ok {
				break;
			}
		}

		// unwrap is safe since we know there will be at least one result:
		let mut stream = match last_result.unwrap() {
			Ok(s) => s,
			Err(e) => {
				log::info!("Error connecting forwarding to port {}, {}", port, e);
				conn.close().await;
				continue;
			}
		};

		log::debug!("Forwarded connection to port {}", port);

		tokio::spawn(async move {
			let mut read_buf = vec![0u8; 1024 * 64].into_boxed_slice();
			loop {
				tokio::select! {
					n = stream.read(&mut read_buf) => match n {
						Ok(0) => {
							log::debug!("EOF from TCP stream, ending");
							break;
						},
						Ok(n) => {
							if (conn.send(&read_buf[..n]).await).is_err() {
								log::debug!("channel was closed, ending forwarded port");
								break;
							}
						},
						Err(e) => {
							log::debug!("error from TCP stream, ending: {}", e);
							break;
						}
					},
					m = conn.recv() => match m {
						Some(data) => {
							if let Err(e) = stream.write_all(&data).await {
								log::debug!("error writing data to channel, ending: {}", e);
								break;
							}
						},
						None => {
							log::debug!("EOF from channel, ending");
							break;
						}
					}
				}
			}
		});
	}
}

impl ServerTrait for Server {
	type Handler = ServerHandle;
	fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> ServerHandle {
		ServerHandle::new()
	}
}

struct ServerHandle {
	authed_tx: Option<oneshot::Sender<()>>,
	authed_rx: Option<oneshot::Receiver<()>>,
	cnx_tx: mpsc::UnboundedSender<ForwardedPortConnection>,
	cnx_rx: Option<mpsc::UnboundedReceiver<ForwardedPortConnection>>,
	channel_senders: HashMap<russh::ChannelId, mpsc::Sender<Vec<u8>>>,
}

impl ServerHandle {
	pub fn new() -> Self {
		let (authed_tx, authed_rx) = oneshot::channel();
		let (cnx_tx, cnx_rx) = mpsc::unbounded_channel();
		Self {
			authed_rx: Some(authed_rx),
			authed_tx: Some(authed_tx),
			cnx_rx: Some(cnx_rx),
			cnx_tx,
			channel_senders: HashMap::new(),
		}
	}

	/// Takes the receiver from a newly-created handle.
	pub fn take_rx(&mut self) -> Option<mpsc::UnboundedReceiver<ForwardedPortConnection>> {
		self.cnx_rx.take()
	}

	/// Takes the receiver from a newly-created handle.
	pub fn take_authed(&mut self) -> Option<oneshot::Receiver<()>> {
		self.authed_rx.take()
	}
}

impl russh::server::Handler for ServerHandle {
	type Error = russh::Error;

	async fn auth_succeeded(
		&mut self,
		_session: &mut russh::server::Session,
	) -> Result<(), Self::Error> {
		if let Some(tx) = self.authed_tx.take() {
			tx.send(()).ok();
		}
		Ok(())
	}

	/// Connecting clients will use "none" auth on their channels.
	async fn auth_none(&mut self, _: &str) -> Result<russh::server::Auth, Self::Error> {
		Ok(russh::server::Auth::Accept)
	}

	async fn channel_open_forwarded_tcpip(
		&mut self,
		channel: russh::Channel<russh::server::Msg>,
		_host_to_connect: &str,
		port_to_connect: u32,
		_originator_address: &str,
		_originator_port: u32,
		reply: russh::server::ChannelOpenHandle,
		session: &mut russh::server::Session,
	) -> Result<(), Self::Error> {
		let (sender, receiver) = mpsc::channel(10);
		let txd = self.cnx_tx.send(ForwardedPortConnection {
			port: port_to_connect,
			channel: channel.id(),
			handle: session.handle(),
			receiver,
		});
		if txd.is_ok() {
			self.channel_senders.insert(channel.id(), sender);
			reply.accept().await;
		}

		Ok(())
	}

	async fn channel_open_direct_tcpip(
		&mut self,
		channel: russh::Channel<russh::server::Msg>,
		_host_to_connect: &str,
		port_to_connect: u32,
		_originator_address: &str,
		_originator_port: u32,
		reply: russh::server::ChannelOpenHandle,
		session: &mut russh::server::Session,
	) -> Result<(), Self::Error> {
		let (sender, receiver) = mpsc::channel(10);
		let txd = self.cnx_tx.send(ForwardedPortConnection {
			port: port_to_connect,
			channel: channel.id(),
			handle: session.handle(),
			receiver,
		});
		if txd.is_ok() {
			self.channel_senders.insert(channel.id(), sender);
			reply.accept().await;
		}

		Ok(())
	}

	async fn data(
		&mut self,
		channel: russh::ChannelId,
		data: &[u8],
		_session: &mut russh::server::Session,
	) -> Result<(), Self::Error> {
		let data_vec = data.to_vec();
		if let Some(sender) = self.channel_senders.get(&channel) {
			if sender.send(data_vec).await.is_err() {
				self.channel_senders.remove(&channel);
			}
		}
		Ok(())
	}

	async fn channel_close(
		&mut self,
		channel: russh::ChannelId,
		_session: &mut russh::server::Session,
	) -> Result<(), Self::Error> {
		self.channel_senders.remove(&channel);
		Ok(())
	}
}

/// Type sent from the Handler back to the processing queue. This can be a
/// channel starting or stopping, or data on a channel.
#[derive(Debug)]
enum ChannelOp {
	Open(russh::ChannelId),
	Close(russh::ChannelId),
	Data(russh::ChannelId, Vec<u8>),
}

/// The Client implements the russh handler for the main SSH session on which
/// connections will come in via channels.
struct Client {
	sender: mpsc::UnboundedSender<ChannelOp>,
}

impl Client {
	pub fn new() -> (Self, mpsc::UnboundedReceiver<ChannelOp>) {
		let (tx, rx) = mpsc::unbounded_channel();
		(Client { sender: tx }, rx)
	}
}

impl russh::client::Handler for Client {
	type Error = russh::Error;

	async fn check_server_key(
		&mut self,
		_server_public_key: &russh::keys::PublicKeyOrCertificate,
	) -> Result<bool, Self::Error> {
		Ok(true)
	}

	async fn should_accept_unknown_server_channel(
		&mut self,
		_channel: russh::ChannelId,
		channel_type: &str,
	) -> bool {
		channel_type == "client-ssh-session-stream"
	}

	async fn server_channel_open_unknown(
		&mut self,
		channel: russh::Channel<russh::client::Msg>,
		reply: russh::client::ChannelOpenHandle,
		_session: &mut russh::client::Session,
	) -> Result<(), Self::Error> {
		if self.sender.send(ChannelOp::Open(channel.id())).is_ok() {
			reply.accept().await;
		}
		Ok(())
	}

	async fn channel_close(
		&mut self,
		channel: russh::ChannelId,
		_session: &mut russh::client::Session,
	) -> Result<(), Self::Error> {
		self.sender.send(ChannelOp::Close(channel)).ok();
		Ok(())
	}

	async fn data(
		&mut self,
		channel: russh::ChannelId,
		data: &[u8],
		_session: &mut russh::client::Session,
	) -> Result<(), Self::Error> {
		self.sender
			.send(ChannelOp::Data(channel, data.to_vec()))
			.ok();
		Ok(())
	}
}

/// AsyncRead/AsyncWrite for converting SSH Channels into AsyncRead/AsyncWrite.
struct AsyncRWChannel {
	id: russh::ChannelId,
	session: Arc<russh::client::Handle<Client>>,
	incoming: mpsc::UnboundedReceiver<Vec<u8>>,

	readbuf: super::io::ReadBuffer,

	is_write_fut_valid: bool,
	write_len: usize,
	write_fut: tokio_util::sync::ReusableBoxFuture<'static, Result<(), bytes::Bytes>>,
}

impl AsyncRWChannel {
	pub fn new(
		id: russh::ChannelId,
		session: Arc<russh::client::Handle<Client>>,
	) -> (Self, mpsc::UnboundedSender<Vec<u8>>) {
		let (tx, rx) = mpsc::unbounded_channel();
		(
			AsyncRWChannel {
				id,
				session,
				incoming: rx,
				readbuf: super::io::ReadBuffer::default(),
				is_write_fut_valid: false,
				write_len: 0,
				write_fut: tokio_util::sync::ReusableBoxFuture::new(make_client_write_fut(None)),
			},
			tx,
		)
	}
}

/// Makes a future that writes to the russh handle. This general approach was
/// taken from https://docs.rs/tokio-util/0.7.3/tokio_util/sync/struct.PollSender.html
/// This is just like make_server_write_fut, but for clients (they don't share a trait...)
async fn make_client_write_fut(
	data: Option<(
		Arc<russh::client::Handle<Client>>,
		russh::ChannelId,
		Vec<u8>,
	)>,
) -> Result<(), bytes::Bytes> {
	match data {
		Some((client, id, data)) => client.data(id, data).await,
		None => unreachable!("this future should not be pollable in this state"),
	}
}

impl AsyncWrite for AsyncRWChannel {
	fn poll_write(
		mut self: Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
		buf: &[u8],
	) -> Poll<Result<usize, io::Error>> {
		if buf.is_empty() {
			return Poll::Ready(Ok(0));
		}

		if !self.is_write_fut_valid {
			let session = self.session.clone();
			let id = self.id;
			let write_len = buf.len().min(CHANNEL_WRITE_CHUNK_SIZE);
			self.write_len = write_len;
			self.write_fut.set(make_client_write_fut(Some((
				session,
				id,
				buf[..write_len].to_vec(),
			))));
			self.is_write_fut_valid = true;
		}

		let write_len = self.write_len;
		self.poll_flush(cx).map(|r| r.map(|_| write_len))
	}

	fn poll_flush(
		mut self: Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
	) -> Poll<Result<(), io::Error>> {
		if !self.is_write_fut_valid {
			return Poll::Ready(Ok(()));
		}

		match self.write_fut.poll(cx) {
			Poll::Pending => Poll::Pending,
			Poll::Ready(Ok(_)) => {
				self.is_write_fut_valid = false;
				Poll::Ready(Ok(()))
			}
			Poll::Ready(Err(_)) => {
				self.is_write_fut_valid = false;
				Poll::Ready(Err(io::Error::other("EOF")))
			}
		}
	}

	fn poll_shutdown(
		self: Pin<&mut Self>,
		_cx: &mut std::task::Context<'_>,
	) -> Poll<Result<(), io::Error>> {
		Poll::Ready(Ok(()))
	}
}

impl AsyncRead for AsyncRWChannel {
	fn poll_read(
		mut self: Pin<&mut Self>,
		cx: &mut std::task::Context<'_>,
		buf: &mut tokio::io::ReadBuf<'_>,
	) -> Poll<io::Result<()>> {
		if let Some((v, s)) = self.readbuf.take_data() {
			return self.readbuf.put_data(buf, v, s);
		}

		match self.incoming.poll_recv(cx) {
			Poll::Ready(Some(msg)) => self.readbuf.put_data(buf, msg, 0),
			Poll::Ready(None) => Poll::Ready(Err(io::Error::other("EOF"))),
			Poll::Pending => Poll::Pending,
		}
	}
}

pub struct RelayHandle {
	endpoint: TunnelEndpoint,
	session: Arc<russh::client::Handle<Client>>,
	join: JoinHandle<Result<(), russh::Error>>,
}

impl RelayHandle {
	/// Gets the endpoint this relay is connected to.
	pub fn endpoint(&self) -> &TunnelEndpoint {
		&self.endpoint
	}

	/// Closes the tunnel and waits for all associated tasks to end.
	pub async fn close(self) -> Result<(), TunnelError> {
		let result = self
			.session
			.disconnect(russh::Disconnect::ByApplication, "disconnect", "en")
			.await;
		self.join.await.ok();
		result.map_err(TunnelError::TunnelRelayDisconnected)
	}
}

impl std::future::Future for RelayHandle {
	type Output = Result<(), TunnelError>;
	fn poll(mut self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> Poll<Self::Output> {
		match std::future::Future::poll(Pin::new(&mut self.join), cx) {
			Poll::Ready(r) => Poll::Ready(match r {
				Ok(Ok(_)) => Ok(()),
				Ok(Err(e)) => Err(TunnelError::TunnelRelayDisconnected(e)),
				Err(_) => Ok(()),
			}),
			Poll::Pending => Poll::Pending,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::connections::tcp_pair;
	use russh::keys::PrivateKey;

	/// Regression test for an interop bug where the host advertised RSA
	/// public keys using `KeyPair::public_key_base64()` (which encodes the
	/// hash-variant name like "rsa-sha2-256") while the client compared
	/// against `PublicKey::public_key_base64()` (which always encodes the
	/// canonical SSH wire name "ssh-rsa"). The two never matched and all
	/// connections failed with "Unknown server key".
	#[test]
	fn encodes_rsa_public_key_in_canonical_ssh_wire_form() {
		let keypair: PrivateKey =
			russh::keys::ssh_key::private::RsaKeypair::random(&mut rand_new::rng(), 2048)
				.expect("generate rsa keypair")
				.into();

		let advertised = encode_host_public_keys(&keypair);
		assert_eq!(advertised.len(), 1, "expected exactly one host public key");

		// The advertised key must equal the base64 encoding of the
		// corresponding `PublicKey` — this is what `RelayTunnelClient`
		// computes from the server's host key during SSH key exchange.
		let public_key_b64 = keypair.public_key().public_key_base64();
		assert_eq!(advertised[0], public_key_b64);
	}

	#[test]
	fn rsa_backend_preserves_sign_verify_and_private_key_formats() {
		use russh::keys::{
			signature::{Signer, Verifier},
			ssh_key::{LineEnding, Signature},
			HashAlg,
		};
		let key =
			PrivateKey::from_openssh(include_str!("../../../ssh-key/tests/examples/id_rsa_3072"))
				.unwrap();
		let pair = key.key_data().rsa().unwrap();
		let private = pair.private();
		let corrupt = russh::keys::ssh_key::private::RsaPrivateKey::new(
			private.d().clone(),
			russh::keys::ssh_key::Mpint::from_positive_bytes(&[1]),
			private.p().clone(),
			private.q().clone(),
		)
		.unwrap();
		assert_ne!(private, &corrupt);
		let corrupt =
			russh::keys::ssh_key::private::RsaKeypair::new(pair.public().clone(), corrupt).unwrap();
		assert!((&corrupt, Some(HashAlg::Sha256))
			.try_sign(b"invalid CRT fixture")
			.is_err());
		for hash in [None, Some(HashAlg::Sha256), Some(HashAlg::Sha512)] {
			let signature = (pair, hash).try_sign(b"rsa backend regression").unwrap();
			key.public_key()
				.key_data()
				.verify(b"rsa backend regression", &signature)
				.unwrap();
			assert!(key
				.public_key()
				.key_data()
				.verify(b"changed message", &signature)
				.is_err());
			let mut bytes = signature.as_bytes().to_vec();
			bytes[0] ^= 1;
			let corrupt = Signature::new(signature.algorithm(), bytes).unwrap();
			assert!(key
				.public_key()
				.key_data()
				.verify(b"rsa backend regression", &corrupt)
				.is_err());
		}
		let encoded = key.to_openssh(LineEnding::LF).unwrap();
		let parsed = PrivateKey::from_openssh(encoded.as_str()).unwrap();
		assert_eq!(parsed.public_key().key_data(), key.public_key().key_data());
		let mut pem = Vec::new();
		russh::keys::encode_pkcs8_pem(&key, &mut pem).unwrap();
		let pem = String::from_utf8(pem).unwrap();
		let parsed = russh::keys::decode_secret_key(&pem, None).unwrap();
		assert_eq!(parsed.public_key().key_data(), key.public_key().key_data());
		let mut encrypted = Vec::new();
		russh::keys::encode_pkcs8_pem_encrypted(&key, b"fixture password", 1000, &mut encrypted)
			.unwrap();
		let encrypted = String::from_utf8(encrypted).unwrap();
		assert!(russh::keys::decode_secret_key(&encrypted, Some("wrong password")).is_err());
		let parsed = russh::keys::decode_secret_key(&encrypted, Some("fixture password")).unwrap();
		assert_eq!(parsed.public_key().key_data(), key.public_key().key_data());
		let native: openssl::rsa::Rsa<openssl::pkey::Private> = pair.try_into().unwrap();
		for cipher in [
			openssl::symm::Cipher::aes_128_cbc(),
			openssl::symm::Cipher::aes_256_cbc(),
		] {
			let pem = String::from_utf8(
				native
					.private_key_to_pem_passphrase(cipher, b"fixture password")
					.unwrap(),
			)
			.unwrap();
			let parsed = russh::keys::decode_secret_key(&pem, Some("fixture password")).unwrap();
			assert_eq!(parsed.public_key().key_data(), key.public_key().key_data());
			assert!(russh::keys::decode_secret_key(&pem, None).is_err());
			assert!(russh::keys::decode_secret_key(&pem, Some("wrong password")).is_err());
			let (headers, body) = pem.split_once("\n\n").unwrap();
			let corrupt = format!("{headers}\n\n{}", &body[4..]);
			assert!(russh::keys::decode_secret_key(&corrupt, Some("fixture password")).is_err());
		}
	}

	fn ssh_string(packet: &mut Vec<u8>, value: &[u8]) {
		packet.extend_from_slice(&(value.len() as u32).to_be_bytes());
		packet.extend_from_slice(value);
	}

	async fn send_packet(stream: &mut tokio::net::TcpStream, payload: &[u8]) {
		let mut padding = 8 - ((payload.len() + 5) % 8);
		if padding < 4 {
			padding += 8;
		}
		stream
			.write_u32((payload.len() + padding + 1) as u32)
			.await
			.unwrap();
		stream.write_u8(padding as u8).await.unwrap();
		stream.write_all(payload).await.unwrap();
		stream.write_all(&vec![0; padding]).await.unwrap();
		stream.flush().await.unwrap();
	}

	async fn read_packet(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
		let length = stream.read_u32().await.unwrap() as usize;
		assert!((5..=65536).contains(&length));
		let mut packet = vec![0; length];
		stream.read_exact(&mut packet).await.unwrap();
		let padding = packet[0] as usize;
		assert!(padding >= 4 && padding + 1 < length);
		packet[1..length - padding].to_vec()
	}

	fn none_kexinit() -> Vec<u8> {
		let mut init = vec![20];
		init.extend_from_slice(&[0; 16]);
		for list in [
			"none",
			"none",
			"none",
			"none",
			"hmac-sha2-256",
			"hmac-sha2-256",
			"none",
			"none",
			"",
			"",
		] {
			ssh_string(&mut init, list.as_bytes());
		}
		init.extend_from_slice(&[0; 5]);
		init
	}

	#[tokio::test]
	async fn relay_unknown_channel_opens_transfers_and_closes_on_real_transport() {
		tokio::time::timeout(Duration::from_secs(10), async {
			let (mut relay, client_stream) = tcp_pair().await;
			let peer = tokio::spawn(async move {
				relay
					.write_all(b"SSH-2.0-isolated-relay-fixture\r\n")
					.await
					.unwrap();
				let mut banner = Vec::new();
				loop {
					let byte = relay.read_u8().await.unwrap();
					banner.push(byte);
					assert!(banner.len() <= 255);
					if byte == b'\n' {
						break;
					}
				}
				assert!(banner.starts_with(b"SSH-2.0-"));
				assert_eq!(read_packet(&mut relay).await[0], 20);
				send_packet(&mut relay, &none_kexinit()).await;
				assert_eq!(read_packet(&mut relay).await, [21]);
				send_packet(&mut relay, &[21]).await;

				let mut open = vec![90];
				ssh_string(&mut open, b"client-ssh-session-stream");
				for value in [7_u32, 1024 * 1024, 32768] {
					open.extend_from_slice(&value.to_be_bytes());
				}
				send_packet(&mut relay, &open).await;
				let accepted = read_packet(&mut relay).await;
				assert_eq!(accepted[0], 91);
				assert_eq!(u32::from_be_bytes(accepted[1..5].try_into().unwrap()), 7);
				let id = u32::from_be_bytes(accepted[5..9].try_into().unwrap());
				let mut data = vec![94];
				data.extend_from_slice(&id.to_be_bytes());
				ssh_string(&mut data, b"from-relay");
				send_packet(&mut relay, &data).await;
				let received = read_packet(&mut relay).await;
				assert_eq!(received[0], 94);
				assert_eq!(&received[9..], b"from-host");

				let mut denied = vec![90];
				ssh_string(&mut denied, b"arbitrary-service");
				for value in [8_u32, 1024 * 1024, 32768] {
					denied.extend_from_slice(&value.to_be_bytes());
				}
				send_packet(&mut relay, &denied).await;
				let rejected = read_packet(&mut relay).await;
				assert_eq!(rejected[0], 92);
				assert_eq!(u32::from_be_bytes(rejected[1..5].try_into().unwrap()), 8);

				let mut close = vec![97];
				close.extend_from_slice(&id.to_be_bytes());
				send_packet(&mut relay, &close).await;
				let closed = read_packet(&mut relay).await;
				assert_eq!(closed[0], 97);
				assert_eq!(u32::from_be_bytes(closed[1..5].try_into().unwrap()), 7);
			});
			let (client, mut operations) = RelayTunnelHost::make_ssh_client(client_stream)
				.await
				.unwrap();
			let id = match operations.recv().await.unwrap() {
				ChannelOp::Open(id) => id,
				other => panic!("expected channel open, got {other:?}"),
			};
			match operations.recv().await.unwrap() {
				ChannelOp::Data(channel, data) => {
					assert_eq!(channel, id);
					assert_eq!(data, b"from-relay");
				}
				other => panic!("expected relay data, got {other:?}"),
			}
			client.data(id, b"from-host".to_vec()).await.unwrap();
			assert!(
				matches!(operations.recv().await.unwrap(), ChannelOp::Close(channel) if channel == id)
			);
			peer.await.unwrap();
			assert!(operations.try_recv().is_err());
		})
		.await
		.expect("relay fixture must complete within ten seconds");
	}

	struct EncryptedClient;

	impl russh::client::Handler for EncryptedClient {
		type Error = russh::Error;

		async fn check_server_key(
			&mut self,
			_: &russh::keys::PublicKeyOrCertificate,
		) -> Result<bool, Self::Error> {
			Ok(true)
		}
	}

	#[tokio::test]
	async fn encrypted_and_mixed_clients_reject_none_relay_downgrade() {
		tokio::time::timeout(Duration::from_secs(10), async {
			let mixed = russh::client::Config {
				anonymous: true,
				preferred: russh::Preferred {
					kex: vec![russh::kex::CURVE25519, russh::kex::NONE].into(),
					cipher: vec![russh::cipher::NONE].into(),
					..Default::default()
				},
				..Default::default()
			};
			for (config, expected_kind) in
				[(russh::client::Config::default(), "Kex"), (mixed, "Key")]
			{
				let (mut relay, client_stream) = tcp_pair().await;
				let peer = tokio::spawn(async move {
					relay
						.write_all(b"SSH-2.0-isolated-malicious-relay\r\n")
						.await
						.unwrap();
					let mut bytes = 0;
					loop {
						let byte = relay.read_u8().await.unwrap();
						bytes += 1;
						assert!(bytes <= 255);
						if byte == b'\n' {
							break;
						}
					}
					assert_eq!(read_packet(&mut relay).await[0], 20);
					send_packet(&mut relay, &none_kexinit()).await;
				});
				let error =
					russh::client::connect_stream(Arc::new(config), client_stream, EncryptedClient)
						.await
						.err()
						.expect("none relay downgrade must be rejected");
				match error {
					russh::Error::NoCommonAlgo { kind, .. } => {
						assert_eq!(format!("{kind:?}"), expected_kind)
					}
					other => panic!("unexpected rejection: {other:?}"),
				}
				peer.await.unwrap();
			}
		})
		.await
		.expect("malicious relay fixture must complete within ten seconds");
	}

	#[tokio::test]
	async fn forwarded_port_server_transfers_data_and_releases_closed_channel() {
		tokio::time::timeout(Duration::from_secs(10), async {
			let key =
				PrivateKey::random(&mut rand_new::rng(), russh::keys::Algorithm::Ed25519).unwrap();
			let server = RelayTunnelHost::make_ssh_server(key);
			let mut handler = ServerHandle::new();
			let mut connections = handler.take_rx().unwrap();
			let _authenticated = handler.take_authed().unwrap();
			let (server_stream, client_stream) = tcp_pair().await;
			let running = tokio::spawn(async move {
				russh::server::run_stream(server.config, server_stream, handler)
					.await
					.unwrap()
					.await
			});
			let mut client = russh::client::connect_stream(
				Arc::new(russh::client::Config::default()),
				client_stream,
				EncryptedClient,
			)
			.await
			.unwrap();
			assert!(client.authenticate_none("tunnel").await.unwrap().success());
			let mut channel = client
				.channel_open_direct_tcpip("127.0.0.1", 8080, "127.0.0.1", 0)
				.await
				.unwrap();
			let mut connection = connections.recv().await.unwrap();
			assert_eq!(connection.port, 8080);
			channel.data(&b"from-client"[..]).await.unwrap();
			assert_eq!(connection.recv().await.unwrap(), b"from-client");
			connection.send(b"from-server").await.unwrap();
			loop {
				match channel.wait().await.unwrap() {
					russh::ChannelMsg::Data { data } => {
						assert_eq!(data.as_ref(), b"from-server");
						break;
					}
					_ => {}
				}
			}
			channel.close().await.unwrap();
			assert!(
				connection.recv().await.is_none(),
				"closed channel must release its sender"
			);
			client
				.disconnect(russh::Disconnect::ByApplication, "fixture complete", "en")
				.await
				.unwrap();
			let _ = running.await.unwrap();
		})
		.await
		.expect("forwarded-port lifecycle must complete within ten seconds");
	}

	#[test]
	fn relay_websocket_keeps_tls_scheme_and_tunnel_authentication_header() {
		let request = build_websocket_request(
			"wss://relay.example.invalid/isolated-fixture",
			&[
				("Authorization", "tunnel OWNED-ISOLATED-FIXTURE"),
				("Sec-WebSocket-Protocol", "tunnel-relay-host"),
			],
		)
		.unwrap();
		assert_eq!(request.uri().scheme_str(), Some("wss"));
		assert_eq!(
			request.headers()["Authorization"],
			"tunnel OWNED-ISOLATED-FIXTURE"
		);
		assert_eq!(
			request.headers()["Sec-WebSocket-Protocol"],
			"tunnel-relay-host"
		);
	}
}
