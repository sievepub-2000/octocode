"""Regression checks for the daemon state machine, with isolated state."""
import importlib.util
import json
import os
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path, PurePosixPath, PureWindowsPath
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
        cls.addClassCleanup(cls.temp.cleanup)
        environment = patch.dict(os.environ, {"OCTOCODE_ROOT": cls.temp.name,
                                             "OCTOCODE_DAEMON_STATE": str(Path(cls.temp.name) / "state")})
        environment.start()
        cls.addClassCleanup(environment.stop)
        spec = importlib.util.spec_from_file_location("octocode_api", Path(__file__).with_name("octocode_api.py"))
        cls.api = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.api
        spec.loader.exec_module(cls.api)

    def setUp(self):
        state = patch.multiple(self.api, DESKTOP_PID=0, RESOURCE_STREAK=0,
                               RESTART_REQUESTED=False, LAST_RESOURCE_RESTART=0,
                               ACTIVE_SESSIONS={}, RECOVERY_PENDING=set())
        state.start()
        self.addCleanup(state.stop)

    def test_rejects_invalid_daily_time(self):
        with self.assertRaises(ValueError):
            self.api.RoutineRequest(name="bad", prompt="x", cwd=self.temp.name, daily_at="99:99")

    def test_failed_run_retains_provider_error_after_terminal_summary(self):
        run = self.api.Run(self.api.RunRequest(prompt="owned", cwd=self.temp.name))
        run.events = [{"type": "error", "message": "oMLX prefill memory guard rejected this prompt",
                       "error_code": "prefill_memory_exceeded", "recoverable": True}]
        run.result = {"success": False, "attempts": 1}
        run.status = "failed"
        self.assertEqual(run.summary()["error"], "oMLX prefill memory guard rejected this prompt")
        run.result["message"] = "explicit terminal error"
        self.assertEqual(run.summary()["error"], "explicit terminal error")
        run.status = "completed"
        self.assertIsNone(run.summary()["error"])

    def test_failed_host_reader_start_releases_owned_process_and_log(self):
        processes, logs = [], []
        popen, open_file = subprocess.Popen, open

        def launch_fixture(*args, **kwargs):
            process = popen([sys.executable, "-c", "import time; time.sleep(30)"], **kwargs)
            processes.append(process)
            return process

        def record_log(*args, **kwargs):
            log = open_file(*args, **kwargs)
            logs.append(log)
            return log

        try:
            with patch.object(self.api, "extension_binary", return_value=Path(sys.executable)), \
                 patch.object(self.api, "open", side_effect=record_log, create=True), \
                 patch.object(self.api.subprocess, "Popen", side_effect=launch_fixture), \
                 patch.object(self.api.threading, "Thread") as reader:
                reader.return_value.start.side_effect = RuntimeError("fixture reader start failed")
                with self.assertRaisesRegex(RuntimeError, "fixture reader start failed"):
                    self.api.HostClient()
            self.assertIsNotNone(processes[0].poll(), "failed constructor left its child running")
            self.assertTrue(logs[0].closed, "failed constructor left its log open")
            self.assertTrue(processes[0].stdin.closed)
            self.assertTrue(processes[0].stdout.closed)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
                for stream in (process.stdin, process.stdout):
                    if stream:
                        stream.close()
            for log in logs:
                log.close()

    def test_missing_host_binary_closes_startup_log(self):
        logs = []
        open_file = open

        def record_log(*args, **kwargs):
            log = open_file(*args, **kwargs)
            logs.append(log)
            return log

        try:
            with patch.object(self.api, "open", side_effect=record_log, create=True), \
                 patch.object(self.api, "extension_binary", side_effect=RuntimeError("fixture binary missing")):
                with self.assertRaisesRegex(RuntimeError, "fixture binary missing"):
                    self.api.HostClient()
            self.assertTrue(logs[0].closed)
        finally:
            for log in logs:
                log.close()

    def test_non_ascii_invalid_bearer_is_unauthorized(self):
        request = SimpleNamespace(headers={"authorization": "Bearer \u00e9"})
        with patch.dict(os.environ, {"OCTOCODE_API_TOKEN": "isolated"}):
            with self.assertRaises(self.api.HTTPException) as denied:
                self.api.authorize(request)
        self.assertEqual(denied.exception.status_code, 401)

    def test_routine_goal_schemas_ignore_undeclared_credential_names(self):
        extras = {key: "undeclared-test-value" for key in ("apiKey", "token", "password", "secret")}
        for schema, fields in (
            (self.api.RoutineRequest, {"name": "isolated", "every_minutes": 60}),
            (self.api.GoalRequest, {"check": "exit 0"}),
        ):
            with self.subTest(schema=schema.__name__):
                record = schema(prompt="isolated", cwd=self.temp.name, **fields, **extras,
                                model={"api_key": "declared-test-value", **extras}).model_dump()
                self.assertEqual(record["model"]["api_key"], "declared-test-value")
                for key in extras:
                    self.assertNotIn(key, record)
                    self.assertNotIn(key, record["model"])
                public = self.api.public_record(record)
                self.assertNotIn("api_key", public["model"])
                self.assertEqual(record["model"]["api_key"], "declared-test-value")

    def test_all_permission_profiles_are_forwarded_explicitly(self):
        client = SimpleNamespace(listeners={}, call=Mock())
        for mode in ("review", "directory", "full"):
            with self.subTest(mode=mode):
                client.call.reset_mock()
                client.call.return_value = {"session_id": "isolated", "task_id": "isolated",
                                            "route": {"model": {}}}
                with patch.object(self.api, "host", return_value=client), \
                     patch.object(self.api, "provider_input", return_value=({"openAiApiKey": ""}, "")), \
                     patch.object(self.api, "extension_binary", return_value=Path(__file__)), \
                     patch.object(self.api, "isolated_mcp_servers", return_value=({}, None)):
                    run = self.api.start_run(self.api.RunRequest(prompt="isolated", cwd=self.temp.name,
                                                                permission_mode=mode, review=False))
                try:
                    forwarded = next(call.args[1] for call in client.call.call_args_list
                                     if call.args[0] == "agent.run")
                    self.assertEqual(forwarded["permission_profile"], mode)
                finally:
                    self.api.RUNS.pop(run.id, None)
                    (self.api.STATE / "runs" / f"{run.id}.json").unlink()
        with self.assertRaises(ValueError):
            self.api.RunRequest(prompt="isolated", cwd=self.temp.name, permission_mode="invalid")

    def test_prepared_conversation_cwd_is_used_and_cross_project_resume_is_rejected(self):
        import base64
        with TemporaryDirectory() as root:
            project = Path(root) / "project"
            project.mkdir()
            sid = "isolated-session"
            encoded = base64.urlsafe_b64encode(sid.encode()).decode().rstrip("=")
            working = project / ".octocode" / "sessions" / encoded
            working.mkdir(parents=True)
            prepared = {"session_id": sid, "task_id": "owned", "workspace": str(project), "working_directory": str(working), "route": {"model": {}}}
            client = SimpleNamespace(listeners={}, call=Mock(return_value=prepared))
            with patch.object(self.api, "STORE", Path(root) / "store"), \
                 patch.object(self.api, "STATE", Path(root) / "state"), patch.object(self.api, "RUNS", {}), \
                 patch.object(self.api, "host", return_value=client), \
                 patch.object(self.api, "provider_input", return_value=({"openAiApiKey": ""}, "")), \
                 patch.object(self.api, "extension_binary", return_value=Path(__file__)), \
                 patch.object(self.api, "isolated_mcp_servers", return_value=({}, None)) as tools:
                task = "Task-local guidance: prefer relative input paths.\nUser task: read project inputs"
                run = self.api.start_run(self.api.RunRequest(prompt=task, cwd=str(project), review=False))
                forwarded = next(c.args[1] for c in client.call.call_args_list if c.args[0] == "agent.run")
                self.assertEqual(Path(forwarded["cwd"]), working)
                self.assertIn(project.resolve().as_posix(), forwarded["prompt"])
                self.assertIn(working.resolve().as_posix(), forwarded["prompt"])
                self.assertIn("Use absolute source-project paths", forwarded["prompt"])
                self.assertIn(project.resolve().as_posix() + "/<project-relative-input>", forwarded["prompt"])
                self.assertIn("Do not guess parent-relative paths", forwarded["prompt"])
                self.assertGreater(forwarded["prompt"].index("Required file-path contract"), forwarded["prompt"].index(task))
                self.assertEqual(forwarded["permission_profile"], "directory")
                tools.assert_called_once_with(str(working))
                self.assertEqual(run.summary()["source_cwd"], str(project))
                run.status = "completed"
                other = Path(root) / "other"
                other.mkdir()
                client.call.reset_mock()
                with self.assertRaises(self.api.HTTPException) as denied:
                    self.api.start_run(self.api.RunRequest(prompt="read other", cwd=str(other), session_id=sid, resume=True))
                self.assertEqual(denied.exception.status_code, 400)
                self.assertEqual([c.args[0] for c in client.call.call_args_list], ["session.get"])

    def test_explicit_model_does_not_read_desktop_credentials(self):
        with patch.object(self.api, "last_app_model", side_effect=AssertionError("must not read desktop")), \
             patch.object(self.api, "context_window", return_value=1048576):
            provider, key = self.api.provider_input(self.api.ModelSpec(model="explicit", base_url="http://localhost:1234/v1", api_key="fixture"))
        self.assertEqual(provider["openAiModelId"], "explicit")
        self.assertEqual(key, "fixture")
        self.assertEqual(provider["modelContextWindow"], 1048576)

    def test_saved_provider_controls_and_discovered_context_are_preserved(self):
        saved = {"model": "selected", "base_url": "http://localhost:1234/v1", "api_key": "fixture", "context_window": 1048576,
                 "provider": {"reasoningEffort": "high", "enableReasoningEffort": True, "reasoningStyle": "template", "apiFormat": "responses", "modelMaxTokens": 65536}}
        with patch.object(self.api, "last_app_model", return_value=saved), patch.object(self.api, "context_window", return_value=1048576):
            provider, _ = self.api.provider_input(None)
            overridden, _ = self.api.provider_input(self.api.ModelSpec(thinking="disable"))
        self.assertEqual(provider["modelContextWindow"], 1048576)
        self.assertEqual(provider["modelMaxTokens"], 65536)
        self.assertEqual(provider["apiFormat"], "responses")
        self.assertEqual(provider["reasoningEffort"], "high")
        self.assertTrue(provider["enableReasoningEffort"])
        self.assertEqual(overridden["reasoningEffort"], "disable")
        self.assertFalse(overridden["enableReasoningEffort"])
        self.assertNotIn("openAiApiKey", saved["provider"])

    def test_invalid_session_home_is_rejected_before_native_prepare_or_continue(self):
        client = SimpleNamespace(listeners={}, call=Mock(return_value={
            "session_id": "x/../../../owned-escape", "task_id": "owned", "route": {"model": {}}}))
        with TemporaryDirectory() as root, patch.object(self.api, "STORE", Path(root) / "store"), \
             patch.object(self.api, "STATE", Path(root) / "state"), patch.object(self.api, "RUNS", {}), \
             patch.object(self.api, "host", return_value=client), \
             patch.object(self.api, "provider_input", return_value=({"openAiApiKey": ""}, "")), \
             patch.object(self.api, "extension_binary", return_value=Path(__file__)), \
             patch.object(self.api, "isolated_mcp_servers", return_value=({}, None)):
            for resume in (False, True):
                self.api.RUNS.clear()
                client.call.reset_mock()
                with self.subTest(resume=resume):
                    with self.assertRaises(self.api.HTTPException) as denied:
                        self.api.start_run(self.api.RunRequest(prompt="owned", cwd=self.temp.name,
                                                               session_id="x/../../../owned-escape", resume=resume))
                    self.assertEqual(denied.exception.status_code, 400)
                    client.call.assert_not_called()

    def test_portable_ids_preserve_old_home_and_invalid_ids_are_rejected(self):
        invalid = ["", ".", "..", "a/b", "a\\b", "/absolute", "C:\\absolute", "C:relative",
                   "\\\\server\\share", "a\x00b", "a\nb", "a\x7fb", "a\x85b", "a.", "a ",
                   "a<b", "a>b", "a:b", 'a"b', "a|b", "a?b", "a*b"]
        with TemporaryDirectory() as root, patch.object(self.api, "STORE", Path(root)):
            for sid in invalid:
                with self.subTest(sid=repr(sid)):
                    with self.assertRaises(self.api.HTTPException) as denied:
                        self.api.daemon_session_home(sid)
                    self.assertEqual(denied.exception.status_code, 400)
            for sid in ["351e155a-d175-4275-9b0e-459536e316bc", "安全会话-é", "custom_safe-42",
                        "CON", "PRN", "AUX", "NUL", "COM1.txt", "LPT9", "CONIN$", "CONOUT$"]:
                with self.subTest(sid=sid):
                    expected = Path(root) / "sessions" / f"d-{sid}"
                    self.assertEqual(self.api.daemon_session_home(sid), expected)
                    for pure in (PureWindowsPath, PurePosixPath):
                        self.assertEqual(pure(f"d-{sid}").parts, (f"d-{sid}",))

    def test_resume_preserves_uuid_home_sentinel_and_prepared_id_is_rechecked(self):
        client = SimpleNamespace(listeners={}, call=Mock())
        with TemporaryDirectory() as root, patch.object(self.api, "STORE", Path(root) / "store"), \
             patch.object(self.api, "STATE", Path(root) / "state"), patch.object(self.api, "RUNS", {}), \
             patch.object(self.api, "host", return_value=client), \
             patch.object(self.api, "provider_input", return_value=({"openAiApiKey": ""}, "")), \
             patch.object(self.api, "extension_binary", return_value=Path(__file__)), \
             patch.object(self.api, "isolated_mcp_servers", return_value=({}, None)):
            for sid, mode in [("351e155a-d175-4275-9b0e-459536e316bc", "review"),
                              ("CON", "directory"), ("COM1.txt", "full")]:
                home = self.api.STORE / "sessions" / f"d-{sid}"
                home.mkdir(parents=True)
                sentinel = home / "owned-old-history"
                sentinel.write_bytes(b"owned original history")
                client.call.reset_mock()
                client.call.return_value = {"session_id": sid, "task_id": "owned", "route": {"model": {}}}
                client.call.side_effect = lambda method, params: {"workspace": root} if method == "session.get" else client.call.return_value
                self.api.RUNS.clear()
                run = self.api.start_run(self.api.RunRequest(prompt="owned", cwd=root, session_id=sid,
                                                            resume=True, review=False, permission_mode=mode))
                self.assertEqual(client.call.call_args_list[0].args[0], "session.get")
                self.assertEqual(client.call.call_args_list[1].args[0], "harness.continue")
                forwarded = client.call.call_args_list[2].args[1]
                self.assertEqual(forwarded["harness_home"], str(home))
                self.assertTrue(forwarded["resume"])
                self.assertEqual(forwarded["session_id"], sid)
                self.assertEqual(forwarded["permission_profile"], mode)
                self.assertEqual(sentinel.read_bytes(), b"owned original history")
            client.call.reset_mock()
            client.call.side_effect = None
            client.call.return_value = {"session_id": "x/../../escape", "task_id": "owned"}
            with self.assertRaises(self.api.HTTPException) as denied:
                self.api.start_run(self.api.RunRequest(prompt="owned", cwd=root, review=False))
            self.assertEqual(denied.exception.status_code, 400)
            self.assertEqual([c.args[0] for c in client.call.call_args_list], ["harness.prepare"])

    @unittest.skipUnless(sys.platform == "win32", "real Windows junction semantics")
    def test_existing_child_junction_escape_rejected_but_runtime_junction_allowed(self):
        with TemporaryDirectory() as root:
            root = Path(root)
            runtime_target = root / "owned-runtime-target"
            runtime_target.mkdir()
            runtime = root / "runtime"
            outside = root / "owned-outside"
            outside.mkdir()
            child = runtime_target / "sessions" / "d-owned"
            child.parent.mkdir()
            def junction(link, target):
                result = subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
                                        capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
                self.assertEqual(result.returncode, 0, result.stderr)
            try:
                junction(runtime, runtime_target)
                with patch.object(self.api, "STORE", runtime):
                    self.assertEqual(self.api.daemon_session_home("owned"), runtime / "sessions" / "d-owned")
                    junction(child, outside)
                    with self.assertRaises(self.api.HTTPException) as denied:
                        self.api.daemon_session_home("owned")
                    self.assertEqual(denied.exception.status_code, 400)
                    os.rmdir(child)
                    junction(child, child.parent)
                    with self.assertRaises(self.api.HTTPException) as parent_denied:
                        self.api.daemon_session_home("owned")
                    self.assertEqual(parent_denied.exception.status_code, 400)
            finally:
                if child.exists():
                    os.rmdir(child)
                if runtime.exists():
                    os.rmdir(runtime)

    def test_real_isolated_http_rejects_bad_ids_and_preserves_auth(self):
        import threading
        import uvicorn
        client = SimpleNamespace(listeners={}, call=Mock())
        with TemporaryDirectory() as root, patch.object(self.api, "STORE", Path(root) / "store"), \
             patch.object(self.api, "host", return_value=client), \
             patch.dict(os.environ, {"OCTOCODE_API_TOKEN": "owned-http-token"}):
            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            server = uvicorn.Server(uvicorn.Config(self.api.app, log_level="error", lifespan="off"))
            thread = threading.Thread(target=lambda: server.run(sockets=[sock]), daemon=True)
            thread.start()
            try:
                for _ in range(100):
                    if server.started:
                        break
                    time.sleep(0.02)
                self.assertTrue(server.started)
                for header, code in [(None, 401), ("Bearer owned-wrong", 401), ("Bearer owned-http-token", 400)]:
                    request = Request(f"http://127.0.0.1:{port}/v1/runs", method="POST",
                                      data=json.dumps({"prompt": "owned", "cwd": root,
                                                       "session_id": "x/../../../escape"}).encode(),
                                      headers={"Content-Type": "application/json", **({"Authorization": header} if header else {})})
                    with self.assertRaises(HTTPError) as denied:
                        urlopen(request, timeout=3)
                    with closing(denied.exception):
                        self.assertEqual(denied.exception.code, code)
                client.call.assert_not_called()
            finally:
                server.should_exit = True
                thread.join(timeout=5)
                sock.close()
                self.assertFalse(thread.is_alive())

    def test_existing_child_symlink_escape_is_rejected(self):
        with TemporaryDirectory() as root:
            root = Path(root)
            store = root / "store"
            outside = root / "owned-outside"
            outside.mkdir()
            link = store / "sessions" / "d-owned"
            link.parent.mkdir(parents=True)
            try:
                link.symlink_to(outside, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"owned directory symlink creation unavailable: errno={error.errno}, winerror={getattr(error, 'winerror', None)}")
            try:
                with patch.object(self.api, "STORE", store):
                    with self.assertRaises(self.api.HTTPException) as denied:
                        self.api.daemon_session_home("owned")
                    self.assertEqual(denied.exception.status_code, 400)
            finally:
                link.unlink()

    def test_goal_resume_clears_previous_terminal_metadata(self):
        goal = {"id": "g", "status": "failed", "iterations": [{"run_id": "previous", "check_exit": 1}], "max_iterations": 6,
                "finished": 1, "error": "previous failure", "model": {"api_key": "private"}}
        with patch.object(self.api, "load_json", return_value={"g": goal}), \
             patch.object(self.api, "save_json") as save, patch.object(self.api.threading, "Thread"):
            result = self.api.resume_goal("g")
        self.assertEqual(result["status"], "running")
        self.assertNotIn("finished", result)
        self.assertNotIn("error", result)
        self.assertEqual(result["iterations"], [{"run_id": "previous", "check_exit": 1}])
        self.assertNotIn("api_key", result["model"])
        self.assertEqual(save.call_args.args[1]["g"]["model"]["api_key"], "private")

    def test_health_is_not_ready_without_harness(self):
        self.assertFalse(self.api.health()["ok"])

    def test_daemon_accepts_explicit_models_without_a_selected_compatible_profile(self):
        with patch.object(self.api, "last_app_model", side_effect=RuntimeError("explicit model required")), \
             patch.object(self.api, "extension_binary", return_value=Path(__file__)), \
             patch.object(self.api, "load_json", return_value={"at": self.api.datetime.now().isoformat()}):
            result = self.api.health()
        self.assertTrue(result["ok"])
        self.assertFalse(result["default_model_available"])
        self.assertTrue(result["explicit_model_required"])

    def test_daemon_reports_available_default_model(self):
        with patch.object(self.api, "last_app_model", return_value={"model": "test-model"}), \
             patch.object(self.api, "extension_binary", return_value=Path(__file__)), \
             patch.object(self.api, "load_json", return_value={"at": self.api.datetime.now().isoformat()}):
            result = self.api.health()
        self.assertTrue(result["ok"])
        self.assertTrue(result["default_model_available"])
        self.assertFalse(result["explicit_model_required"])

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
                with closing(denied.exception):
                    self.assertEqual(denied.exception.code, 401)
                with urlopen(Request(endpoint, method="POST", headers={"Authorization": "Bearer test-secret"}), timeout=2) as response:
                    self.assertTrue(json.load(response)["stopping"])
                self.assertEqual(process.wait(timeout=15), 0)
                with self.assertRaises(OSError):
                    urlopen(f"http://127.0.0.1:{port}/health", timeout=1)
            finally:
                process.stdin.close()
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


class HttpPersistenceTests(unittest.TestCase):
    def test_authenticated_lifecycle_and_cold_restart(self):
        with TemporaryDirectory() as root:
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            env = {**os.environ, "OCTOCODE_ROOT": root,
                   "OCTOCODE_DAEMON_STATE": str(Path(root) / "state"),
                   "OCTOCODE_API_TOKEN": "isolated-test-token", "OCTOCODE_DESKTOP_PID": "0",
                   "OCTOCODE_DAEMON_PARENT_PIPE": "0"}
            process = None

            def request(path, method="GET", body=None, authorized=True):
                headers = {"Content-Type": "application/json"}
                if authorized:
                    headers["Authorization"] = "Bearer isolated-test-token"
                data = json.dumps(body).encode() if body is not None else None
                with urlopen(Request(f"http://127.0.0.1:{port}{path}", data=data,
                                     method=method, headers=headers), timeout=5) as response:
                    return json.load(response)

            def launch():
                child = subprocess.Popen([sys.executable, str(Path(__file__).with_name("octocode_api.py")),
                                          "--port", str(port)], env=env,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                for _ in range(100):
                    try:
                        request("/health")
                        return child
                    except OSError:
                        if child.poll() is not None:
                            self.fail("isolated daemon exited during startup")
                        time.sleep(.1)
                child.kill()
                child.wait(timeout=5)
                self.fail("isolated daemon startup timed out")

            try:
                process = launch()
                routes = request("/openapi.json")["paths"]
                for path, operations in routes.items():
                    if not path.startswith("/v1/"):
                        continue
                    concrete = path
                    for parameter in ("run_id", "routine_id", "goal_id"):
                        concrete = concrete.replace("{" + parameter + "}", "missing")
                    for method in operations:
                        with self.subTest(path=path, method=method):
                            with self.assertRaises(HTTPError) as denied:
                                request(concrete, method.upper(), authorized=False)
                            with closing(denied.exception):
                                self.assertEqual(denied.exception.code, 401)
                routine = request("/v1/routines", "POST", {
                    "name": "isolated", "prompt": "x", "cwd": root,
                    "every_minutes": 60, "enabled": False,
                    "model": {"api_key": "private-test-model-key"}})
                rid = routine["id"]
                self.assertNotIn("private-test-model-key", json.dumps(routine))
                self.assertNotIn("private-test-model-key", json.dumps(request("/v1/routines")))
                self.assertEqual(request("/v1/routines")[rid]["enabled"], False)
                created_goal = request("/v1/goals", "POST", {
                    "prompt": "isolated", "cwd": root, "check": "exit 0",
                    "model": {"api_key": "private-test-model-key"}})
                gid = created_goal["id"]
                self.assertNotIn("private-test-model-key", json.dumps(created_goal))
                for _ in range(50):
                    updated_goal = request(f"/v1/goals/{gid}")
                    if updated_goal["status"] != "running":
                        break
                    time.sleep(.1)
                self.assertEqual(updated_goal["status"], "failed")
                request(f"/v1/goals/{gid}/resume", "POST")
                for _ in range(50):
                    if request(f"/v1/goals/{gid}")["status"] != "running":
                        break
                    time.sleep(.1)
                self.assertEqual(request(f"/v1/goals/{gid}")["status"], "failed")
                # Seed only isolated state to verify recovery without launching an agent.
                state = Path(root) / "state"
                goal = {"id": "isolated", "status": "running", "iterations": [],
                        "model": {"api_key": "private-test-model-key"}}
                goals = json.loads((state / "goals.json").read_text(encoding="utf-8"))
                goals["isolated"] = goal
                (state / "goals.json").write_text(json.dumps(goals), encoding="utf-8")
                runs = state / "runs"
                runs.mkdir(exist_ok=True)
                (runs / "isolated.json").write_text(json.dumps({"run_id": "isolated", "status": "running"}), encoding="utf-8")
                request("/v1/daemon/shutdown", "POST")
                self.assertEqual(process.wait(timeout=15), 0)
                process = launch()
                self.assertIn(rid, request("/v1/routines"))
                self.assertEqual(request(f"/v1/goals/{gid}")["status"], "failed")
                self.assertEqual(request("/v1/goals/isolated")["status"], "interrupted")
                self.assertNotIn("private-test-model-key", json.dumps(request("/v1/goals")))
                self.assertNotIn("private-test-model-key", json.dumps(request("/v1/goals/isolated")))
                self.assertEqual(request("/v1/runs/isolated")["status"], "interrupted")
                request(f"/v1/routines/{rid}", "DELETE")
                self.assertNotIn(rid, request("/v1/routines"))
                with self.assertRaises(HTTPError) as missing:
                    request(f"/v1/routines/{rid}", "DELETE")
                with closing(missing.exception):
                    self.assertEqual(missing.exception.code, 404)
                request("/v1/daemon/shutdown", "POST")
                self.assertEqual(process.wait(timeout=15), 0)
                process = launch()
                self.assertNotIn(rid, request("/v1/routines"))
            finally:
                if process is not None and process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
