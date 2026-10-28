import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import hashlib

from cryptography.exceptions import InvalidSignature
from sign_release import artifact, create_only, dpapi, file_snapshot, plain_directory, private_key, public_anchor, public_source_file, version


class SigningTests(unittest.TestCase):
    def test_dpapi_roundtrip_and_test_key_signature_tamper(self):
        # A disposable identity signs a non-release probe; never use the formal key.
        with tempfile.TemporaryDirectory(prefix="octocode-signing-test-") as temporary:
            directory = Path(temporary) / "identity"
            key = private_key(directory, initialize=True)
            file = directory / "ed25519-private.dpapi"
            encrypted = file.read_bytes()
            self.assertEqual(len(dpapi(encrypted, decrypt=True)), 32)
            restored = private_key(directory, initialize=True)
            self.assertEqual(public_anchor(restored), public_anchor(key))
            self.assertEqual(file.read_bytes(), encrypted)
            message = b"OctoCode disposable signing self-test; not a release manifest"
            signature = key.sign(message)
            restored.public_key().verify(signature, message)
            with self.assertRaises(InvalidSignature):
                restored.public_key().verify(signature, message + b"tampered")
            with self.assertRaises(ValueError):
                create_only(file, b"replacement")

    def test_versions_and_artifact_bytes(self):
        self.assertEqual(version("v2.0"), "2.0.0")
        self.assertEqual(version("2.0.0"), "2.0.0")
        for bad in ["v02.0", "2.00", "v2.0-rc1", " 2.0", "2.0\n"]:
            with self.assertRaises(ValueError):
                version(bad)
        with tempfile.TemporaryDirectory(prefix="octocode-artifact-test-") as temporary:
            path = Path(temporary) / "probe.txt"
            path.write_bytes(b"real bytes")
            self.assertEqual(artifact(path)["size"], 10)
            public_file = Path(temporary) / "public.ts"
            public_file.write_bytes(b"export const PUBLIC = 'public';\r\n")
            public_source_file(public_file, b"export const PUBLIC = 'public';\n")
            self.assertTrue(public_file.read_bytes().endswith(b"\r\n"))
            public_file.write_bytes(b'/* formatted */\nexport const PUBLIC_SHA256 = "public"\n')
            public_source_file(public_file, b"export const PUBLIC_SHA256 = 'public';\n")
            self.assertIn(b'"public"', public_file.read_bytes())
            with self.assertRaisesRegex(ValueError, "does not match"):
                public_source_file(public_file, b"export const PUBLIC = 'different';\n")
            public_file.write_bytes(b"export const PUBLIC = 'public'; dangerous();")
            with self.assertRaisesRegex(ValueError, "Unexpected"):
                public_source_file(public_file, b"export const PUBLIC = 'public';\n")

    def test_changed_artifact_and_non_directory_output_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="octocode-changing-artifact-") as temporary:
            path = Path(temporary) / "changing.bin"
            path.write_bytes(b"original")
            previous = file_snapshot(path)
            path.write_bytes(b"changed before hash")
            with self.assertRaisesRegex(ValueError, "changed"):
                artifact(path, previous)
            actual_hash = hashlib.sha256()

            class ChangingHash:
                def update(self, value):
                    actual_hash.update(value)
                    path.write_bytes(b"changed during hash to a different size")

                def hexdigest(self):
                    return actual_hash.hexdigest()

            with patch("sign_release.hashlib.sha256", return_value=ChangingHash()):
                with self.assertRaisesRegex(ValueError, "changed"):
                    artifact(path)
            with self.assertRaisesRegex(ValueError, "ordinary directory"):
                plain_directory(path)


if __name__ == "__main__":
    unittest.main()
