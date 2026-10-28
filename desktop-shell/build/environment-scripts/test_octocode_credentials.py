import base64
import json
import io
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import octocode_credentials as credentials


class CredentialsTests(unittest.TestCase):
    def fixture(self, root, profiles, *, selected="selected"):
        user = root / "data/user-data"
        (user / "User/globalStorage").mkdir(parents=True)
        (user / "Local State").write_text(json.dumps({"os_crypt": {"encrypted_key": base64.b64encode(b"DPAPIwrapped").decode()}}))
        nonce = b"test-nonce12"
        encrypted = b"v10" + nonce + AESGCM(b"k" * 32).encrypt(nonce, json.dumps({"apiConfigs": profiles}).encode(), None)
        with sqlite3.connect(user / "User/globalStorage/state.vscdb") as db:
            db.execute("CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT)")
            db.execute("INSERT INTO ItemTable VALUES (?,?)", ("OctoCode.octocode", json.dumps({"currentApiConfigName": selected})))
            db.execute("INSERT INTO ItemTable VALUES (?,?)", ('secret://{"extensionId":"octocode.octocode","key":"octocode_config_api_config"}', json.dumps({"data": list(encrypted)})))
        db.close()

    def test_only_selected_profile_is_decrypted_and_returned(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(credentials.sys, "platform", "win32"), patch.object(credentials, "_unprotect", return_value=b"k" * 32):
            root = Path(directory)
            self.fixture(root, {"selected": {"apiProvider": "openai", "openAiModelId": "chosen", "openAiBaseUrl": "http://localhost:1234/v1", "openAiApiKey": "fixture-key", "autoContextWindow": False, "modelContextWindow": 131072},
                                "other": {"openAiApiKey": "other-fixture-key"}})
            result = credentials.selected_model(root)
            self.assertEqual(result["model"], "chosen")
            self.assertEqual(result["api_key"], "fixture-key")
            self.assertEqual(set(result), {"model", "base_url", "api_key", "context_window", "provider"})

    def test_missing_or_malformed_selected_profile_never_falls_back_or_leaks(self):
        for selected in ("missing", "selected"):
            with self.subTest(selected=selected), tempfile.TemporaryDirectory() as directory, patch.object(credentials.sys, "platform", "win32"), patch.object(credentials, "_unprotect", return_value=b"k" * 32):
                root = Path(directory)
                self.fixture(root, {"selected": {"apiProvider": "openai", "openAiModelId": "chosen", "openAiBaseUrl": "http://localhost", "openAiApiKey": ["never-print-fixture-secret"]}}, selected=selected)
                with self.assertRaises(RuntimeError) as failure:
                    credentials.selected_model(root)
                self.assertNotIn("never-print-fixture-secret", str(failure.exception))
                self.assertIsNone(failure.exception.__cause__)

    def test_missing_encryption_key_and_non_windows_require_explicit_model(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(credentials.sys, "platform", "win32"), self.assertRaises(RuntimeError):
                credentials.selected_model(Path(directory))
            with patch.object(credentials.sys, "platform", "linux"), self.assertRaisesRegex(RuntimeError, "explicit model"):
                credentials.selected_model(Path(directory))

    def test_malformed_ciphertext_has_only_fixed_diagnostic(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(credentials.sys, "platform", "win32"), patch.object(credentials, "_unprotect", return_value=b"k" * 32):
            root = Path(directory)
            self.fixture(root, {})
            database = sqlite3.connect(root / "data/user-data/User/globalStorage/state.vscdb")
            try:
                database.execute("UPDATE ItemTable SET value=? WHERE key LIKE 'secret://%'", (json.dumps({"data": "never-print-ciphertext"}),))
                database.commit()
            finally:
                database.close()
            with self.assertRaises(RuntimeError) as failure:
                credentials.selected_model(root)
            self.assertNotIn("never-print", str(failure.exception))


class ContextTests(unittest.TestCase):
    def setUp(self):
        credentials._CONTEXT_CACHE.clear()
        self.profile = {"openAiBaseUrl": "http://localhost:1234/v1", "openAiModelId": "selected", "openAiApiKey": "fixture-key",
                        "openAiCustomModelInfo": {"contextWindow": 262144}}

    def response(self, length=1048576):
        return io.BufferedReader(io.BytesIO(json.dumps({"data": [{"id": "other", "max_model_len": 8192},
            {"id": "selected", "max_model_len": length}]}).encode()))

    def test_server_window_beats_manual_catalog_in_auto_mode_and_cache_tracks_profile(self):
        opener = Mock()
        opener.open.side_effect = lambda *args, **kwargs: self.response()
        with patch.object(credentials, "build_opener", return_value=opener):
            self.assertEqual(credentials.context_window(self.profile), 1048576)
            self.assertEqual(credentials.context_window(self.profile), 1048576)
            self.assertEqual(opener.open.call_count, 1)
            self.assertEqual(credentials.context_window({**self.profile, "openAiApiKey": "different-fixture-key"}), 1048576)
            self.assertEqual(opener.open.call_count, 2)
        self.assertLessEqual(opener.open.call_args.kwargs["timeout"], 5)

    def test_explicit_manual_context_requires_no_metadata_request(self):
        with patch.object(credentials, "build_opener", side_effect=AssertionError("must not fetch")):
            self.assertEqual(credentials.context_window({**self.profile, "autoContextWindow": False, "modelContextWindow": 1000000}), 1000000)
            self.assertEqual(credentials.context_window({**self.profile, "autoContextWindow": False}), 262144)

    def test_metadata_size_deadline_and_redirect_fail_without_silent_lower_context(self):
        self.assertIsNone(credentials._NoRedirect().redirect_request(None, None, 302, "", {}, "http://other.invalid"))
        opener = Mock()
        opener.open.return_value = io.BufferedReader(io.BytesIO(b"x" * (4 * 1024 * 1024 + 1)))
        with patch.object(credentials, "build_opener", return_value=opener), self.assertRaises(RuntimeError):
            credentials.context_window(self.profile)
        opener.open.return_value = self.response()
        with patch.object(credentials, "build_opener", return_value=opener), patch.object(credentials.time, "monotonic", side_effect=[0, 4.9, 5.1]), self.assertRaises(RuntimeError):
            credentials.context_window(self.profile)

    def test_context_field_contract_matches_native_discovery(self):
        for key in ("max_model_len", "context_length", "contextWindow", "max_context_length", "inputTokenLimit", "context_window"):
            self.assertEqual(credentials._model_context({key: 1048576}), 1048576)
        self.assertEqual(credentials._model_context({"model_info": {"x.context_length": 1048576}}), 1048576)
        self.assertIsNone(credentials._model_context({"max_model_len": True}))


if __name__ == "__main__":
    unittest.main()
