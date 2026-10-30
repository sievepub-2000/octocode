"""Validate final 2.0.7 build inputs without claiming installed acceptance."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

root = Path(__file__).resolve().parents[2]
product = root / 'VSCode-win32-x64'
app = product / 'resources/app'
metadata = json.loads((app / 'product.json').read_text(encoding='utf-8'))
assert metadata['version'] == '2.0.7'
assert json.loads((app / 'package.json').read_text(encoding='utf-8'))['version'] == '2.0.7'
assert metadata['commit'] == (root.parent / 'work/v207-source-commit.txt').read_text().strip()
main = (app / 'out/main.js').read_text(encoding='utf-8')
assert 'ensureOctoCodeWorkspace' in main and '__octoTrace' not in main
vsix = root / 'octocode-core/bin/octocode-0.1.19.vsix'
with zipfile.ZipFile(vsix) as archive:
    assert json.loads(archive.read('extension/package.json'))['version'] == '0.1.19'
    scripts = '\n'.join(archive.read(name).decode('utf-8') for name in archive.namelist()
                        if name.startswith('extension/webview-ui/build/assets/') and name.endswith(('.js','.mjs')))
    assert '第三方作品及既有许可继续保留。个人非商业学习' in scripts
    assert '"此项目由 zillafan80@gmail.com 独立完成。"' not in scripts
    assert 'gap-2 leading-snug' in scripts
with vsix.open('rb') as file:
    expected = hashlib.file_digest(file, 'sha256').hexdigest()
with (product / 'environments/installer/octocode.vsix').open('rb') as file:
    assert hashlib.file_digest(file, 'sha256').hexdigest() == expected
pwsh = product / 'environments/powershell/pwsh.exe'
assert subprocess.check_output([str(pwsh), '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], text=True).strip() == '7.6.9'
subprocess.run([str(product / 'environments/python/python.exe'), '-m', 'pip', 'check'], check=True)
print(json.dumps({'version':'2.0.7','extension':'0.1.19','source':metadata['commit'],
                  'vsixSha256':expected,'aboutContent':'PASS','powershell':'7.6.9'}))
