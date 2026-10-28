import json
import io
import os
from pathlib import Path
import tempfile
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import octocode_harness2 as h


class LocalModel:
    def __init__(self):
        self.calls = []

    def run(self, prompt, cwd):
        self.calls.append((prompt, cwd))
        text = json.dumps({"AGENTS.md": "Read evidence carefully and verify the answer.\n"}) if "First output one JSON object" in prompt else "Verified answer."
        return {"run_id": str(len(self.calls)), "status": "completed", "text": text}


class Harness2Tests(unittest.TestCase):
    def test_import_does_not_load_project_dotenv(self):
        with tempfile.TemporaryDirectory() as directory:
            key = "HARNESS2_PROJECT_DOTENV_TEST_SENTINEL"
            (Path(directory) / ".env").write_text(f"{key}=must-not-load\n", encoding="utf-8")
            environment = dict(os.environ)
            environment.pop(key, None)
            script = f"import sys,os; sys.path.insert(0,{str(Path(h.__file__).parent)!r}); import octocode_harness2; assert {key!r} not in os.environ"
            result = subprocess.run([sys.executable, "-c", script], cwd=directory, env=environment, capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))

    def test_real_upstream_recursion_both_modes(self):
        for mode in ("seq", "agg"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                client = LocalModel()
                result = h.run(client, Path(directory), "Explain the project", mode=mode)
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["answer"], "Verified answer.")
                self.assertEqual(len(client.calls), 7)
                self.assertEqual(len(result["stages"]), 3)
                self.assertTrue((Path(result["output_dir"]) / "result.json").is_file())
                self.assertFalse((Path(directory) / "AGENTS.md").exists())
                proposals = [prompt for prompt, _ in client.calls if "First output one JSON object" in prompt]
                self.assertTrue(all("YOURS TO EDIT" not in prompt and "nothing you write in this reply changes" not in prompt for prompt in proposals))
                self.assertTrue(all("one <notes>...</notes> block" in prompt and "No prose before the JSON" in prompt for prompt in proposals))

    def test_native_request_preserves_permissions_and_fresh_sessions(self):
        client = h.Client("http://127.0.0.1:8765")
        with patch.object(client, "request", side_effect=[{"run_id": "test", "status": "completed", "text": "answer"}, {"events": []}]) as request:
            client.run("task", Path.cwd())
        payload = request.call_args_list[0].args[1]
        self.assertEqual(payload["permission_mode"], "directory")
        self.assertNotIn("session_id", payload)
        self.assertNotIn("model", payload)

    def test_external_endpoint_and_executable_proposals_rejected(self):
        with self.assertRaises(ValueError):
            h.Client("http://example.com:8765")
        for proposal in ({"../AGENTS.md": "escape"}, {"AGENTS.md": "ok", "scripts/a.py": "danger"}, {"AGENTS.md": []}):
            with self.subTest(proposal=proposal), self.assertRaises(ValueError):
                h.validate_prompt(proposal)

    def test_proposer_failure_is_reported_as_failure(self):
        class InvalidModel(LocalModel):
            def run(self, prompt, cwd):
                return {"text": "not JSON"}
        with tempfile.TemporaryDirectory() as directory:
            result = h.run(InvalidModel(), Path(directory), "Explain project")
            self.assertFalse(result["ok"])
            self.assertTrue(result["fell_back"])
            self.assertTrue(all(stage["attempts"] == 2 for stage in result["stages"]))

    def test_timeout_cancels_native_run(self):
        client = h.Client("http://localhost:8765", timeout=-1)
        with patch.object(client, "request", side_effect=[{"run_id": "test", "status": "running"}, {}]) as request:
            with self.assertRaises(TimeoutError):
                client.run("task", Path.cwd())
        self.assertEqual(request.call_args.args, ("/v1/runs/test/cancel", {}))

    def test_sse_and_real_tool_observations_reach_recursion_evidence(self):
        client = h.Client("http://localhost:8765")
        event = {"type": "tool_call", "toolName": "read_file", "rawInput": {"target_file": "evidence.txt"}}
        with patch.object(h, "urlopen", return_value=io.BytesIO(("data: " + json.dumps(event) + "\n\n").encode())):
            self.assertEqual(client.request("/v1/runs/test/events")["events"], [event])
        with tempfile.TemporaryDirectory() as directory:
            model = LocalModel()
            model.run = lambda prompt, cwd: {"text": "answer", "events": [event, {"type": "thought", "data": "not evidence"}]}
            adapter = h.Adapter(model, Path(directory), "task", Path(directory))
            folder = adapter.execute("task", None, "run")
            evidence = adapter.trajectory(folder, obs_trunc=50000)
            self.assertIn("[ACTION]", evidence)
            self.assertIn("evidence.txt", evidence)
            self.assertNotIn("not evidence", evidence)

    def test_proposal_accepts_official_notes_but_rejects_other_trailing_text(self):
        proposal = json.dumps({"AGENTS.md": "Read the project evidence and verify the answer."})
        for tail, accepted in (("", True), ("\n<notes>Keep the supported process.</notes>", True),
                               ("\ntrailing garbage", False), ("\n<notes>one</notes><notes>two</notes>", False)):
            with self.subTest(tail=tail), tempfile.TemporaryDirectory() as directory:
                client = SimpleNamespace(run=lambda prompt, cwd: {"text": proposal + tail})
                reply = h.Proposer(client).call("mission", Path(directory), "test")
                self.assertEqual(reply.workspace is not None, accepted)
                if accepted and tail:
                    self.assertIn("<notes>", reply.text)

    def test_fenced_proposals_reject_every_unparsed_tail(self):
        proposal = json.dumps({"AGENTS.md": "Read evidence and verify the answer."})
        for text, accepted in ((f"```json\n{proposal}\n```", True),
                               (f"```json\n{proposal}\n<notes>Keep it grounded.</notes>\n```", True),
                               (f"```json\n{proposal}\n```trailing garbage", False),
                               (f"```json\n{proposal}\n```trailing garbage```", False), ("```", False)):
            with self.subTest(accepted=accepted), tempfile.TemporaryDirectory() as directory:
                client = SimpleNamespace(run=lambda prompt, cwd: {"text": text})
                reply = h.Proposer(client).call("mission", Path(directory), "test")
                self.assertEqual(reply.workspace is not None, accepted)

    def test_adopted_guidance_persists_only_in_same_project(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            result = h.run(LocalModel(), Path(first), "Explain project", adopt=True)
            self.assertTrue(result["adopted"])
            client = LocalModel()
            h.run(client, Path(first), "Explain again")
            self.assertIn("Read evidence carefully", client.calls[0][0])
            other = LocalModel()
            h.run(other, Path(second), "Explain other")
            self.assertNotIn("Read evidence carefully", other.calls[0][0])


if __name__ == "__main__":
    unittest.main()
