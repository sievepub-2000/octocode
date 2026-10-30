"""Verify a local 2.0.6 candidate; no publication or formal-client acceptance claim."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

root = Path(__file__).resolve().parents[2]
product = root / 'VSCode-win32-x64'
app = product / 'resources/app'
metadata = json.loads((app / 'product.json').read_text(encoding='utf-8'))
assert metadata['version'] == '2.0.6'
assert json.loads((app / 'package.json').read_text(encoding='utf-8'))['version'] == '2.0.6'
assert metadata['commit'] == (root.parent / 'work/v206-source-commit.txt').read_text().strip()
main = (app / 'out/main.js').read_text(encoding='utf-8')
assert 'ensureOctoCodeWorkspace' in main and '__octoTrace' not in main
vsix = root / 'octocode-core/bin/octocode-0.1.18.vsix'
with zipfile.ZipFile(vsix) as archive:
    assert json.loads(archive.read('extension/package.json'))['version'] == '0.1.18'
with vsix.open('rb') as file:
    expected = hashlib.file_digest(file, 'sha256').hexdigest()
with (product / 'environments/installer/octocode.vsix').open('rb') as file:
    assert hashlib.file_digest(file, 'sha256').hexdigest() == expected
pwsh = product / 'environments/powershell/pwsh.exe'
assert subprocess.check_output([str(pwsh), '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], text=True).strip() == '7.6.9'
subprocess.run([str(product / 'environments/python/python.exe'), '-m', 'pip', 'check'], check=True)
print(json.dumps({'candidate': '2.0.6', 'extension': '0.1.18', 'source': metadata['commit'],
                  'vsixSha256': expected, 'powershell': '7.6.9', 'published': False,
                  'driveRootCreatorVerified': False}))
