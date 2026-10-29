"""Bundle canonical licensing and handbook text without maintaining separate copies."""
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
target = root / 'octocode-core/webview-ui/src/generated/about'
read = lambda file: (root / file).read_text(encoding='utf-8-sig').replace('\r\n', '\n')
documents = {
    target / 'license.txt': read('LICENSE') + '\n\n' + read('LICENSE-COMMERCIAL.md'),
    target / 'manual.txt': read('docs/USER_GUIDE.zh-CN.md'),
    target / 'third-party.txt': read('THIRD_PARTY_NOTICES.md') + ''.join(
        '\n\n## ' + name + '\n\n' + read(file) for name, file in [
            ('VS Code MIT', 'desktop-shell/LICENSE.txt'),
            ('Core Apache-2.0', 'octocode-core/LICENSE'),
            ('Harness Apache-2.0', 'octo-harness/LICENSE'),
            ('lawndoc MIT', 'licenses/lawndoc-template-MIT.txt')]),
    root / 'desktop-shell/OCTOCODE-LICENSE.txt': read('LICENSE') + '\n\n' + read('LICENSE-COMMERCIAL.md'),
}
assert sys.argv[1:] in ([], ['--check'])
for file, text in documents.items():
    if '--check' in sys.argv:
        assert file.is_file() and file.read_text(encoding='utf-8-sig').replace('\r\n', '\n') == text, 'Stale bundled document: ' + str(file.relative_to(root))
    else:
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(text, encoding='utf-8-sig' if file.suffix == '.txt' and file.parent.name == 'desktop-shell' else 'utf-8', newline='\n')
print('PASS: canonical About documents and installer license match' if '--check' in sys.argv else 'Generated About documents and installer license')
