"""Real DPAPI/AES-GCM and SQLite restore tests, confined to a new E: fixture."""
import base64
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import shutil
import sqlite3
import tempfile
import unittest

import win32crypt
import win32api
import win32con
import win32security
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

spec = importlib.util.spec_from_file_location('backup_current', pathlib.Path(__file__).with_name('backup-current.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        parent = pathlib.Path(r'E:\Program Files\octocode\test')
        parent.mkdir(parents=True, exist_ok=True)
        self.fixture = pathlib.Path(tempfile.mkdtemp(prefix='backup-current-', dir=parent))
        self.data = self.fixture / 'data/user-data'
        storage = self.data / 'User/globalStorage'
        (storage / 'octocode.octocode/settings').mkdir(parents=True)
        self.master = AESGCM.generate_key(bit_length=256)
        protected = win32crypt.CryptProtectData(self.master, None, None, None, None, 0)
        (self.data / 'Local State').write_text(json.dumps({'os_crypt': {'encrypted_key': base64.b64encode(b'DPAPI' + protected).decode()}}))
        (self.data / 'User/settings.json').write_text('{"fixture":true}')
        self.database = storage / 'state.vscdb'
        with contextlib.closing(sqlite3.connect(self.database)) as db:
            db.execute('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)')
            db.commit()
        with contextlib.closing(sqlite3.connect(storage / 'octocode.octocode/octocode.db')) as db:
            db.execute('CREATE TABLE sessions (id TEXT)')
            db.commit()

    def tearDown(self):
        shutil.rmtree(self.fixture)
        self.assertFalse(self.fixture.exists())

    def add_secret(self, name, value):
        nonce = os.urandom(12)
        blob = b'v10' + nonce + AESGCM(self.master).encrypt(nonce, value, None)
        with contextlib.closing(sqlite3.connect(self.database)) as db:
            db.execute('INSERT INTO ItemTable VALUES (?,?)', (name, json.dumps({'type': 'Buffer', 'data': list(blob)})))
            db.commit()

    def test_multiple_credentials_and_empty_storage(self):
        for count in (0, 2):
            if count:
                self.add_secret('secret://fixture/openAiApiKey', b'owned-openai-fixture')
                self.add_secret('secret://fixture/another-provider', b'owned-other-fixture')
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                report = backup.main(self.fixture)
            self.assertEqual(report['credentialRecords'], count)
            self.assertEqual(report['credentialRestore'], 'PASS' if count else 'NO_RECORDS')
            self.assertEqual(len(report['files']), 4)
            self.assertTrue((self.fixture / 'backups/reports/config-restore.json').is_file())
            token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
            try:
                sid = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
            finally:
                token.Close()
            allowed = {win32security.ConvertSidToStringSid(sid), 'S-1-5-18', 'S-1-5-32-544'}
            for directory in ('backups', 'backups/current-config', 'backups/reports'):
                security = win32security.GetNamedSecurityInfo(str(self.fixture / directory), win32security.SE_FILE_OBJECT, win32security.DACL_SECURITY_INFORMATION)
                self.assertTrue(security.GetSecurityDescriptorControl()[0] & win32security.SE_DACL_PROTECTED, directory)
                acl = security.GetSecurityDescriptorDacl()
                self.assertGreater(acl.GetAceCount(), 0)
                for index in range(acl.GetAceCount()):
                    self.assertIn(win32security.ConvertSidToStringSid(acl.GetAce(index)[2]), allowed)
            self.assertNotIn('owned-', output.getvalue())
            self.assertNotIn('openAiApiKey', output.getvalue())
            serialized = json.dumps(report)
            self.assertNotIn('owned-', serialized)
            self.assertNotIn('secret://', serialized)

    def test_corrupt_credential_fails_without_secret_diagnostics(self):
        self.add_secret('secret://fixture/sensitive-name', b'owned-private-value')
        with contextlib.closing(sqlite3.connect(self.database)) as db:
            db.execute('UPDATE ItemTable SET value=?', (json.dumps({'data': [118, 49, 48]}),))
            db.commit()
        with self.assertRaisesRegex(ValueError, '^Encrypted credential verification failed$'):
            backup.main(self.fixture)
        self.assertFalse((self.fixture / 'backups/current-config').exists())

    def test_missing_required_database_fails(self):
        self.database.unlink()
        with self.assertRaises(FileNotFoundError):
            backup.main(self.fixture)
        self.assertFalse((self.fixture / 'backups/current-config').exists())

    def test_data_junction_escape_is_rejected(self):
        shutil.rmtree(self.fixture / 'data')
        import subprocess
        # A target outside the installation (its sibling) must not be read.
        escaped = self.fixture.parent / (self.fixture.name + '-outside')
        escaped.mkdir()
        try:
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(self.fixture / 'data'), str(escaped)], check=True, capture_output=True)
            with self.assertRaisesRegex(ValueError, 'outside the installation root'):
                backup.main(self.fixture)
        finally:
            (self.fixture / 'data').rmdir()
            escaped.rmdir()

    def test_report_junction_escape_is_rejected_without_touching_target(self):
        import subprocess
        parent = self.fixture / 'backups'
        parent.mkdir()
        escaped = self.fixture / 'unrelated'
        escaped.mkdir()
        descriptor = win32security.GetNamedSecurityInfo(str(escaped), win32security.SE_FILE_OBJECT, win32security.DACL_SECURITY_INFORMATION)
        before = win32security.ConvertSecurityDescriptorToStringSecurityDescriptor(descriptor, 1, win32security.DACL_SECURITY_INFORMATION)
        link = parent / 'reports'
        try:
            subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(escaped)], check=True, capture_output=True)
            with self.assertRaisesRegex(ValueError, 'report directory resolves outside'):
                backup.main(self.fixture)
            after = win32security.GetNamedSecurityInfo(str(escaped), win32security.SE_FILE_OBJECT, win32security.DACL_SECURITY_INFORMATION)
            self.assertEqual(before, win32security.ConvertSecurityDescriptorToStringSecurityDescriptor(after, 1, win32security.DACL_SECURITY_INFORMATION))
            self.assertEqual(list(escaped.iterdir()), [])
        finally:
            link.rmdir()


if __name__ == '__main__':
    unittest.main()
