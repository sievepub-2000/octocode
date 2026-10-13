"""Exercise multiple active OctoCode sessions against an isolated daemon database."""

if not __debug__:
    raise RuntimeError('This verification requires Python assertions; do not use -O/-OO or PYTHONOPTIMIZE')

import base64
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import time
from contextlib import closing


source = pathlib.Path(__file__).resolve().parents[2] / "desktop-shell" / "build" / "environment-scripts" / "octocode_api.py"
spec = importlib.util.spec_from_file_location("octocode_api_test", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

with tempfile.TemporaryDirectory(prefix="octocode-monitor-") as directory:
    root = pathlib.Path(directory)
    module.STORE = root / "harness-runtime"
    module.STORE.mkdir()
    module.STATE = root / "daemon-state"
    module.ACTIVE_SESSIONS.clear()
    module.RECOVERY_PENDING.clear()
    now = int(time.time() * 1000)
    with closing(sqlite3.connect(root / "octocode.db")) as database:
        database.executescript(
            "CREATE TABLE sessions(id TEXT, status TEXT, updated_at INTEGER);"
            "CREATE TABLE events(session_id TEXT, sequence INTEGER, kind TEXT, payload TEXT);"
        )
        database.executemany(
            "INSERT INTO sessions VALUES(?,?,?)",
            [("active-a", "running", now), ("active-b", "running", now),
             ("finished", "completed", now), ("interrupted-new", "interrupted", now),
             ("interrupted-old", "interrupted", now - 600_000)],
        )
        for session_id in ("active-a", "active-b"):
            encoded = base64.urlsafe_b64encode(session_id.encode()).decode().rstrip("=")
            config = module.STORE / "sessions" / f"s-{encoded}" / "config.toml"
            config.parent.mkdir(parents=True)
            config.write_text("[model.octocode-selected]\ncontext_window=1000\n", encoding="utf-8")
        for sequence in range(1, 7, 2):
            database.execute("INSERT INTO events VALUES(?,?,?,?)", ("active-a", sequence, "auto_compact_completed", "{}"))
            database.execute("INSERT INTO events VALUES(?,?,?,?)", ("active-a", sequence + 1, "usage", json.dumps({"usage": {"input_tokens": 950}})))
        database.execute("INSERT INTO events VALUES(?,?,?,?)", ("active-b", 1, "usage", json.dumps({"usage": {"input_tokens": 200}})))
        database.commit()
    snapshot = module.monitor_active_sessions()
    assert {item["session_id"] for item in snapshot} == {"active-a", "active-b"}, snapshot
    state = {item["session_id"]: item for item in snapshot}
    assert state["active-a"]["needs_new_session"] is True, state["active-a"]
    assert state["active-a"]["high_compactions"] == 3, state["active-a"]
    assert state["active-b"]["needs_new_session"] is False, state["active-b"]
    assert module.RECOVERY_PENDING == {"interrupted-new"}, module.RECOVERY_PENDING
    with closing(sqlite3.connect(root / "octocode.db")) as database:
        database.execute("UPDATE sessions SET status='completed' WHERE id='active-a'")
        database.commit()
    snapshot = module.monitor_active_sessions()
    assert {item["session_id"] for item in snapshot} == {"active-b"}, snapshot
    module.RESOURCE_STREAK = 0
    module.RESTART_REQUESTED = False
    module.LAST_RESOURCE_RESTART = 0
    critical = {"memory_free_percent": 4, "disk_free_percent": 50}
    assert module.update_resource_pressure(critical, 1_000_000) is False
    assert module.update_resource_pressure(critical, 1_000_001) is False
    assert module.update_resource_pressure(critical, 1_000_002) is True
    print("PASS: two running sessions tracked independently; completed history excluded; recent crash queued")
    print("PASS: sustained critical resource pressure requests a restart only after three checks")
