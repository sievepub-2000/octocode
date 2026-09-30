"""Consistent current configuration snapshot and isolated restore verification."""
import datetime, hashlib, json, pathlib, shutil, sqlite3, subprocess, tempfile
from contextlib import closing

root = pathlib.Path(r'D:\gpt-workspace\octocode')
data = root / 'runtime/data/user-data'
target = root / 'backups/current-config'
target.mkdir(parents=True, exist_ok=True)
subprocess.run(['icacls', str(target), '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], check=True, capture_output=True)
files = ['Local State', 'User/settings.json', 'User/globalStorage/state.vscdb', 'User/globalStorage/octocode.octocode/octocode.db']
required = set(files)
files += [str(p.relative_to(data)) for p in (data / 'User/globalStorage/octocode.octocode/settings').rglob('*') if p.is_file()]
sources = [(name, data / name) for name in files]
tools = root / 'runtime/environments/tools'
sources += [('system-tools/' + str(p.relative_to(tools)), p) for p in [tools / 'mcp/mcp_settings.json'] if p.is_file()]
checks = []
for name, source in sources:
    dest = target / name
    if not source.is_file():
        if name in required:
            raise FileNotFoundError(source)
        continue
    dest.parent.mkdir(parents=True, exist_ok=True)
    if source.suffix in ('.vscdb', '.db'):
        with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as original, closing(sqlite3.connect(dest)) as copied:
            original.backup(copied)
            assert copied.execute('pragma integrity_check').fetchone()[0] == 'ok'
    else:
        shutil.copy2(source, dest)
    checks.append({'path': name, 'source': str(source), 'sha256': hashlib.sha256(dest.read_bytes()).hexdigest()})
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
report = {'checkedAt': datetime.datetime.now().astimezone().isoformat(), 'sqliteRestore': 'PASS', 'files': checks}
(target / 'manifest.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
(root / 'verification/release-20260921/config-restore.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps({'sqliteRestore': 'PASS', 'files': len(checks)}))
