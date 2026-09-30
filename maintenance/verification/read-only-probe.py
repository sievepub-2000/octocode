"""Exercise native permissions with controlled write attempts or fixture reads."""

import json
import os
import pathlib
import queue
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


host_binary = pathlib.Path(sys.argv[1])
harness_binary = pathlib.Path(sys.argv[2])
profile = sys.argv[3] if len(sys.argv) > 3 else "full"
read_only = sys.argv[4].lower() == "true" if len(sys.argv) > 4 else True
outside = "--outside" in sys.argv[5:]
read_probe = "--read-probe" in sys.argv[5:]
absolute = "--absolute" in sys.argv[5:]
requests = []
events = []
issued = False


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        global issued
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        requests.append(body)
        tool_names = {tool["function"]["name"] for tool in body.get("tools", [])}
        classifier = any(
            message.get("role") == "system" and "You review a command" in str(message.get("content", ""))
            for message in body.get("messages", [])
        )
        if classifier:
            message, stop = {
                "role": "assistant",
                "content": json.dumps({"thinking": "controlled test", "shouldBlock": False, "reason": "controlled test"}),
            }, "stop"
        elif not issued and "read_file" in tool_names:
            issued = True
            terminal = next(
                (tool["function"] for tool in body.get("tools", [])
                 if tool["function"]["name"] in ("run_terminal_command", "bash", "shell", "run_shell_command")),
                None,
            )
            properties = terminal.get("parameters", {}).get("properties", {}) if terminal else {}
            target = "..\\outside.txt" if outside else "write-marker.txt"
            arguments = {"cmd" if "cmd" in properties else "command": f"cmd /c echo unsafe>{target}"}
            if "description" in properties:
                arguments["description"] = "Controlled permission probe"
            if read_probe:
                read_function = next(tool["function"] for tool in body["tools"] if tool["function"]["name"] == "read_file")
                read_properties = read_function.get("parameters", {}).get("properties", {})
                path_key = next(key for key in ("target_file", "path", "file_path") if key in read_properties)
                arguments = {path_key: str(read_target) if absolute else ("..\\outside-read.txt" if outside else "inside-read.txt")}
            message = {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": "controlled-read" if read_probe else "forbidden-write",
                    "type": "function",
                    "function": {
                        "name": "read_file" if read_probe else (terminal["name"] if terminal else "run_terminal_command"),
                        "arguments": json.dumps(arguments),
                    },
                }],
            }
            stop = "tool_calls"
        else:
            message, stop = {"role": "assistant", "content": "Inspection complete."}, "stop"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        delta = dict(message)
        if "tool_calls" in delta:
            delta["tool_calls"][0]["index"] = 0
        chunk = {
            "id": "readonly-probe",
            "created": int(time.time()),
            "object": "chat.completion.chunk",
            "model": "probe",
            "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
        }
        try:
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            chunk["choices"] = [{"index": 0, "delta": {}, "finish_reason": stop}]
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode())
            self.wfile.flush()
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass


with tempfile.TemporaryDirectory(prefix="octocode-readonly-") as directory:
    root = pathlib.Path(directory)
    workspace = root / "workspace"
    workspace.mkdir()
    read_target = root / "outside-read.txt" if outside else workspace / "inside-read.txt"
    read_token = uuid.uuid4().hex
    if read_probe:
        read_target.write_text(read_token, encoding="utf-8")
    server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = os.environ | {"NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"}
    process = subprocess.Popen(
        [str(host_binary), "--db", str(root / "test.db")],
        cwd=root,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        creationflags=0x08000000,
    )
    output = queue.Queue()

    def read_output():
        for line in process.stdout:
            item = json.loads(line)
            output.put(item)
            if "kind" in item:
                events.append(item)

    threading.Thread(target=read_output, daemon=True).start()
    counter = 0

    def rpc(method, params):
        global counter
        counter += 1
        request_id = counter
        process.stdin.write(json.dumps({"id": request_id, "method": method, "params": params}) + "\n")
        process.stdin.flush()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            item = output.get(timeout=30)
            if item.get("id") == request_id:
                assert "error" not in item, item
                return item["result"]
        raise TimeoutError(method)

    try:
        endpoint = f"http://127.0.0.1:{server.server_port}/v1"
        prompt = "Read-only inspection of this directory. Do not modify anything." if read_only else "Create the requested marker file."
        prepared = rpc("harness.prepare", {
            "title": "Read-only permission regression",
            "workspace": str(workspace),
            "prompt": prompt,
            "provider": {"apiProvider": "openai", "openAiBaseUrl": endpoint, "openAiApiKey": "stub", "openAiModelId": "probe"},
        })
        model = prepared["route"]["model"]
        model.update(context_window=32768, max_completion_tokens=4096)
        rpc("agent.run", {
            "session_id": prepared["session_id"],
            "task_id": prepared["task_id"],
            "executable": str(harness_binary),
            "harness_home": str(root / "home"),
            "cwd": str(workspace),
            "model": model,
            "prompt": prompt,
            "permission_profile": profile,
            "read_only": read_only,
            "max_turns": 3,
            "auto_compact_threshold_percent": 0,
            "supervision": {"max_interventions": 0},
        })
        deadline = time.monotonic() + 90
        while not any(event["kind"] in ("agent.finished", "agent.error") for event in events):
            assert time.monotonic() < deadline, events[-5:]
            time.sleep(0.2)
        assert requests, "Model did not receive a tool catalog"
        assert not any(event["kind"] == "agent.error" for event in events), "Native agent failed"
        assert issued, "Model never attempted the controlled tool call"
        offered = {tool["function"]["name"] for request in requests for tool in request.get("tools", [])}
        # session_title is an internal conversation-label tool and cannot touch
        # the project. All external tools, shell execution, and editing must be absent.
        if read_only or profile != "full":
            assert offered <= {"read_file", "list_dir", "grep", "session_title"}, offered
        marker = root / "outside.txt" if outside else workspace / "write-marker.txt"
        if read_probe:
            # The model never receives the random fixture token in its prompt or
            # stub response. Only a native read result can deliver it back.
            results = [message for request in requests for message in request.get("messages", [])
                       if message.get("role") == "tool" and message.get("tool_call_id") == "controlled-read"]
            assert results, "Native tool result was not returned to the model"
            assert any(read_token in str(message.get("content", "")) for message in results), ("Native read did not return the isolated fixture", results)
            assert read_target.read_text(encoding="utf-8") == read_token, "Read changed the fixture"
            assert not marker.exists(), "Read created a write marker"
        elif read_only or profile != "full":
            assert not marker.exists(), "Forbidden write reached the filesystem"
        else:
            # Full is explicitly unrestricted/bypassPermissions, including
            # isolated paths outside cwd. It is not a workspace sandbox.
            assert marker.exists(), "Authorized Full write did not execute"
        print(f"PASS: {profile} profile, read_only={read_only}, outside={outside}, read_probe={read_probe}, absolute={absolute}")
        print("offered tools:", ", ".join(sorted(offered)))
        if "--two-turn" in sys.argv:
            assert profile == "full" and read_only and not outside
            issued = False
            prior_events = len(events)
            prior_requests = len(requests)
            next_prompt = "Now create the marker file in the workspace."
            continued = rpc("harness.continue", {
                "session_id": prepared["session_id"],
                "prompt": next_prompt,
                "provider": {"apiProvider": "openai", "openAiBaseUrl": endpoint, "openAiApiKey": "stub", "openAiModelId": "probe"},
            })
            next_model = continued["route"]["model"]
            next_model.update(context_window=32768, max_completion_tokens=4096)
            rpc("agent.run", {
                "session_id": prepared["session_id"],
                "task_id": continued["task_id"],
                "executable": str(harness_binary),
                "harness_home": str(root / "home"),
                "cwd": str(workspace),
                "model": next_model,
                "prompt": next_prompt,
                "permission_profile": "full",
                "read_only": False,
                "resume": True,
                "max_turns": 3,
                "auto_compact_threshold_percent": 0,
                "supervision": {"max_interventions": 0},
            })
            deadline = time.monotonic() + 90
            while not any(event["kind"] in ("agent.finished", "agent.error") for event in events[prior_events:]):
                assert time.monotonic() < deadline, events[-5:]
                time.sleep(0.2)
            next_offered = {tool["function"]["name"] for request in requests[prior_requests:] for tool in request.get("tools", [])}
            assert "run_terminal_command" in next_offered, next_offered
            assert marker.exists(), "Subsequent authorized write was blocked"
            print("PASS: same session resumed with full profile; later write request succeeded")
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        server.shutdown()
