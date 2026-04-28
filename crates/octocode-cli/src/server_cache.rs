//! Phase-5 helpers extracted from `server.rs`:
//!
//! * `/api/health` payload TTL cache (P0-S1).
//! * `RuntimeConfig` mtime-keyed cache (P1-S3).
//! * SSE keep-alive heartbeat sentinel (P0-L2).
//!
//! Keeping these in a small, dedicated module makes the eventual full
//! split of `server.rs` (P2 axis) cheaper: each subsequent module only
//! needs to import what it actually uses.

use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use octocode_core::{OctoError, RuntimeConfig};
use octocode_runtime::ConfigLoader;

/// TTL for the in-process `/api/health` cache. Provider probes can take
/// 200–700 ms each; with 17 providers that previously summed to ~3–4 s
/// per request. The router now probes in parallel and we additionally
/// memoise the JSON payload here for `HEALTH_CACHE_TTL` so a busy WebUI
/// doesn't re-probe on every poll.
pub const HEALTH_CACHE_TTL: Duration = Duration::from_secs(15);

static HEALTH_CACHE: OnceLock<Mutex<Option<(Instant, String)>>> = OnceLock::new();

fn health_cache() -> &'static Mutex<Option<(Instant, String)>> {
    HEALTH_CACHE.get_or_init(|| Mutex::new(None))
}

pub fn cached_health_payload() -> Option<String> {
    let guard = health_cache().lock().ok()?;
    let (stored_at, payload) = guard.as_ref()?;
    if stored_at.elapsed() <= HEALTH_CACHE_TTL {
        Some(payload.clone())
    } else {
        None
    }
}

pub fn store_cached_health_payload(payload: String) {
    if let Ok(mut guard) = health_cache().lock() {
        *guard = Some((Instant::now(), payload));
    }
}

/// Wall-clock millis since UNIX epoch, used as a cache marker in the JSON
/// payload so clients can see how stale the cached probe is.
pub fn turn_now_ms_for_cache() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Process-wide cache of the loaded `RuntimeConfig`. The WebUI re-loads
/// `octocode.conf` on every request which costs one or two
/// `read_to_string` plus parse passes (~1–3 ms each on Windows). We
/// memoise the parsed result keyed by file path and invalidate via the
/// file's mtime so an external edit takes effect immediately.
static CONFIG_CACHE: OnceLock<Mutex<Option<(PathBuf, std::time::SystemTime, RuntimeConfig)>>> =
    OnceLock::new();

fn config_cache(
) -> &'static Mutex<Option<(PathBuf, std::time::SystemTime, RuntimeConfig)>> {
    CONFIG_CACHE.get_or_init(|| Mutex::new(None))
}

pub fn cached_config_load(loader: &ConfigLoader) -> Result<RuntimeConfig, OctoError> {
    let path = loader.config_file_path();
    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    if let (Some(mtime), Ok(guard)) = (mtime, config_cache().lock()) {
        if let Some((cached_path, cached_mtime, cached_cfg)) = guard.as_ref() {
            if cached_path == &path && *cached_mtime == mtime {
                return Ok(cached_cfg.clone());
            }
        }
    }
    let cfg = loader.load()?;
    if let (Some(mtime), Ok(mut guard)) = (
        std::fs::metadata(&path).and_then(|m| m.modified()).ok(),
        config_cache().lock(),
    ) {
        *guard = Some((path, mtime, cfg.clone()));
    }
    Ok(cfg)
}

/// SSE keep-alive sentinel. Spawns a background thread that writes
/// `: keepalive\n\n` to a cloned [`TcpStream`] every `interval` until
/// the returned [`HeartbeatHandle::stop`] is invoked. SSE comments
/// (lines beginning with `:`) are ignored by EventSource clients but
/// reset proxy idle timers, preventing reverse proxies and load
/// balancers from killing long-running tool-call chains.
pub struct HeartbeatHandle {
    flag: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl HeartbeatHandle {
    pub fn stop(mut self) {
        self.flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub fn spawn_sse_heartbeat(stream: &TcpStream, interval: Duration) -> HeartbeatHandle {
    let flag = Arc::new(AtomicBool::new(false));
    let cloned = stream.try_clone().ok();
    let flag_for_thread = Arc::clone(&flag);
    let handle = cloned.map(|mut sock| {
        thread::spawn(move || {
            // Tick at 250 ms so stop() returns quickly; only emit a
            // keep-alive comment when `interval` has elapsed.
            let tick = Duration::from_millis(250);
            let mut elapsed = Duration::ZERO;
            while !flag_for_thread.load(Ordering::SeqCst) {
                thread::sleep(tick);
                elapsed += tick;
                if elapsed >= interval {
                    elapsed = Duration::ZERO;
                    if sock.write_all(b": keepalive\n\n").is_err() || sock.flush().is_err() {
                        break;
                    }
                }
            }
        })
    });
    HeartbeatHandle { flag, handle }
}
