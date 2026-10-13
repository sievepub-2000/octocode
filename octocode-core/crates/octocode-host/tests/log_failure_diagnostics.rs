use octocode_host::{host::Host, protocol::Request};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

fn health(host: &Host) -> Value {
    let response = host.dispatch(Request { id: json!(1), method: "health".into(), params: json!({}) });
    assert!(response.error.is_none());
    response.result.unwrap()
}

#[test]
fn operational_log_failure_is_visible_in_read_only_health() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owned.sqlite");
    let host = Host::open(&path).unwrap();
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER owned_log_failure BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT,'owned synthetic private SQL marker'); END;").unwrap();
    host.record_log("info", "owned", "owned synthetic payload marker", &json!({"key":"owned synthetic key marker"}), None);
    assert_eq!(health(&host)["log_write_failures"], 1);
}

#[test]
fn operational_failures_accumulate_recovery_preserves_count_and_reopen_resets_it() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owned.sqlite");
    let host = Host::open(&path).unwrap();
    let conn = Connection::open(&path).unwrap();
    assert_eq!(health(&host)["log_write_failures"], 0);
    let count = || conn.query_row("SELECT count(*) FROM logs", [], |r| r.get::<_, i64>(0)).unwrap();
    let before = count();
    conn.execute_batch("CREATE TRIGGER owned_log_failure BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT,'owned synthetic private SQL marker'); END;").unwrap();
    for _ in 0..16 {
        host.record_log("info", "owned", "owned synthetic payload marker", &json!({"key":"owned synthetic key marker"}), None);
    }
    assert_eq!(health(&host)["log_write_failures"], 16);
    assert_eq!(count(), before);
    for _ in 0..3 { assert_eq!(health(&host)["log_write_failures"], 16); }
    assert_eq!(count(), before, "dispatching health does not persist diagnostics");
    conn.execute_batch("DROP TRIGGER owned_log_failure;").unwrap();
    host.record_log("info", "owned", "owned recovered marker", &json!({}), None);
    assert_eq!(count(), before + 1);
    assert_eq!(health(&host)["log_write_failures"], 16);
    drop(conn); drop(host);
    let reopened = Host::open(&path).unwrap();
    assert_eq!(health(&reopened)["log_write_failures"], 0);
}

struct OwnedProcess {
    child: Child,
    input: Option<ChildStdin>,
    output: Receiver<Result<Value, String>>,
    reader: Option<JoinHandle<()>>,
    stderr: Option<JoinHandle<String>>,
    next_id: u64,
}

impl OwnedProcess {
    fn open(path: &std::path::Path) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_octocode-host"));
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().to_ascii_uppercase().starts_with("OCTOCODE_") { command.env_remove(key); }
        }
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.arg("--db").arg(path).current_dir(path.parent().unwrap())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let mut error_stream = child.stderr.take().unwrap();
        let (tx, output) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let value = line.map_err(|_| "stdout I/O failure".to_owned())
                    .and_then(|line| serde_json::from_str(&line).map_err(|_| "non-JSON stdout".to_owned()));
                if tx.send(value).is_err() { break; }
            }
        });
        let stderr = std::thread::spawn(move || { let mut text = String::new(); error_stream.read_to_string(&mut text).unwrap(); text });
        Self { child, input, output, reader: Some(reader), stderr: Some(stderr), next_id: 0 }
    }
    fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let input = self.input.as_mut().unwrap();
        writeln!(input, "{}", json!({"id":self.next_id,"method":method,"params":params})).unwrap();
        input.flush().unwrap();
        let response = self.output.recv_timeout(Duration::from_secs(10)).expect("bounded response").expect("JSON-only stdout");
        assert_eq!(response["id"], self.next_id);
        response
    }
    fn finish(&mut self) -> String {
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() { assert!(status.success()); break; }
            assert!(Instant::now() < deadline, "bounded EOF shutdown");
            std::thread::sleep(Duration::from_millis(10));
        }
        self.reader.take().unwrap().join().unwrap();
        assert!(self.output.try_recv().is_err(), "no unsolicited stdout diagnostics");
        self.stderr.take().unwrap().join().unwrap()
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.input.take(); let _ = self.child.kill(); let _ = self.child.wait();
        if let Some(reader) = self.reader.take() { let _ = reader.join(); }
        if let Some(stderr) = self.stderr.take() { let _ = stderr.join(); }
    }
}

#[test]
fn rpc_failures_are_counted_rate_limited_private_and_keep_json_results_after_recovery() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("owned.sqlite");
    let mut host = OwnedProcess::open(&path);
    assert_eq!(host.call("ping", json!({}))["result"], json!({"pong":true}));
    assert_eq!(host.call("health", json!({}))["result"]["log_write_failures"], 0);
    let conn = Connection::open(&path).unwrap();
    let before: i64 = conn.query_row("SELECT count(*) FROM logs", [], |r| r.get(0)).unwrap();
    conn.execute_batch("CREATE TRIGGER owned_log_failure BEFORE INSERT ON logs BEGIN SELECT RAISE(ABORT,'owned synthetic private SQL marker'); END;").unwrap();
    for _ in 0..16 {
        assert_eq!(host.call("ping", json!({"key":"owned synthetic key marker","params":"owned synthetic payload marker"}))["result"], json!({"pong":true}));
    }
    assert_eq!(host.call("owned_synthetic_error_marker", json!({}))["error"]["code"], -32601);
    // The health response observes 17 prior failures; main records this RPC afterward (18).
    assert_eq!(host.call("health", json!({}))["result"]["log_write_failures"], 17);
    let failed: i64 = conn.query_row("SELECT count(*) FROM logs", [], |r| r.get(0)).unwrap();
    assert_eq!(failed, before);
    conn.execute_batch("DROP TRIGGER owned_log_failure;").unwrap();
    assert_eq!(host.call("ping", json!({}))["result"], json!({"pong":true}));
    assert_eq!(host.call("health", json!({}))["result"]["log_write_failures"], 18);
    let restored: i64 = conn.query_row("SELECT count(*) FROM logs", [], |r| r.get(0)).unwrap();
    assert_eq!(restored, before + 2);
    let stderr = host.finish();
    let expected: Vec<String> = [1,2,4,8,16].iter().map(|count| format!("OctoCode diagnostic log write failed; host failure count={count}")).collect();
    assert_eq!(stderr.lines().collect::<Vec<_>>(), expected.iter().map(String::as_str).collect::<Vec<_>>());
    assert!(!stderr.contains("synthetic"));
    drop(conn); drop(host);
    let mut reopened = OwnedProcess::open(&path);
    assert_eq!(reopened.call("health", json!({}))["result"]["log_write_failures"], 0);
    assert_eq!(reopened.finish(), "");
}
