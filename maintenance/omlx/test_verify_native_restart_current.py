import importlib.util
import io
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location("restart_current", Path(__file__).with_name("verify-native-restart-current.py"))
restart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restart)


class RestartTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        runtime, directory = self.root / "runtime", self.root / "patch"
        runtime.mkdir()
        directory.mkdir()
        (runtime / "settings.json").write_text('{"auth":{"api_key":"fixture"},"server":{"port":9999}}')
        for name in ("model_settings.json", "model_profiles.json"):
            (runtime / name).write_text('{"mtp_enabled":false,"context_window":1048576}')
        (directory / "manifest.json").write_text('{"memory_monitor.py":{},"language.py":{}}')
        for name in ("sitecustomize.py", "memory_monitor.py", "language.py", "python-with-bounded-indexer"):
            (directory / name).write_text("fixture")
        app, agent = self.root / "oMLX.app", self.root / "agent.plist"
        agent.write_bytes(plistlib.dumps({"ProgramArguments":[str(app / "Contents/MacOS/oMLX")],
            "EnvironmentVariables":{"OMLX_PYTHON_OVERRIDE":str(directory / "python-with-bounded-indexer")}}))
        self.loaded, self.pid, self.backend, self.busy = True, 101, True, False
        self.version = "0.7.3.dev1"
        self.events = []
        self.fail_stop = self.fail_bootout = self.fail_bootstrap = False
        self.on_ready = None
        self.service = SimpleNamespace(runtime=runtime, patch=directory, app=app, agent=agent, label="fixture",
            run=self.run_command, status=self.status, control=self.control, job_state=lambda:(self.loaded,self.pid),
            process_alive=lambda pid:self.loaded and self.pid == pid, wait_gui_exit=self.wait_exit, wait_ready=self.wait_ready)
        self.before = {path:path.read_bytes() for path in self.root.rglob('*') if path.is_file()}

    def run_command(self, *args):
        if args[:2] == ("launchctl", "getenv"):
            return ""
        if args[:2] == ("launchctl", "bootout"):
            self.events.append("bootout")
            if self.fail_bootout:
                raise subprocess.CalledProcessError(5, args)
            self.loaded, self.pid = False, None
        elif args[:2] == ("launchctl", "bootstrap"):
            self.events.append("bootstrap")
            if self.fail_bootstrap:
                self.fail_bootstrap = False
                raise subprocess.CalledProcessError(5, args)
            self.loaded, self.pid, self.backend = True, 102, True
        elif args[0].endswith("python-with-bounded-indexer"):
            return "20261025\n"
        return ""

    def status(self):
        return {"version":self.version, "active_requests":int(self.busy), "waiting_requests":0, "loaded_models":["glm53"]}

    def control(self, command):
        self.events.append(command)
        self.backend = command == "start"
        if command == "stop" and self.fail_stop:
            raise OSError("stop applied but response lost")

    def wait_exit(self, pid):
        self.assertFalse(self.loaded)
        self.events.append("GUI-exited")

    def wait_ready(self):
        self.assertTrue(self.loaded and self.backend)
        self.events.append("ready")
        if self.on_ready:
            self.on_ready()

    def verify(self):
        with patch.object(restart.os, "getuid", return_value=501, create=True), \
             patch.object(restart, "wait_backend_down", side_effect=lambda port:self.events.append("backend-down")), \
             patch.object(restart, "healthy", side_effect=lambda service:self.assertTrue(self.backend)), redirect_stdout(io.StringIO()):
            return restart.verify_restart(self.service)

    def unchanged(self):
        self.assertEqual({path:path.read_bytes() for path in self.before}, self.before)

    def test_full_restart_preserves_current_override_and_mtp_baseline(self):
        result = self.verify()
        self.assertEqual(self.events, ["stop","backend-down","bootout","GUI-exited","bootstrap","ready"])
        self.assertEqual(result["new_gui_pid"], 102)
        self.assertEqual(result["inference_after_restart"], "pending")
        self.unchanged()

    def test_busy_service_is_not_stopped(self):
        self.busy = True
        with self.assertRaisesRegex(RuntimeError, "idle"):
            self.verify()
        self.assertEqual(self.events, [])
        self.unchanged()

    def test_current_dev2_is_preserved_across_restart(self):
        self.version = "0.7.3.dev2"
        self.assertEqual(self.verify()["version"], self.version)
        self.unchanged()

    def test_unreviewed_version_is_not_stopped(self):
        self.version = "0.7.4.dev1"
        with self.assertRaisesRegex(RuntimeError, "pinned"):
            self.verify()
        self.assertEqual(self.events, [])

    def test_stop_or_bootout_failure_restores_same_native_service(self):
        for failure in ("fail_stop", "fail_bootout"):
            with self.subTest(failure=failure):
                self.events.clear()
                self.fail_stop = self.fail_bootout = False
                setattr(self, failure, True)
                with self.assertRaises((OSError, subprocess.CalledProcessError)):
                    self.verify()
                self.assertEqual(self.events[-2:], ["start","ready"])
                self.assertNotIn("bootstrap", self.events)
                self.assertTrue(self.backend)
                self.unchanged()

    def test_bootstrap_failure_recovers_same_agent_without_writes(self):
        self.fail_bootstrap = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.verify()
        self.assertEqual(self.events.count("bootstrap"), 2)
        self.assertTrue(self.backend)
        self.unchanged()

    def test_concurrent_setting_change_is_detected_and_never_overwritten(self):
        path = self.service.runtime / "model_settings.json"
        changed = b'{"mtp_enabled":true}'
        self.on_ready = lambda:path.write_bytes(changed)
        with self.assertRaisesRegex(RuntimeError, "changed during restart"):
            self.verify()
        self.assertEqual(path.read_bytes(), changed)
        self.assertTrue(self.backend)
        self.assertNotIn("start", self.events)

    def test_backend_exit_wait_requires_connection_refusal(self):
        connection = Mock()
        connection.__enter__ = Mock(return_value=connection)
        connection.__exit__ = Mock(return_value=False)
        with patch.object(restart.time, "monotonic", side_effect=[0,0,1]), patch.object(restart.time, "sleep"), \
             patch.object(restart.socket, "create_connection", side_effect=[connection,ConnectionRefusedError()]):
            restart.wait_backend_down(9999)
        with patch.object(restart.time, "monotonic", side_effect=[0,0,61]), patch.object(restart.time, "sleep"), \
             patch.object(restart.socket, "create_connection", side_effect=TimeoutError()), self.assertRaisesRegex(RuntimeError, "did not close"):
            restart.wait_backend_down(9999)

    def test_reused_native_control_keeps_sixty_second_socket_timeout(self):
        connection = Mock()
        connection.recv.return_value = b'{"ok":true}\n'
        context = Mock()
        context.__enter__ = Mock(return_value=connection)
        context.__exit__ = Mock(return_value=False)
        with patch.object(restart.native.socket, "AF_UNIX", 1, create=True), patch.object(restart.native.socket, "socket", return_value=context):
            restart.native.control("stop")
        connection.settimeout.assert_called_once_with(60)


if __name__ == "__main__":
    unittest.main()
