"""Consistent current configuration snapshot and isolated restore verification."""
import base64, datetime, hashlib, json, pathlib, shutil, sqlite3, subprocess, tempfile
import win32crypt
from contextlib import closing
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

root = pathlib.Path(r'D:\gpt-workspace\octocode')
data = root / 'runtime/data/user-data'
target = root / 'backups/current-config'
target.mkdir(parents=True, exist_ok=True)
subprocess.run(['icacls', str(target), '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], check=True, capture_output=True)
files = ['Local State', 'User/settings.json', 'User/globalStorage/state.vscdb', 'User/globalStorage/octocode.octocode/octocode.db']
files += [str(p.relative_to(data)) for p in (data / 'User/globalStorage/octocode.octocode/settings').rglob('*') if p.is_file()]
checks = []
for name in files:
    source, dest = data / name, target / name
    if not source.is_file():
        continue
    dest.parent.mkdir(parents=True, exist_ok=True)
    if source.suffix in ('.vscdb', '.db'):
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as original, closing(sqlite3.connect(dest)) as copied:
            original.backup(copied)
            assert copied.execute('pragma integrity_check').fetchone()[0] == 'ok'
    else:
        shutil.copy2(source, dest)
    checks.append({'path': name, 'sha256': hashlib.sha256(dest.read_bytes()).hexdigest()})
with tempfile.TemporaryDirectory(prefix='restore-check-', dir=target) as temporary:
    restored = pathlib.Path(temporary)
    for item in checks:
        dest = restored / item['path']
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(target / item['path'], dest)
        assert hashlib.sha256(dest.read_bytes()).hexdigest() == item['sha256']
        if dest.suffix in ('.vscdb', '.db'):
            with closing(sqlite3.connect(dest)) as db:
                assert db.execute('pragma integrity_check').fetchone()[0] == 'ok'
    state = json.loads((restored / 'Local State').read_text(encoding='utf-8'))
    master = win32crypt.CryptUnprotectData(base64.b64decode(state['os_crypt']['encrypted_key'])[5:], None, None, None, 0)[1]
    with closing(sqlite3.connect(restored / 'User/globalStorage/state.vscdb')) as db:
        rows = db.execute("select value from ItemTable where key like '%secret://%openAiApiKey%'").fetchall()
    assert len(rows) == 1
    blob = bytes(json.loads(rows[0][0])['data'])
    key = AESGCM(master).decrypt(blob[3:15], blob[15:], None).decode()
    plaintext = root / 'runtime/workspace/omlx_new_api_key.txt'
    if plaintext.exists():
        assert plaintext.read_text().strip() == key, 'Unexpected plaintext credential; investigate without deleting'
report = {'checkedAt': datetime.datetime.now().astimezone().isoformat(), 'sqliteRestore': 'PASS', 'credentialRestore': 'PASS', 'files': checks}
(target / 'manifest.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
(root / 'verification/release-20260921/config-restore.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({'sqliteRestore': 'PASS', 'credentialRestore': 'PASS', 'files': len(checks)}))
