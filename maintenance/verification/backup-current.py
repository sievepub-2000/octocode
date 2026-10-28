"""Consistent current configuration snapshot and isolated restore verification."""
if not __debug__:
    raise RuntimeError('This verification requires Python assertions; do not use -O/-OO or PYTHONOPTIMIZE')

import base64, datetime, hashlib, hmac, json, pathlib, shutil, sqlite3, tempfile
import win32crypt
import win32api
import win32con
import win32security
import ntsecuritycon
from contextlib import closing
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def publish_snapshot(generation, target):
    parent = target.parent.resolve()
    if generation.resolve().parent != parent or target.resolve().parent != parent:
        raise ValueError('Snapshot publication must stay inside the backup directory')
    # Retain the prior verified directory; publication failure restores its name.
    previous = target.with_name('current-config-previous-' + generation.name)
    if previous.exists():
        raise FileExistsError(previous)
    had_previous = target.exists()
    if had_previous:
        target.rename(previous)
    try:
        generation.rename(target)
    except BaseException:
        if had_previous:
            previous.rename(target)
        raise


def restrict_directory(directory):
    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32con.TOKEN_QUERY)
    try:
        current_user = win32security.GetTokenInformation(token, win32security.TokenUser)[0]
    finally:
        token.Close()
    acl = win32security.ACL()
    for sid in (current_user, win32security.ConvertStringSidToSid('S-1-5-18'), win32security.ConvertStringSidToSid('S-1-5-32-544')):
        acl.AddAccessAllowedAceEx(win32security.ACL_REVISION, win32con.OBJECT_INHERIT_ACE | win32con.CONTAINER_INHERIT_ACE, ntsecuritycon.FILE_ALL_ACCESS, sid)
    # Only replace the DACL: owner, audit rules and integrity labels are preserved.
    win32security.SetNamedSecurityInfo(str(directory), win32security.SE_FILE_OBJECT,
                                      win32security.DACL_SECURITY_INFORMATION | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
                                      None, None, acl, None)


def credential_records(directory):
    try:
        state = json.loads((directory / 'Local State').read_text(encoding='utf-8'))
        protected = base64.b64decode(state['os_crypt']['encrypted_key'], validate=True)
        if not protected.startswith(b'DPAPI'):
            raise ValueError('Unsupported master key format')
        master = win32crypt.CryptUnprotectData(protected[5:], None, None, None, 0)[1]
        records = {}
        database = directory / 'User/globalStorage/state.vscdb'
        with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as db:
            for name, value in db.execute("select key, value from ItemTable where key like '%secret://%'"):
                blob = bytes(json.loads(value)['data'])
                if blob[:3] not in (b'v10', b'v11'):
                    raise ValueError('Unsupported credential format')
                records[name] = AESGCM(master).decrypt(blob[3:15], blob[15:], None)
        return records
    except Exception:
        # Never include credential keys, values or decryption diagnostics in reports.
        raise ValueError('Encrypted credential verification failed') from None


def verify_credentials(snapshot, restored):
    before, after = credential_records(snapshot), credential_records(restored)
    if before.keys() != after.keys() or any(not hmac.compare_digest(value, after[name]) for name, value in before.items()):
        raise ValueError('Credential restore mismatch')
    return len(before)


def main(root=pathlib.Path(r'E:\Program Files\octocode')):
    root = root.resolve()
    data = (root / 'data/user-data').resolve()
    if root not in data.parents:
        raise ValueError('Data directory resolves outside the installation root')
    target = root / 'backups/current-config'
    if root not in target.parent.resolve().parents or target.resolve().parent != target.parent.resolve():
        raise ValueError('Backup directory resolves outside the installation root')
    target.parent.mkdir(parents=True, exist_ok=True)
    restrict_directory(target.parent)
    with tempfile.TemporaryDirectory(prefix='current-config-generation-', dir=target.parent) as temporary:
        generation = pathlib.Path(temporary)
        restrict_directory(generation)
        files = ['Local State', 'User/settings.json', 'User/globalStorage/state.vscdb', 'User/globalStorage/octocode.octocode/octocode.db']
        files += [str(p.relative_to(data)) for p in (data / 'User/globalStorage/octocode.octocode/settings').rglob('*') if p.is_file()]
        checks = []
        for name in files:
            source, dest = data / name, generation / name
            if not source.is_file():
                raise FileNotFoundError(source)
            if data not in source.resolve().parents:
                raise ValueError('Configuration file resolves outside the data directory')
            dest.parent.mkdir(parents=True, exist_ok=True)
            if source.suffix in ('.vscdb', '.db'):
                with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as original, closing(sqlite3.connect(dest)) as copied:
                    original.backup(copied)
                    assert copied.execute('pragma integrity_check').fetchone()[0] == 'ok'
            else:
                shutil.copy2(source, dest)
            checks.append({'path': name, 'sha256': hashlib.sha256(dest.read_bytes()).hexdigest()})
        with tempfile.TemporaryDirectory(prefix='restore-check-', dir=generation) as restored_directory:
            restored = pathlib.Path(restored_directory)
            for item in checks:
                dest = restored / item['path']
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(generation / item['path'], dest)
                assert hashlib.sha256(dest.read_bytes()).hexdigest() == item['sha256']
                if dest.suffix in ('.vscdb', '.db'):
                    with closing(sqlite3.connect(dest)) as db:
                        assert db.execute('pragma integrity_check').fetchone()[0] == 'ok'
            credential_count = verify_credentials(generation, restored)
        report = {'checkedAt': datetime.datetime.now().astimezone().isoformat(), 'sqliteRestore': 'PASS',
                  'credentialRestore': 'PASS' if credential_count else 'NO_RECORDS', 'credentialRecords': credential_count, 'files': checks}
        (generation / 'manifest.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        publish_snapshot(generation, target)
    reports = target.parent / 'reports'
    if reports.resolve().parent != target.parent.resolve():
        raise ValueError('Backup report directory resolves outside the backup directory')
    reports.mkdir(exist_ok=True)
    restrict_directory(reports)
    (reports / 'config-restore.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps({'sqliteRestore': 'PASS', 'credentialRestore': report['credentialRestore'], 'credentialRecords': credential_count, 'files': len(checks)}))
    return report


if __name__ == '__main__':
    main()
