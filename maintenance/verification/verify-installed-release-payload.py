"""Verify signed extension/UI payload and built-in theme resources after installation."""
import base64
import hashlib
import json
import sys
import zipfile
from pathlib import Path

from cryptography.hazmat.primitives.serialization import load_der_public_key

app, release = (Path(value).resolve() for value in sys.argv[1:3])
source = Path(__file__).resolve().parents[2]
anchor = json.loads((source / 'maintenance/release-signing/release-public-key.json').read_text(encoding='utf-8'))
raw = (release / 'octocode-release.json').read_bytes()
key = load_der_public_key(base64.b64decode(anchor['publicKeySpkiBase64']))
key.verify((release / 'octocode-release.json.sig').read_bytes(), raw)
manifest = json.loads(raw)
assert manifest['product'] == 'OctoCode' and manifest['repository'] == 'sievepub-2000/octocode'
assert manifest['version'] == json.loads((app / 'resources/app/package.json').read_text(encoding='utf-8'))['version'], 'Installed desktop version differs from signed release'
asset = manifest['assets']['extension']
vsix = app / 'environments/installer/octocode.vsix'
assert vsix.stat().st_size == asset['size'] and hashlib.sha256(vsix.read_bytes()).hexdigest() == asset['sha256'], 'Installed VSIX differs from signed release'
catalog = json.loads((app / 'data/extensions/extensions.json').read_text(encoding='utf-8'))
registered = [item for item in catalog if item['identifier']['id'].lower() == 'octocode.octocode']
assert len(registered) == 1 and registered[0]['version'] == asset['version']
extension = Path(registered[0]['location']['fsPath'].removeprefix('\\\\?\\')).resolve()
assert extension.is_relative_to(app / 'data/extensions')
count = 0
with zipfile.ZipFile(vsix) as archive:
    for name in archive.namelist():
        if name.endswith('/') or not name.startswith(('extension/dist/', 'extension/webview-ui/build/', 'extension/integrations/theme/default-themes/')):
            continue
        actual = (extension / name.removeprefix('extension/')).resolve()
        assert actual.is_relative_to(extension) and actual.is_file()
        assert hashlib.sha256(actual.read_bytes()).digest() == hashlib.sha256(archive.read(name)).digest(), 'Installed extension resource differs: ' + name
        count += 1
assert count > 10 and b'toCoercible' in (extension / 'dist/extension.js').read_bytes(), 'Packaged qs guard missing'
declaration = app / 'environments/scripts/harness2_vendor/pyproject.toml'
assert 'litellm[proxy]==1.100.4' in declaration.read_text(encoding='utf-8'), 'Optional bridge declaration is stale'
expected_themes = source / 'VSCode-win32-x64/resources/app/extensions/octocode-themes/themes'
themes = list(expected_themes.glob('*.json'))
assert themes, 'Built desktop theme reference missing'
for theme in themes:
    actual = app / 'resources/app/extensions/octocode-themes/themes' / theme.name
    assert hashlib.sha256(actual.read_bytes()).digest() == hashlib.sha256(theme.read_bytes()).digest(), 'Installed built-in theme differs: ' + theme.name
print(json.dumps({'status': 'PASS', 'extensionVersion': asset['version'], 'signedExtensionResourcesMatched': count, 'qsRuntimeGuard': True, 'optionalBridgeVersion': '1.100.4', 'desktopThemesMatched': len(themes)}))
