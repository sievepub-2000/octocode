"""Read staged 2.0.5 artifacts without launching or modifying the formal client."""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

root = Path(__file__).resolve().parents[2]
product = root / 'VSCode-win32-x64'
app = product / 'resources/app'
metadata = json.loads((app / 'product.json').read_text(encoding='utf-8'))
assert metadata['version'] == '2.0.5'
assert json.loads((app / 'package.json').read_text(encoding='utf-8'))['version'] == '2.0.5'
expected_commit = subprocess.check_output(['git', 'rev-parse', 'v2.0.5'], cwd=root, text=True).strip()
assert metadata['commit'] == expected_commit
assert (app / 'LICENSE.txt').read_bytes() == (root / 'desktop-shell/LICENSE.txt').read_bytes()
assert (app / 'OCTOCODE-LICENSE.txt').read_bytes() == (root / 'desktop-shell/OCTOCODE-LICENSE.txt').read_bytes()

vsix = root / 'octocode-core/bin/octocode-0.1.17.vsix'
with zipfile.ZipFile(vsix) as archive:
    assert json.loads(archive.read('extension/package.json'))['version'] == '0.1.17'
    extension = archive.read('extension/dist/extension.js')
    assert b'GROK_SHELL' in extension and b'pwsh' in extension
    assert b'desktopVersion' in extension and b'desktopCommit' in extension
    assets = b'\n'.join(archive.read(name) for name in archive.namelist()
                        if name.startswith('extension/webview-ui/build/assets/') and name.endswith('.mjs'))
    assert b'https://octosys.cloud' in assets
    assert b'desktopVersion' in assets and b'desktopCommit' in assets

def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()

staged_vsix = product / 'environments/installer/octocode.vsix'
assert digest(staged_vsix) == digest(vsix)
assert (root / 'desktop-shell/build/win32/octocode-initialize.ps1').read_bytes() == (
    product / 'environments/scripts/initialize.ps1').read_bytes()
assert not list((product / 'environments').rglob('powershell.exe'))
pwsh = product / 'environments/powershell/pwsh.exe'
assert subprocess.check_output([str(pwsh), '-NoLogo', '-NoProfile', '-Command',
                                '$PSVersionTable.PSVersion.ToString()'], text=True).strip() == '7.6.9'
literal = str(pwsh).replace("'", "''")
command = f"$s=Get-AuthenticodeSignature -LiteralPath '{literal}'; if($s.Status -ne 'Valid'){{throw $s.Status}}; $s.SignerCertificate.Subject"
signature = subprocess.check_output([str(pwsh), '-NoProfile', '-Command', command], text=True).strip()
assert 'Microsoft Corporation' in signature
native = app / 'extensions/ms-vscode.js-debug/src/win32-app-container-tokens.win32-x64-msvc-VCQE7GJP.node'
node = product / 'environments/node/node.exe'
subprocess.run([str(node), '-e', 'require(process.argv[1]); console.log("debugger native module loaded")', str(native)], check=True)
python = product / 'environments/python/python.exe'
subprocess.run([str(python), '-m', 'pip', 'check'], check=True)
print(json.dumps({'status': 'PASS', 'desktop': metadata['version'], 'commit': metadata['commit'],
                  'extension': '0.1.17', 'powershell': '7.6.9', 'microsoftSignature': 'Valid',
                  'stagedVsixSha256': digest(vsix), 'formalClientTouched': False}))
