"""Static installer contract; run alongside the real upgrade/uninstall smoke test."""
from pathlib import Path
import re
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8-sig")
sections = dict(re.findall(r"^\[([^\]]+)\]\s*\n(.*?)(?=^\[|\Z)", source, re.M | re.S))
deletes = sections["UninstallDelete"].lower()
for folder in ("data", "workspace", "environments"):
    assert not re.search(r'name:\s*"\{app\}\\' + folder + r'(?:\\|"|\*)', deletes), folder
    if folder != "environments":
        directory = next(line for line in sections["Dirs"].splitlines() if f'Name: "{{app}}\\{folder}";' in line)
        assert "uninsneveruninstall" in directory
files = sections["Files"].splitlines()
general = next(line for line in files if line.startswith('Source: "*";'))
for excluded in (r"\data\user-data", r"\data\user-data\*", r"\workspace", r"\workspace\*"):
    assert excluded in general.split('Excludes: "', 1)[1].split('"', 1)[0].split(","), excluded
seed = next(line for line in files if line.startswith('Source: "data\\user-data\\*";'))
assert 'DestDir: "{app}\\data\\user-data"' in seed
for flag in ("onlyifdoesntexist", "uninsneveruninstall", "recursesubdirs", "skipifsourcedoesntexist"):
    assert flag in seed, flag
assert "ignoreversion" not in seed
# Bundled extensions still update; only the user-maintained registry is excluded.
assert r"\data\extensions\extensions.json" in general
assert r"\data\extensions\*," not in general
assert "users-modify" not in sections["Dirs"]
assert '"*S-1-5-32-545:(OI)(CI)M"' not in source
for folder in ("data", "workspace"):
    assert "AfterInstall: ProtectPrivateDirectory('" + folder + "')" in sections["Dirs"]
# WSL is provisioned on demand, outside the installer payload. User-data and
# workspace preservation above still apply; a WSL seed rule is no longer valid.
assert not any(line.startswith('Source: "environments\\wsl\\') for line in files)
workspace = next(line for line in files if line.startswith('Source: "workspace\\*";'))
assert 'onlyifdoesntexist' in workspace and 'uninsneveruninstall' in workspace
registry = next(line for line in files if line.startswith('Source: "data\\extensions\\extensions.json";'))
assert 'onlyifdoesntexist' in registry and 'uninsneveruninstall' in registry
assert 'if CurUninstallStep <> usUninstall then begin' in source
assert 'if not CurUninstallStep = usUninstall' not in source
print("Installer preservation static contract passed; runtime lifecycle still required.")
