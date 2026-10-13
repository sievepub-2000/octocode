use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{Value, json};

struct OwnedHost {
    child: Child,
    input: Option<ChildStdin>,
    output: Receiver<Value>,
    reader: Option<JoinHandle<()>>,
    temp: tempfile::TempDir,
}

impl OwnedHost {
    fn open() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_octocode-host"));
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().to_ascii_uppercase().starts_with("OCTOCODE_") {
                command.env_remove(key);
            }
        }
        let mut child = command.arg("--db").arg(temp.path().join("owned.db"))
            .current_dir(temp.path()).stdin(Stdio::piped()).stdout(Stdio::piped())
            .stderr(Stdio::null()).spawn().unwrap();
        let input = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        let (tx, output) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let value = serde_json::from_str(&line).unwrap();
                if tx.send(value).is_err() { break }
            }
        });
        Self { child, input, output, reader: Some(reader), temp }
    }

    fn write(&mut self, bytes: &[u8]) {
        let input = self.input.as_mut().unwrap();
        input.write_all(bytes).unwrap();
        input.flush().unwrap();
    }

    fn receive(&self) -> Value {
        self.output.recv_timeout(Duration::from_secs(10)).expect("host response must arrive")
    }

    fn finish(&mut self) {
        self.input.take();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            assert!(std::time::Instant::now() < deadline, "host must stop at EOF");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for OwnedHost {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() { let _ = reader.join(); }
    }
}

#[test]
fn invalid_utf8_frame_is_rejected_and_following_ping_succeeds() {
    let mut host = OwnedHost::open();
    host.write(b"\xff\n{\"id\":\"owned-ping\",\"method\":\"ping\",\"params\":{}}\n");
    let error = host.receive();
    assert_eq!(error["error"]["code"], -32700);
    assert!(error["id"].is_null());
    assert_eq!(host.receive(), json!({"id":"owned-ping","result":{"pong":true}}));
    host.finish();
}

#[test]
fn malformed_json_crlf_and_unicode_eof_request_remain_supported() {
    let mut host = OwnedHost::open();
    host.write("{}\r\n{\"id\":\"中文\",\"method\":\"ping\",\"params\":{}}".as_bytes());
    host.input.take();
    assert_eq!(host.receive()["error"]["code"], -32700);
    assert_eq!(host.receive(), json!({"id":"中文","result":{"pong":true}}));
    host.finish();
}

#[test]
fn consecutive_bad_frames_do_not_contaminate_a_large_valid_frame() {
    let mut host = OwnedHost::open();
    host.write(b"\xff\r\n\xfe\n");
    for _ in 0..2 { assert_eq!(host.receive()["error"]["code"], -32700); }
    let request = json!({"id":3,"method":"ping","params":{"padding":"x".repeat(512*1024)}});
    host.write(format!("{request}\n").as_bytes());
    assert_eq!(host.receive(), json!({"id":3,"result":{"pong":true}}));
    host.finish();
}

#[test]
fn partial_input_survives_real_agent_events_before_the_frame_finishes() {
    let mut host = OwnedHost::open();
    let provider = json!({"apiProvider":"openai","openAiBaseUrl":"http://127.0.0.1:9/v1",
        "openAiApiKey":"fixture","openAiModelId":"fixture"});
    host.write(format!("{}\n", json!({"id":"prepare","method":"harness.prepare","params":{
        "title":"owned stdin interleaving","prompt":"owned fixture","provider":provider}})).as_bytes());
    let prepared = host.receive();
    assert!(prepared["error"].is_null(), "{prepared}");
    // This test executable rejects harness CLI flags; it cannot call a model.
    // Its real process events exercise the host's select branch while input is partial.
    let run = json!({"id":"run","method":"agent.run","params":{
        "task_id":prepared["result"]["task_id"],"session_id":prepared["result"]["session_id"],
        "executable":std::env::current_exe().unwrap(),"harness_home":host.temp.path().join("harness"),
        "cwd":host.temp.path(),"model":prepared["result"]["route"]["model"],"prompt":"owned fixture"}});
    host.write(format!("{run}\n{{\"id\":\"partial\",\"method\":").as_bytes());
    let mut saw_event = false;
    let mut run_ok = false;
    for _ in 0..8 {
        let value = host.receive();
        if value["id"] == "run" {
            assert!(value["error"].is_null(), "{value}");
            run_ok = true;
        }
        saw_event |= value["kind"].as_str().is_some_and(|kind| kind.starts_with("agent."));
        if run_ok && saw_event { break }
    }
    assert!(run_ok && saw_event);
    host.write(b"\"ping\",\"params\":{}}\n");
    for _ in 0..12 {
        let value = host.receive();
        if value["id"] == "partial" {
            assert_eq!(value["result"], json!({"pong":true}));
            host.finish();
            return;
        }
        assert!(value["error"].is_null(), "partial frame must not be lost: {value}");
    }
    panic!("partial request response missing");
}
