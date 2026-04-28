//! TLS support for the Octocode HTTP server.
//!
//! Provides optional TLS termination using rustls.
//! Supports loading certificates from PEM files or auto-generating
//! self-signed certificates for development.

use std::fs;
use std::io::{self, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;

use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::ServerConfig;

/// TLS configuration for the server.
pub struct TlsConfig {
    pub server_config: Arc<ServerConfig>,
}

impl TlsConfig {
    /// Load TLS config from PEM certificate and key files.
    pub fn from_pem_files(cert_path: &Path, key_path: &Path) -> Result<Self, String> {
        let cert_data = fs::read(cert_path)
            .map_err(|e| format!("failed to read cert file {}: {e}", cert_path.display()))?;
        let key_data = fs::read(key_path)
            .map_err(|e| format!("failed to read key file {}: {e}", key_path.display()))?;

        let certs = load_certs(&cert_data)?;
        let key = load_private_key(&key_data)?;

        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(certs, key)
            .map_err(|e| format!("TLS config error: {e}"))?;

        Ok(Self {
            server_config: Arc::new(config),
        })
    }

    /// Load from raw PEM bytes (useful for embedded certs or config-provided certs).
    pub fn from_pem_bytes(cert_pem: &[u8], key_pem: &[u8]) -> Result<Self, String> {
        let certs = load_certs(cert_pem)?;
        let key = load_private_key(key_pem)?;

        let config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(certs, key)
            .map_err(|e| format!("TLS config error: {e}"))?;

        Ok(Self {
            server_config: Arc::new(config),
        })
    }

    /// Try to load TLS config from the standard .octocode/tls/ directory.
    /// Returns None if TLS files are not present.
    pub fn from_workspace(workspace_root: &str) -> Option<Self> {
        let tls_dir = Path::new(workspace_root).join(".octocode").join("tls");
        let cert_path = tls_dir.join("cert.pem");
        let key_path = tls_dir.join("key.pem");

        if cert_path.is_file() && key_path.is_file() {
            match Self::from_pem_files(&cert_path, &key_path) {
                Ok(config) => Some(config),
                Err(err) => {
                    eprintln!("TLS config loading failed: {err}");
                    None
                }
            }
        } else {
            None
        }
    }

    /// Accept a TLS connection on an existing TCP stream.
    pub fn accept(&self, tcp_stream: TcpStream) -> Result<TlsStream, String> {
        let conn = rustls::ServerConnection::new(Arc::clone(&self.server_config))
            .map_err(|e| format!("TLS accept error: {e}"))?;
        Ok(TlsStream {
            tcp: tcp_stream,
            conn,
        })
    }
}

/// A TLS-wrapped TCP stream that implements Read/Write.
pub struct TlsStream {
    tcp: TcpStream,
    conn: rustls::ServerConnection,
}

impl TlsStream {
    /// Complete the TLS handshake. Must be called before read/write.
    pub fn handshake(&mut self) -> Result<(), String> {
        loop {
            if self.conn.is_handshaking() {
                // Read TLS data from the network
                match self.conn.read_tls(&mut self.tcp) {
                    Ok(0) => return Err("connection closed during handshake".into()),
                    Ok(_) => {}
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                        // Write any pending TLS data
                        let _ = self.conn.write_tls(&mut self.tcp);
                        continue;
                    }
                    Err(e) => return Err(format!("TLS read error: {e}")),
                }
                // Process the TLS messages
                self.conn
                    .process_new_packets()
                    .map_err(|e| format!("TLS process error: {e}"))?;
                // Write any TLS response data
                let _ = self.conn.write_tls(&mut self.tcp);
            } else {
                return Ok(());
            }
        }
    }

    /// Get the peer's IP address.
    pub fn peer_addr(&self) -> io::Result<std::net::SocketAddr> {
        self.tcp.peer_addr()
    }
}

impl Read for TlsStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            // Try to read decrypted data first
            match self.conn.reader().read(buf) {
                Ok(n) if n > 0 => return Ok(n),
                Ok(_) => {}
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(e),
            }

            // Need more TLS data from the network
            match self.conn.read_tls(&mut self.tcp) {
                Ok(0) => return Ok(0), // EOF
                Ok(_) => {}
                Err(e) => return Err(e),
            }

            self.conn
                .process_new_packets()
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
        }
    }
}

impl Write for TlsStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.conn.writer().write(buf)?;
        self.conn.write_tls(&mut self.tcp)?;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.conn.writer().flush()?;
        self.conn.write_tls(&mut self.tcp)?;
        self.tcp.flush()
    }
}

// ─── Helper Functions ───────────────────────────────────────────────────────────

fn load_certs(pem_data: &[u8]) -> Result<Vec<CertificateDer<'static>>, String> {
    let mut reader = BufReader::new(pem_data);
    let certs: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to parse certificates: {e}"))?;
    if certs.is_empty() {
        return Err("no certificates found in PEM data".into());
    }
    Ok(certs)
}

fn load_private_key(pem_data: &[u8]) -> Result<PrivateKeyDer<'static>, String> {
    let mut reader = BufReader::new(pem_data);
    rustls_pemfile::private_key(&mut reader)
        .map_err(|e| format!("failed to parse private key: {e}"))?
        .ok_or_else(|| "no private key found in PEM data".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_certs_rejects_empty() {
        let result = load_certs(b"");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no certificates"));
    }

    #[test]
    fn load_certs_rejects_garbage() {
        let result = load_certs(b"not a pem file");
        assert!(result.is_err());
    }

    #[test]
    fn load_key_rejects_empty() {
        let result = load_private_key(b"");
        assert!(result.is_err());
    }

    #[test]
    fn tls_config_from_workspace_returns_none_when_missing() {
        let result = TlsConfig::from_workspace("/nonexistent/path/octocode-test");
        assert!(result.is_none());
    }
}
