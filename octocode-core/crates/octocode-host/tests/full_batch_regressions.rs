use octocode_host::{host::Host, protocol::Request};
use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Write}, process::{Child, Command, Stdio}, sync::mpsc, time::Duration};

fn call(host: &Host, method: &str, params: Value) -> octocode_host::protocol::Response {
    host.dispatch(Request { id: json!(1), method: method.into(), params })
}

#[test]
fn checkpoint_rejects_conflicting_session_but_preserves_id_only_updates() {
    let host = Host::open(":memory:").unwrap();
    for id in ["owner", "other"] {
        assert!(call(&host, "session.create", json!({"id":id,"title":id})).error.is_none());
    }
    let original = call(&host, "supervisor.checkpoint", json!({
        "id":"checkpoint", "session_id":"owner", "objective":"keep",
        "phase":"review", "attempt":1, "max_attempts":3, "verdict":"reject"
    })).result.unwrap();
    let conflict = call(&host, "supervisor.checkpoint", json!({
        "id":"checkpoint", "session_id":"other", "phase":"wrong",
        "attempt":2,"max_attempts":3,"verdict":"accept"
    }));
    assert!(conflict.error.is_some(), "conflicting session modified workflow");
    assert_eq!(call(&host,"supervisor.resume",json!({"id":"checkpoint"})).result.unwrap(), original);
    assert!(call(&host, "supervisor.checkpoint", json!({
        "id":"checkpoint", "phase":"done", "attempt":2,"max_attempts":3,"verdict":"accept"
    })).error.is_none());
}

struct TestProcess(Child);
impl Drop for TestProcess {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

#[test]
fn lifecycle_database_failure_reports_error_and_keeps_native_host_alive() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("test.db");
    let mut process = TestProcess(Command::new(env!("CARGO_BIN_EXE_octocode-host"))
        .arg("--db").arg(&db).current_dir(temp.path())
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap());
    let stdout = process.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let _ = tx.send(serde_json::from_str::<Value>(&line).unwrap());
        }
    });
    let mut send = |id, method, params| {
        writeln!(process.0.stdin.as_mut().unwrap(), "{}", json!({"id":id,"method":method,"params":params})).unwrap();
        process.0.stdin.as_mut().unwrap().flush().unwrap();
    };
    send(1, "harness.prepare", json!({"title":"isolated","workspace":temp.path(),"prompt":"inspect",
        "provider":{"apiProvider":"openai","openAiBaseUrl":"http://127.0.0.1:9/v1","openAiApiKey":"fixture","openAiModelId":"fixture"}}));
    let prepared = rx.recv_timeout(Duration::from_secs(10)).unwrap()["result"].clone();
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_lifecycle BEFORE UPDATE ON workflow_runs BEGIN SELECT RAISE(ABORT,'injected lifecycle failure'); END;").unwrap();
    let mut model = prepared["route"]["model"].clone();
    model["extra_body"] = json!({"chat_template_kwargs":"invalid fixture"});
    send(2,"agent.run",json!({"session_id":prepared["session_id"],"task_id":prepared["task_id"],
        "executable":env!("CARGO_BIN_EXE_octocode-host"),"harness_home":temp.path().join("home"),"cwd":prepared["working_directory"],
        "model":prepared["route"]["model"],"prompt":"inspect","permission_profile":"review","read_only":true,
        "supervision":{"advisor":{"model":model,"min_tool_calls":0}}}));
    let mut terminal = false;
    let mut persistence_error = false;
    for _ in 0..4 {
        let row = rx.recv_timeout(Duration::from_secs(10)).expect("native Host died or lost terminal event");
        persistence_error |= row["kind"] == "agent.persistence_error";
        terminal |= row["kind"] == "agent.error";
        if terminal { break }
    }
    assert!(persistence_error && terminal);
    send(3,"health",json!({}));
    let response = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(response["id"],3);
    assert!(response.get("error").is_none(), "{response}");
    drop(conn);
    drop(process);
}

#[test]
fn malformed_probe_authorities_are_not_assigned_default_ports() {
    for url in ["http://host:abc/v1", "http://host:70000/v1", "http://:8000/v1",
        "http:///v1", "http://[::1]:abc/v1", "http://[::1]junk/v1"] {
        assert_eq!(octocode_host::endpoint::probe_target(url), None, "{url}");
    }
    assert_eq!(octocode_host::endpoint::probe_target("http://[::1]/v1"), Some(("::1".into(),80)));
}

#[test]
fn failed_handoff_cleanup_preserves_both_failure_causes() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("handoff.db");
    let host = Host::open(&db).unwrap();
    let provider = json!({"apiProvider":"openai","openAiBaseUrl":"http://127.0.0.1:9/v1","openAiApiKey":"fixture","openAiModelId":"fixture"});
    let prepared = call(&host,"harness.prepare",json!({"title":"source","workspace":temp.path(),"prompt":"inspect","provider":provider})).result.unwrap();
    assert!(call(&host,"harness.transition",json!({"session_id":prepared["session_id"],"task_id":prepared["task_id"],"state":"completed"})).error.is_none());
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_target BEFORE INSERT ON sessions WHEN NEW.id != 'source' BEGIN SELECT RAISE(ABORT,'original session failure'); END;
        CREATE TRIGGER reject_cleanup BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'cleanup failure'); END;").unwrap();
    let response = call(&host,"harness.handoff",json!({"source_session_id":prepared["session_id"],"provider":provider}));
    let error = response.error.unwrap().message;
    assert!(error.contains("original session failure") && error.contains("cleanup failure"), "{error}");
    drop(conn);
    drop(host);
}

#[tokio::test]
async fn advisor_rejects_header_injection_before_http_exchange() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1",listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut socket,_) = listener.accept().await.unwrap();
        let mut raw = Vec::new();
        let mut buffer = [0;4096];
        loop {
            let count = socket.read(&mut buffer).await.unwrap();
            if count == 0 { break; }
            raw.extend_from_slice(&buffer[..count]);
            let text = String::from_utf8_lossy(&raw);
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length = head.lines().find_map(|line| line.strip_prefix("Content-Length: ")).unwrap().parse::<usize>().unwrap();
                if body.len() >= length { break; }
            }
        }
        let injected = String::from_utf8_lossy(&raw).contains("\r\nX-Injected: fixture\r\n");
        let body = r#"{"choices":[{"message":{"content":"OK"}}]}"#;
        let response = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
        socket.write_all(response.as_bytes()).await.unwrap();
        injected
    });
    let advisor = octocode_host::supervisor::Advisor {
        model: serde_json::from_value(json!({"model":"fixture","base_url":endpoint,
            "api_key":"fixture\r\nX-Injected: fixture","api_backend":"chat_completions",
            "context_window":8192,"max_completion_tokens":512})).unwrap(),
        min_tool_calls:0,
    };
    let result = octocode_host::supervisor::review(&advisor,"inspect",&[],"done").await;
    if result.is_ok() {
        assert!(server.await.unwrap(),"controlled wire did not reproduce injection");
        panic!("native advisor sent injected HTTP header");
    }
    server.abort();
    let _ = server.await;
    assert!(result.unwrap_err().to_string().contains("api_key"));
    let mut malformed_url = advisor;
    malformed_url.model.api_key = None;
    malformed_url.model.base_url.push_str("\r\nX-Injected: fixture");
    assert!(octocode_host::supervisor::validate_advisor(&malformed_url).is_err());
}
