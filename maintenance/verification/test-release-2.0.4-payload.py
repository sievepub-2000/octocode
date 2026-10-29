"""Read actual staged 2.0.4 artifacts; never modify a formal installation."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

root = Path(__file__).resolve().parents[2]
product = root / 'VSCode-win32-x64'
app = product / 'resources/app'
assert json.loads((app / 'package.json').read_text())['version'] == '2.0.4'
assert (app / 'LICENSE.txt').read_bytes() == (root / 'desktop-shell/LICENSE.txt').read_bytes()
assert (app / 'OCTOCODE-LICENSE.txt').read_bytes() == (root / 'desktop-shell/OCTOCODE-LICENSE.txt').read_bytes()
assert json.loads((app / 'product.json').read_text())['licenseFileName'] == 'OCTOCODE-LICENSE.txt'
vsix = root / 'octocode-core/bin/octocode-0.1.16.vsix'
with zipfile.ZipFile(vsix) as archive:
    assert json.loads(archive.read('extension/package.json'))['version'] == '0.1.16'
    for source, bundled in [('LICENSE', 'LICENSE.txt'), ('LICENSE-COMMERCIAL.md', 'LICENSE-COMMERCIAL.md'),
                            ('THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'), ('octocode-core/LICENSE', 'LICENSE-UPSTREAM')]:
        assert archive.read('extension/' + bundled).decode('utf-8-sig').replace('\r\n', '\n') == (root / source).read_text(encoding='utf-8-sig')
    assets = '\n'.join(archive.read(name).decode('utf-8') for name in archive.namelist()
                       if name.startswith('extension/webview-ui/build/assets/') and name.endswith('.mjs'))
    for text in ['作者与授权', 'LicenseRef-OctoCode-Personal', '2022 C.J. May', '13. 授权与合作',
                 'zillafan80@gmail.com', '479729980@qq.com', '2015 - present Microsoft Corporation']:
        assert text in assets, text
    assert archive.read('extension/readme.md').decode('utf-8').find('2.0.4') >= 0
staged = product / 'environments/installer/octocode.vsix'
assert hashlib.sha256(staged.read_bytes()).digest() == hashlib.sha256(vsix.read_bytes()).digest()
python = product / 'environments/python/python.exe'
result = subprocess.check_output([str(python), '-c', 'import tornado; print(tornado.version)'], text=True)
assert result.strip() == '6.6'
subprocess.run([str(python), '-m', 'pip', 'check'], check=True)
wiki = product / 'environments/tools/mcp/llmwiki'
assert json.loads((wiki / 'node_modules/@hono/node-server/package.json').read_text())['version'] == '2.1.3'
assert b'zillafan80@gmail.com' in (app / 'out/vs/workbench/workbench.desktop.main.js').read_bytes()
print(json.dumps({'status': 'PASS', 'desktop': '2.0.4', 'extension': '0.1.16', 'tornado': '6.6',
                  'llmwikiHono': '2.1.3', 'fullOfflineDocuments': True, 'upstreamMitPreserved': True,
                  'stagedVsixIdentical': True}))
