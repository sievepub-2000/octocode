import importlib.util
import io
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch


class ActivationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        spec = importlib.util.spec_from_file_location("activate_bounded", Path(__file__).with_name("activate-bounded-indexer-fix.py"))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.module.patch = root / "patch"
        self.module.patch.mkdir()
        self.module.runtime = root / "runtime"
        self.module.runtime.mkdir()
        for name in ("settings.json", "model_settings.json", "model_profiles.json"):
            (self.module.runtime / name).write_text('{"auth":{"api_key":"fixture"},"server":{"port":9999}}')
        self.module.agent = root / "agent.plist"
        self.original = plistlib.dumps({"ProgramArguments": [str(self.module.app / "Contents/MacOS/oMLX")]})
        self.module.agent.write_bytes(self.original)
        self.module.backup = self.module.patch / "before.plist"
        self.loaded, self.pid, self.backend = True, 101, True
        self.events = []
        self.fail_bootout = self.fail_stop = self.fail_bootstrap = False
        self.version = "0.7.3.dev1"

    def run_command(self, *args):
        if args[:2] == ("launchctl", "getenv"):
            return ""
        if args[:2] == ("launchctl", "bootout"):
            self.events.append("bootout")
            if self.fail_bootout:
                raise subprocess.CalledProcessError(5, args)
            self.loaded, self.pid = False, None
        elif args[:2] == ("launchctl", "bootstrap"):
            self.events.append(("bootstrap", self.module.agent.read_bytes()))
            if self.fail_bootstrap:
                self.fail_bootstrap = False
                raise subprocess.CalledProcessError(5, args)
            self.loaded, self.pid, self.backend = True, 102, True
        elif args[0].endswith("python-with-bounded-indexer"):
            return "20261025\n"
        return ""

    def control(self, command):
        self.events.append(command)
        self.backend = command == "start"
        if command == "stop" and self.fail_stop:
            self.fail_stop = False
            raise OSError("Control response dropped after stopping")
        return {"ok": True}

    def wait_exit(self, pid):
        self.assertFalse(self.loaded, "bootstrap must wait for the job to unload")
        self.events.append("exited")

    def wait_ready(self):
        self.assertTrue(self.loaded and self.backend)
        self.events.append("ready")

    def activate(self):
        module = self.module
        with patch.object(module.os, "getuid", return_value=501, create=True), \
             patch.object(module, "run", side_effect=self.run_command), \
             patch.object(module, "control", side_effect=self.control), \
             patch.object(module, "status", return_value={"version":self.version, "active_requests":0,"waiting_requests":0}), \
             patch.object(module, "job_state", side_effect=lambda: (self.loaded, self.pid)), \
             patch.object(module, "wait_gui_exit", side_effect=self.wait_exit), \
             patch.object(module, "wait_ready", side_effect=self.wait_ready), redirect_stdout(io.StringIO()):
            module.activate()

    def test_success_waits_for_exit_and_keeps_original_backup(self):
        self.activate()
        self.assertEqual(self.module.backup.read_bytes(), self.original)
        self.assertEqual(self.events[:3], ["stop", "bootout", "exited"])
        self.assertIn("OMLX_PYTHON_OVERRIDE", plistlib.loads(self.module.agent.read_bytes())["EnvironmentVariables"])

    def test_reviewed_dev2_activates_without_touching_configuration(self):
        self.version = "0.7.3.dev2"
        before = {p.name: p.read_bytes() for p in self.module.runtime.iterdir()}
        self.activate()
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.module.runtime.iterdir()})
        self.assertEqual(self.module.backup.read_bytes(), self.original)

    def test_stop_side_effect_then_response_failure_restarts_original_backend(self):
        self.fail_stop = True
        with self.assertRaises(OSError):
            self.activate()
        self.assertEqual(self.events, ["stop", "start", "ready"])
        self.assertEqual(self.module.agent.read_bytes(), self.original)
        self.assertTrue(self.backend)

    def test_bootout_failure_restarts_original_without_bootstrap_race(self):
        self.fail_bootout = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.activate()
        self.assertEqual(self.events, ["stop", "bootout", "start", "ready"])
        self.assertEqual(self.module.agent.read_bytes(), self.original)

    def test_bootstrap_failure_restores_original_then_bootstraps_once(self):
        self.fail_bootstrap = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.activate()
        boots = [event for event in self.events if isinstance(event, tuple)]
        self.assertEqual(len(boots), 2)
        self.assertIn("OMLX_PYTHON_OVERRIDE", plistlib.loads(boots[0][1])["EnvironmentVariables"])
        self.assertEqual(boots[-1][1], self.original)
        self.assertEqual(self.module.agent.read_bytes(), self.original)
        self.assertTrue(self.backend)

    def test_identical_backup_reused_but_mismatch_and_active_override_rejected(self):
        self.module.backup.write_bytes(self.original)
        self.activate()
        before = list(self.events)
        with self.assertRaises(AssertionError):
            self.activate()
        self.assertEqual(self.events, before)
        self.module.agent.write_bytes(self.original)
        self.module.backup.write_bytes(b"different prior activation")
        with self.assertRaisesRegex(RuntimeError, "Existing backup differs"):
            self.activate()
        self.assertEqual(self.events, before)

    def test_exit_wait_requires_both_unloaded_job_and_exited_process(self):
        module = self.module
        with patch.object(module.time, "monotonic", side_effect=[0, 0, 1, 2]), \
             patch.object(module.time, "sleep") as sleep, \
             patch.object(module, "job_state", side_effect=[(True,101),(False,None),(False,None)]), \
             patch.object(module, "process_alive", side_effect=[True, False]):
            module.wait_gui_exit(101)
        self.assertEqual(sleep.call_count, 2)
        with patch.object(module.time, "monotonic", side_effect=[0, 61]), self.assertRaisesRegex(RuntimeError, "refusing a racing bootstrap"):
            module.wait_gui_exit(101)


if __name__ == "__main__":
    unittest.main()
