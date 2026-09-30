//! `grok update` is a recovery command: a config failure must not block it.
//!
//! A local server serves the binary's own version as the channel pointer, so a healthy run exits 0 ("already up to date").
//! A run with a corrupt config must exit 0 too; reintroducing a config `?` fails exactly that run.
//! The pointer must equal the current version: the installer converges in both directions, so an older pointer triggers a downgrade attempt.

use std::io::{Read, Write};
use std::process::Command;
use std::sync::{Arc, Mutex};

/// Resolve the pager binary like the PTY harness: `PAGER_BINARY` under Bazel (runfiles-relative), else cargo's compile-time constant.
fn pager_binary() -> std::path::PathBuf {
    if let Ok(p) = std::env::var("PAGER_BINARY") {
        return std::path::absolute(&p)
            .unwrap_or_else(|e| panic!("failed to absolutize PAGER_BINARY {p}: {e}"));
    }
    option_env!("CARGO_BIN_EXE_xai-grok-pager")
        .map(std::path::PathBuf::from)
        .expect("PAGER_BINARY is unset and this build is not `cargo test`")
}

/// Spawn a local server that answers every request with the channel pointer body.
fn spawn_pointer_server(body: Arc<Mutex<String>>) -> (std::net::TcpListener, String) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let serving = listener.try_clone().unwrap();
    std::thread::spawn(move || {
        for stream in serving.incoming() {
            let Ok(mut stream) = stream else { return };
            let mut buf = [0u8; 1024];
            let _ = stream.read(&mut buf);
            let version = body.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    version.len(),
                    version
                )
                .as_bytes(),
            );
        }
    });
    (listener, base)
}

/// Variables a Windows process needs to start at all.
///
/// `env_clear` is the point of this test -- the run has to be isolated from the
/// developer's own config -- but on Windows it also removes the variables the
/// C runtime and winsock read during startup. Without `SystemRoot` the spawned
/// process cannot initialise networking, so it dies before printing anything
/// and the JSON parse below fails on empty stdout. Forward just these, so the
/// isolation that matters (`HOME`, `GROK_HOME`) is untouched.
#[cfg(windows)]
const OS_ESSENTIAL_VARS: &[&str] = &[
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ProgramData",
    "ALLUSERSPROFILE",
    "COMSPEC",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "TEMP",
    "TMP",
];
#[cfg(not(windows))]
const OS_ESSENTIAL_VARS: &[&str] = &[];

/// Forwarded on every platform: a debug build's frames are large enough that the
/// child overflows the default stack, which is why the suite is run with
/// `RUST_MIN_STACK` set. `env_clear` drops it, so the child crashed with a stack
/// overflow and no output before this was forwarded.
const INHERITED_VARS: &[&str] = &["RUST_MIN_STACK", "RUST_BACKTRACE"];

/// Run `grok update` in an isolated home against the local pointer base.
fn run_update(base: &str, config_toml: &str, extra_args: &[&str]) -> std::process::Output {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join("config.toml"), config_toml).unwrap();
    let mut cmd = Command::new(pager_binary());
    cmd.arg("update")
        .args(extra_args)
        .env_clear()
        .env("HOME", home.path())
        .env("GROK_HOME", home.path())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("GROK_CLI_BASE_URL", base);
    for key in OS_ESSENTIAL_VARS.iter().chain(INHERITED_VARS) {
        if let Ok(value) = std::env::var(key) {
            cmd.env(key, value);
        }
    }
    cmd.output().expect("spawn grok update")
}

/// The valid run proves the environment resolves to success, so a nonzero corrupt run can only mean a config failure aborted the update.
#[test]
fn corrupt_config_never_changes_update_outcome() {
    let body = Arc::new(Mutex::new("0.0.1".to_owned()));
    let (_listener, base) = spawn_pointer_server(body.clone());

    // Probe the binary's own version so the pointer matches it exactly.
    let check = run_update(&base, "[cli]\n", &["--check", "--json"]);
    let status: serde_json::Value = serde_json::from_slice(&check.stdout).unwrap_or_else(|e| {
        // Empty stdout means the process never got far enough to print, so the
        // exit status and stderr are the only things that explain why.
        panic!(
            "update --check --json must emit JSON: {e}\nstatus: {}\nstdout:\n{}\nstderr:\n{}",
            check.status,
            String::from_utf8_lossy(&check.stdout),
            String::from_utf8_lossy(&check.stderr)
        )
    });
    let current = status["currentVersion"]
        .as_str()
        .expect("currentVersion in update --check --json")
        .to_owned();
    *body.lock().unwrap_or_else(|e| e.into_inner()) = current;

    let valid = run_update(&base, "[cli]\n", &[]);
    assert!(
        valid.status.success(),
        "healthy grok update against the local base must exit 0\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&valid.stdout),
        String::from_utf8_lossy(&valid.stderr)
    );

    let corrupt = run_update(&base, "this is not toml {{{[[[", &[]);
    assert!(
        corrupt.status.success(),
        "a corrupt config.toml must not block grok update\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&corrupt.stdout),
        String::from_utf8_lossy(&corrupt.stderr)
    );
}
