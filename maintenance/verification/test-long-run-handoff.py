"""Run the actual Windows daemon, Host and Harness against a loopback model."""

import argparse
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daemon", type=Path, required=True)
    parser.add_argument("--host", type=Path, required=True)
    parser.add_argument("--harness", type=Path, required=True)
    args = parser.parse_args()
    first_artifact_ready = threading.Event()
    requests = {"overflow": 0, "fresh": 0}

    class Model(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            request = self.rfile.read(int(self.headers["Content-Length"]))
            if b"<task_handoff>" in request:
                requests["fresh"] += 1
                response = b""
                for delta, reason in [({"role": "assistant", "content": "HANDOFF_ACCEPTED"}, None), ({}, "stop")]:
                    chunk = {"id": "local", "object": "chat.completion.chunk", "created": 1, "model": "fixture",
                             "choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}
                    response += b"data: " + json.dumps(chunk).encode() + b"\n\n"
                response += b"data: [DONE]\n\n"
                status, mime = 200, "text/event-stream"
            else:
                assert first_artifact_ready.wait(12), "source run did not prepare its working directory"
                requests["overflow"] += 1
                response = json.dumps({"error": {"code": "context_length_exceeded", "type": "invalid_request_error",
                                                "message": "Maximum context length exceeded in the original session"}}).encode()
                status, mime = 400, "application/json"
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    with tempfile.TemporaryDirectory(prefix="OctoCode long run ") as directory, ThreadingHTTPServer(("127.0.0.1", 0), Model) as model:
        root = Path(directory)
        workspace = root / "Selected project"
        workspace.mkdir()
        state = root / "state"
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        model_thread = threading.Thread(target=model.serve_forever, daemon=True)
        model_thread.start()
        env = {**os.environ, "OCTOCODE_ROOT": str(root), "OCTOCODE_DAEMON_STATE": str(state),
               "OCTOCODE_API_TOKEN": "isolated-long-run-fixture", "OCTOCODE_DESKTOP_PID": "0",
               "OCTOCODE_DAEMON_PARENT_PIPE": "0", "OCTOCODE_HOST": str(args.host.resolve(strict=True)),
               "OCTOCODE_HARNESS": str(args.harness.resolve(strict=True))}

        def rpc(path, body=None):
            data = json.dumps(body).encode() if body is not None else None
            request = Request(f"http://127.0.0.1:{port}{path}", data=data,
                              headers={"Authorization": "Bearer isolated-long-run-fixture", "Content-Type": "application/json"})
            with urlopen(request, timeout=10) as response:
                return json.load(response)

        with (root / "daemon.log").open("w+b") as log:
            process = subprocess.Popen([sys.executable, str(args.daemon.resolve(strict=True)), "--port", str(port)],
                                       env=env, stdout=log, stderr=log,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            try:
                for _ in range(100):
                    try:
                        rpc("/health")
                        break
                    except OSError:
                        assert process.poll() is None, "daemon exited before health"
                        time.sleep(0.1)
                else:
                    raise AssertionError("isolated daemon did not start")
                started = rpc("/v1/runs", {"prompt": "Review only. Continue the existing task.", "cwd": str(workspace),
                                           "permission_mode": "review", "review": False, "max_turns": 6,
                                           "stream_rules": [], "model": {"model": "fixture", "api_key": "fixture",
                                           "context_window": 131072, "base_url": f"http://127.0.0.1:{model.server_port}/v1"}})
                old_session = started["session_id"]
                artifact = Path(started["working_directory"]) / "finished-work.txt"
                artifact.write_text("retained original artifact", encoding="utf-8")
                first_artifact_ready.set()
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    result = rpc(f"/v1/runs/{started['run_id']}")
                    if result["status"] != "running":
                        break
                    time.sleep(0.2)
                assert result["status"] == "completed", result
                assert result["run_id"] == started["run_id"]
                assert result["session_chain"] == [old_session, result["session_id"]]
                assert result["session_id"] != old_session and result["text"] == "HANDOFF_ACCEPTED"
                stream = Request(f"http://127.0.0.1:{port}/v1/runs/{started['run_id']}/events",
                                 headers={"Authorization": "Bearer isolated-long-run-fixture"})
                with urlopen(stream, timeout=10) as response:
                    records = response.read().decode().split("\n\n")
                events = [json.loads(record[6:]) for record in records if record.startswith("data: ")]
                rollovers = [event for event in events if event.get("type") == "runtime.rollover_ready"]
                assert len(rollovers) == 1 and rollovers[0]["session_id"] == result["session_id"]
                completions = [json.loads(record.split("\ndata: ", 1)[1])
                               for record in records if record.startswith("event: done\n")]
                assert len(completions) == 1 and completions[0] == result
                assert not Path(result["working_directory"]).samefile(artifact.parent)
                assert artifact.read_text(encoding="utf-8") == "retained original artifact"
                with closing(sqlite3.connect((state / "daemon.db").as_uri() + "?mode=ro", uri=True)) as db:
                    assert db.execute("PRAGMA quick_check").fetchone() == ("ok",)
                    assert db.execute("SELECT status FROM sessions WHERE id=?", [old_session]).fetchone() == ("failed",)
                    rows = db.execute("SELECT payload FROM events WHERE session_id=? AND kind='harness.handed_off'", [old_session]).fetchall()
                    assert len(rows) == 1 and json.loads(rows[0][0])["target_session_id"] == result["session_id"]
                assert requests["overflow"] > 0 and requests["fresh"] > 0, requests
                print(f"PASS: {requests['overflow']} original context-limit response(s), {requests['fresh']} provider requests in the fresh session, stable run ID, preserved source artifact")
            except BaseException:
                log.seek(0)
                print(log.read().decode(errors="replace")[-6000:], file=sys.stderr)
                raise
            finally:
                first_artifact_ready.set()
                try:
                    if process.poll() is None:
                        rpc("/v1/daemon/shutdown", {})
                        process.wait(timeout=20)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait(timeout=10)
                    model.shutdown()


if __name__ == "__main__":
    main()
