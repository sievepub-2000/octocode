"""Regression checks for the daemon state machine, with isolated state."""
import importlib.util
import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from contextlib import closing
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class DaemonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TemporaryDirectory()
        os.environ["OCTOCODE_ROOT"] = cls.temp.name
        os.environ["OCTOCODE_DAEMON_STATE"] = str(Path(cls.temp.name) / "state")
        spec = importlib.util.spec_from_file_location("octocode_api", Path(__file__).with_name("octocode_api.py"))
        cls.api = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.api
        spec.loader.exec_module(cls.api)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_rejects_invalid_daily_time(self):
        with self.assertRaises(ValueError):
            self.api.RoutineRequest(name="bad", prompt="x", cwd=self.temp.name, daily_at="99:99")

    def test_health_is_not_ready_without_harness(self):
        self.assertFalse(self.api.health()["ok"])

    def test_health_requires_a_live_scheduler(self):
        with patch.object(self.api, "extension_binary", return_value=Path(__file__)), \
             patch.object(self.api, "load_json", return_value={"at": "2000-01-01T00:00:00"}):
            self.assertFalse(self.api.health()["ok"])

    def test_parent_crash_keeps_daemon_alive_until_explicit_shutdown(self):
        with TemporaryDirectory() as root:
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            env = {**os.environ, "OCTOCODE_ROOT": root, "OCTOCODE_DAEMON_STATE": str(Path(root) / "state"),
                   "OCTOCODE_DAEMON_PARENT_PIPE": "1", "OCTOCODE_API_TOKEN": "test-secret"}
            process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("octocode_api.py")),
                                        "--port", str(port)], env=env, stdin=subprocess.PIPE,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
            try:
                for _ in range(50):
                    try:
                        with urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as response:
                            health = json.load(response)
                        break
                    except OSError:
                        self.assertIsNone(process.poll())
                        time.sleep(0.1)
                else:
                    self.fail("daemon did not start")
                self.assertEqual(health["pid"], process.pid)
                process.stdin.close()
                time.sleep(0.3)
                self.assertIsNone(process.poll())
                endpoint = f"http://127.0.0.1:{port}/v1/daemon/shutdown"
                with self.assertRaises(HTTPError) as denied:
                    urlopen(Request(endpoint, method="POST"), timeout=2)
                self.assertEqual(denied.exception.code, 401)
                denied.exception.close()
                with urlopen(Request(endpoint, method="POST", headers={"Authorization": "Bearer test-secret"}), timeout=2) as response:
                    self.assertTrue(json.load(response)["stopping"])
                self.assertEqual(process.wait(timeout=15), 0)
                with self.assertRaises(OSError):
                    urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)

    def test_attach_tracks_a_live_desktop_pid(self):
        with patch.object(self.api, "process_alive", return_value=True):
            self.assertEqual(self.api.attach_desktop(123)["desktop_pid"], 123)
        self.api.DESKTOP_PID = 0

    def test_crashed_desktop_restarts_once_and_tracks_new_pid(self):
        executable = self.api.ROOT / ("OctoCode.exe" if sys.platform == "win32" else "octocode")
        executable.touch()
        self.api.DESKTOP_PID = 123
        try:
            with patch.object(self.api, "process_alive", side_effect=lambda pid: pid == 456), \
                 patch.object(self.api.STOP, "wait", side_effect=[False, False, True]), \
                 patch.object(self.api.subprocess, "Popen", return_value=SimpleNamespace(pid=456)) as launch:
                self.api.watch_desktop()
            self.assertEqual(self.api.DESKTOP_PID, 456)
            launch.assert_called_once()
        finally:
            executable.unlink()
            self.api.DESKTOP_PID = 0

    def test_resource_restart_requires_sustained_pressure_and_cooldown(self):
        self.api.RESOURCE_STREAK = 0
        self.api.RESTART_REQUESTED = False
        self.api.LAST_RESOURCE_RESTART = 0
        try:
            with patch.object(self.api, "save_json") as save:
                self.assertFalse(self.api.update_resource_pressure({"memory_free_percent": 4, "disk_free_percent": 30}, 1000))
                self.assertFalse(self.api.update_resource_pressure({"memory_free_percent": 4, "disk_free_percent": 30}, 1001))
                self.assertTrue(self.api.update_resource_pressure({"memory_free_percent": 4, "disk_free_percent": 30}, 1002))
                save.assert_called_once_with("resource-restart.json", {"last_requested": 1002})
                self.api.acknowledge_restart()
                self.assertFalse(self.api.update_resource_pressure({"memory_free_percent": 4, "disk_free_percent": 30}, 1003))
                self.assertTrue(self.api.update_resource_pressure({"memory_free_percent": 60, "disk_free_percent": 1}, 1602))
        finally:
            self.api.RESOURCE_STREAK = 0
            self.api.RESTART_REQUESTED = False
            self.api.LAST_RESOURCE_RESTART = 0

    def test_corrupt_state_is_reported_and_preserved(self):
        self.api.STATE.mkdir(parents=True, exist_ok=True)
        state = self.api.STATE / "routines.json"
        state.write_text("{broken", encoding="utf-8")
        try:
            with self.assertRaises(ValueError):
                self.api.load_json("routines.json")
            self.assertEqual(state.read_text(encoding="utf-8"), "{broken")
        finally:
            state.unlink()

    def test_run_history_survives_process_memory_loss(self):
        self.api.STATE.joinpath("runs").mkdir(parents=True, exist_ok=True)
        saved = self.api.STATE / "runs" / "historical.json"
        saved.write_text('{"run_id":"historical","status":"completed","prompt":"private"}', encoding="utf-8")
        try:
            self.assertEqual(self.api.read_run("historical")["status"], "completed")
            self.assertNotIn("prompt", self.api.read_run("historical"))
            self.assertIn("historical", [run["run_id"] for run in self.api.list_runs()])
        finally:
            saved.unlink()

    def test_restart_marks_unfinished_run_interrupted(self):
        folder = self.api.STATE / "runs"
        folder.mkdir(parents=True, exist_ok=True)
        saved = folder / "unfinished.json"
        saved.write_text('{"run_id":"unfinished","status":"running","prompt":"private"}', encoding="utf-8")
        try:
            self.api.mark_interrupted()
            record = json.loads(saved.read_text(encoding="utf-8"))
            self.assertEqual(record["status"], "interrupted")
            self.assertIsNotNone(record["finished"])
            self.assertEqual(record["prompt"], "private")
        finally:
            saved.unlink()

    def test_monitors_only_running_sessions_without_mixing_context(self):
        database = self.api.STORE.parent / "octocode.db"
        database.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(database)) as connection:
            connection.executescript("CREATE TABLE sessions(id TEXT,status TEXT,updated_at INTEGER);"
                                     "CREATE TABLE events(sequence INTEGER PRIMARY KEY,session_id TEXT,kind TEXT,payload TEXT);")
            now = int(time.time() * 1000)
            connection.executemany("INSERT INTO sessions VALUES (?,?,?)", [("a", "running", now), ("b", "running", now),
                                                              ("old", "completed", now), ("early", "interrupted", now),
                                                              ("ancient", "interrupted", 0)])
            for session_id in ("a", "b"):
                encoded = self.api.base64.urlsafe_b64encode(session_id.encode()).decode().rstrip("=")
                config = self.api.STORE / "sessions" / f"s-{encoded}" / "config.toml"
                config.parent.mkdir(parents=True)
                config.write_text("[model.octocode-selected]\ncontext_window = 100\n", encoding="utf-8")
            sequence = 0
            for _ in range(3):
                for session_id, used in (("a", 95), ("b", 20), ("old", 99)):
                    for kind, payload in (("auto_compact_completed", {}), ("usage", {"usage": {"input_tokens": used}})):
                        sequence += 1
                        connection.execute("INSERT INTO events VALUES (?,?,?,?)",
                                           (sequence, session_id, kind, json.dumps(payload)))
            connection.commit()
        try:
            self.api.ACTIVE_SESSIONS.clear()
            snapshots = {item["session_id"]: item for item in self.api.monitor_active_sessions()}
            self.assertEqual(set(snapshots), {"a", "b"})
            self.assertEqual(self.api.RECOVERY_PENDING, {"early"})
            self.assertTrue(snapshots["a"]["needs_new_session"])
            self.assertFalse(snapshots["b"]["needs_new_session"])
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("UPDATE sessions SET status='completed' WHERE id='a'")
                connection.commit()
            self.assertEqual({item["session_id"] for item in self.api.monitor_active_sessions()}, {"b"})
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("UPDATE sessions SET status='interrupted' WHERE id='b'")
                connection.commit()
            self.assertEqual(self.api.monitor_active_sessions(), [])
            self.assertEqual(self.api.RECOVERY_PENDING, {"early", "b"})
            with closing(sqlite3.connect(database)) as connection:
                connection.execute("INSERT INTO events VALUES (?,?,?,?)", (sequence + 1, "new", "harness.prepared",
                                   json.dumps({"handoff": {"source_session_id": "b"}})))
                connection.commit()
            self.api.monitor_active_sessions()
            self.assertEqual(self.api.RECOVERY_PENDING, {"early"})
        finally:
            database.unlink()
            self.api.ACTIVE_SESSIONS.clear()
            self.api.RECOVERY_PENDING.clear()

    def test_global_mcp_uses_only_project_local_config_and_data(self):
        project = Path(self.temp.name) / "project"
        project.mkdir(exist_ok=True)
        with patch.object(self.api, "bundled_mcp_servers", return_value={"shared": {"command": "global-tool"}}):
            servers, session = self.api.isolated_mcp_servers(str(project))
        self.assertIsNotNone(session)
        try:
            config = Path(servers["shared"]["env"]["OCTOCODE_PROJECT_TOOL_CONFIG"])
            data = Path(servers["shared"]["env"]["OCTOCODE_PROJECT_TOOL_DATA"])
            self.assertEqual(servers["shared"]["command"], "global-tool")
            self.assertEqual(config.read_text(encoding="utf-8"), "{}\n")
            self.assertTrue(data.is_dir())
            self.assertEqual(sorted(path.name for path in data.parent.iterdir()), ["config.json", "data", "reference.json"])
            self.assertTrue(config.is_relative_to(project))
        finally:
            self.api.shutil.rmtree(session)

    def test_finished_run_releases_its_project_tool_copy(self):
        project = Path(self.temp.name) / "project"
        project.mkdir(exist_ok=True)
        with patch.object(self.api, "bundled_mcp_servers", return_value={"shared": {"command": "global-tool"}}):
            _, session = self.api.isolated_mcp_servers(str(project))
        run = self.api.Run(self.api.RunRequest(prompt="check", cwd=str(project)))
        run.tool_copy_dir = session
        with patch.object(self.api, "host") as host, patch.object(self.api, "persist_run"):
            run.accept("agent.finished", {"success": True})
            host.return_value.listeners.pop.assert_called_once()
        self.assertFalse(session.exists())
        self.assertTrue(run.done.is_set())

    def test_resuming_a_running_goal_does_not_spawn_another_worker(self):
        goal = {"id": "g", "status": "running", "iterations": [], "max_iterations": 6}
        with patch.object(self.api, "load_json", return_value={"g": goal}), patch.object(self.api.threading, "Thread") as worker:
            with self.assertRaises(self.api.HTTPException) as caught:
                self.api.resume_goal("g")
            self.assertEqual(caught.exception.status_code, 409)
            worker.assert_not_called()

    def test_goal_wait_timeout_never_checks_or_marks_success(self):
        goal = {
            "id": "g", "status": "running", "prompt": "x", "cwd": self.temp.name,
            "check": "exit 0", "check_timeout": 10, "created": 100,
            "budget_minutes": 5, "max_iterations": 1, "iterations": [],
        }
        running = SimpleNamespace(id="r", session_id="s", status="running", done=SimpleNamespace(wait=lambda _: False), task_id="t")
        with patch.object(self.api, "load_json", return_value={"g": goal}), \
             patch.object(self.api, "save_json"), \
             patch.object(self.api, "start_run", return_value=running), \
             patch.object(self.api, "run_check", return_value=(0, "ok")) as check, \
             patch.object(self.api.time, "time", return_value=100), \
             patch.object(self.api, "host") as host:
            self.api.goal_loop("g")
        check.assert_not_called()
        self.assertNotEqual(goal["status"], "met")
        host.return_value.call.assert_called_with("agent.cancel", {"task_id": "t"})

    def test_goal_wait_is_limited_to_remaining_budget(self):
        goal = {
            "id": "g", "status": "running", "prompt": "x", "cwd": self.temp.name,
            "check": "exit 0", "check_timeout": 10, "created": 100,
            "budget_minutes": 5, "max_iterations": 1, "iterations": [],
        }
        wait = Mock(return_value=False)
        running = SimpleNamespace(id="r", session_id="s", status="running", done=SimpleNamespace(wait=wait), task_id="t")
        with patch.object(self.api, "load_json", return_value={"g": goal}), \
             patch.object(self.api, "save_json"), \
             patch.object(self.api, "start_run", return_value=running), \
             patch.object(self.api.time, "time", return_value=399), \
             patch.object(self.api, "host"):
            self.api.goal_loop("g")
        self.assertEqual(wait.call_args_list[0].args[0], 1)

    def test_goal_check_timeout_fails(self):
        command = "Start-Sleep -Seconds 3" if sys.platform == "win32" else "sleep 3"
        code, output = self.api.run_check(command, self.temp.name, 1)
        self.assertEqual(code, -1)
        self.assertIn("timed out", output)


if __name__ == "__main__":
    unittest.main()
