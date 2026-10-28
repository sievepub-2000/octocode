"""Exercise the installed host with an isolated database and real process restarts."""
import json
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading


root = Path("E:/Program Files/octocode")
scope = root / "test"
fixture = Path(tempfile.mkdtemp(prefix="host-lifecycle-", dir=scope))
extensions = root / "data/extensions"
registered = json.loads((extensions / "extensions.json").read_text(encoding="utf-8"))
active = [item for item in registered if item["identifier"]["id"] == "octocode.octocode"]
assert len(active) == 1, "Expected one registered OctoCode extension"
extension = (extensions / active[0]["relativeLocation"]).resolve()
assert extension.is_relative_to(extensions.resolve()), "Extension must stay in the installed root"
binary = extension / "bin/win32-x64/octocode-host.exe"
process = None
serial = 0
checks = []


def start():
    global process, replies
    process = subprocess.Popen([str(binary), "--db", str(fixture / "owned.db")],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", cwd=fixture)
    replies = queue.Queue()
    stream = process.stdout
    threading.Thread(target=lambda: [replies.put(json.loads(line)) for line in stream], daemon=True).start()


def stop():
    if process is not None:
        process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
            raise
        assert process.returncode == 0, process.stderr.read()


def call(method, **params):
    global serial
    serial += 1
    process.stdin.write(json.dumps({"id": serial, "method": method, "params": params}) + "\n")
    process.stdin.flush()
    response = replies.get(timeout=15)
    assert response["id"] == serial, response
    assert "error" not in response, response
    return response.get("result")


try:
    start()
    assert call("ping")["pong"]
    assert call("capabilities.list")["methods"]
    call("session.create", id="owned-session", title="created", workspace=str(fixture))
    assert call("session.get", id="owned-session")["title"] == "created"
    call("session.update", id="owned-session", title="updated")
    assert call("session.get", id="owned-session")["title"] == "updated"
    project = call("project.create", name="owned project", session_ids=["owned-session"], workspace=str(fixture))["project"]
    call("project.rename", id=project["id"], name="renamed project")
    assert any(p["id"] == project["id"] and p["name"] == "renamed project" for p in call("project.list"))
    directory = Path(call("session.working_directory", id="owned-session")["working_directory"].removeprefix("\\\\?\\"))
    assert directory.resolve().is_relative_to(fixture.resolve()), directory
    sentinel = directory / "keep-user-file.txt"
    sentinel.write_text("keep after archive", encoding="utf-8")
    call("message.append", id="owned-message", session_id="owned-session", role="user", content="created")
    assert call("message.list", session_id="owned-session")[0]["content"] == "created"
    call("message.update", id="owned-message", content="updated")
    assert call("message.list", session_id="owned-session")[0]["content"] == "updated"
    call("setting.set", key="owned-test", value={"step": 1})
    assert call("setting.get", key="owned-test") == {"step": 1}
    call("setting.set", key="owned-test", value={"step": 2})
    call("event.append", session_id="owned-session", kind="text", payload={"text": "persisted"})
    events = call("event.page", session_id="owned-session", include_timestamps=True)
    assert any(row[1] == "text" and isinstance(row[3], int) for row in events["rows"])
    checkpoint = dict(id="owned-checkpoint", session_id="owned-session", objective="owned", phase="verify",
                      attempt=1, max_attempts=2, verdict="reject")
    call("supervisor.checkpoint", **checkpoint)
    assert call("supervisor.resume", id="owned-checkpoint")["status"] == "running"
    call("supervisor.checkpoint", **{**checkpoint, "attempt": 2, "verdict": "accept"})
    log = call("log.create", category="system", level="info", subsystem="acceptance", message="owned marker")
    assert any(row["id"] == log["id"] for row in call("log.list", category="system", keyword="owned marker"))
    stop()
    start()
    assert call("session.get", id="owned-session")["title"] == "updated"
    assert call("message.list", session_id="owned-session")[0]["content"] == "updated"
    assert call("setting.get", key="owned-test") == {"step": 2}
    assert call("supervisor.resume", id="owned-checkpoint")["status"] == "completed"
    assert call("event.page", session_id="owned-session", include_timestamps=True)["rows"] == events["rows"]
    assert sentinel.read_text(encoding="utf-8") == "keep after archive"
    call("message.delete", id="owned-message")
    assert not call("message.list", session_id="owned-session")
    call("setting.delete", key="owned-test")
    assert call("setting.get", key="owned-test") is None
    call("supervisor.delete", id="owned-checkpoint")
    assert call("supervisor.resume", id="owned-checkpoint") is None
    call("log.delete", id=log["id"], category="system")
    assert not call("log.list", category="system", keyword="owned marker")
    call("project.delete", id=project["id"])
    assert not any(p["id"] == project["id"] for p in call("project.list"))
    call("session.delete", id="owned-session")
    assert call("session.get", id="owned-session") is None
    assert not call("event.page", session_id="owned-session")["rows"]
    assert sentinel.read_text(encoding="utf-8") == "keep after archive"
    report = {"status": "PASS", "rpcCalls": serial, "installedExecutable": str(binary),
              "closedLifecycles": ["project", "session", "message", "setting", "supervisor", "log"],
              "eventsPersistedWithOriginalTimestamps": True, "processRestartReadback": True,
              "archivePreservesUserFiles": True, "productionDatabaseTouched": False}
    print(json.dumps(report))
finally:
    if process is not None and process.poll() is None:
        stop()
    assert fixture.resolve().parent == scope.resolve()
    shutil.rmtree(fixture)
