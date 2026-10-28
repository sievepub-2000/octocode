"""Version-bound M3 Ultra hotfix loader; vendor signatures remain untouched."""
import ast
import hashlib
import importlib.abc
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
VENDOR = Path("/Applications/oMLX.app/Contents/Resources/omlx")
FILES = {
    "omlx.engine.base": "engine/base.py",
    "omlx.engine.vlm": "engine/vlm.py",
    "omlx.scheduler": "scheduler.py",
    "omlx.memory_monitor": "memory_monitor.py",
    "mlx_vlm.models.glm5_next.language":
        "patches/mlx_vlm_glm5_next_compat/vendor/mlx_vlm/models/glm5_next/language.py",
}
try:
    chip = subprocess.check_output(
        ["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
    if chip != "Apple M3 Ultra":
        raise RuntimeError("This measured hotfix is restricted to Apple M3 Ultra")
    manifest = json.loads((ROOT / "manifest.json").read_text())
    names = set(manifest)
    bounded_indexer = names == {"memory_monitor.py", "language.py"}
    if not bounded_indexer and names != {Path(relative).name for relative in FILES.values()}:
        raise RuntimeError("Unexpected hotfix module scope")
    with (VENDOR.parents[1] / "Info.plist").open("rb") as handle:
        version = plistlib.load(handle)["CFBundleShortVersionString"]
    if version not in (("0.7.3.dev1", "0.7.3.dev2") if bounded_indexer else ("0.7.1.dev2",)):
        raise RuntimeError("Unreviewed oMLX App version")
    FILES = {module: relative for module, relative in FILES.items() if Path(relative).name in names}
    for relative in FILES.values():
        name = Path(relative).name
        for path, expected in ((VENDOR / relative, manifest[name]["vendor"]),
                               (ROOT / name, manifest[name]["patched"])):
            if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise RuntimeError(f"Hotfix source mismatch: {path}")
except Exception as error:
    print(f"OctoCode oMLX hotfix validation failed: {error}", file=sys.stderr, flush=True)
    os._exit(78)


class LanguageLoader(importlib.abc.Loader):
    def __init__(self, original):
        self.original = original

    def create_module(self, spec):
        return self.original.create_module(spec)

    def exec_module(self, module):
        # Preserve vendor package discovery; replace only the reviewed method.
        self.original.exec_module(module)
        path = ROOT / "language.py"
        tree = ast.parse(path.read_text())
        cls = next(n for n in tree.body if isinstance(n, ast.ClassDef)
                   and n.name == "Glm5NextIndexer")
        method = next(n for n in cls.body if isinstance(n, ast.FunctionDef)
                      and n.name == "__call__")
        scope = dict(module.__dict__)
        exec(compile(ast.Module(body=[method], type_ignores=[]), str(path), "exec"), scope)
        module.Glm5NextIndexer.__call__ = scope["__call__"]
        module.__octocode_hotfix_source__ = str(path)


class HotfixFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        relative = FILES.get(fullname)
        if relative is None:
            return None
        if fullname == "mlx_vlm.models.glm5_next.language":
            spec = importlib.machinery.PathFinder.find_spec(fullname, path)
            if spec is None or Path(spec.origin).resolve() != (VENDOR / relative).resolve():
                raise ImportError("Unexpected GLM language implementation")
            spec.loader = LanguageLoader(spec.loader)
            return spec
        return importlib.util.spec_from_file_location(fullname, ROOT / Path(relative).name)


sys.meta_path.insert(0, HotfixFinder())
os.environ["OCTOCODE_OMLX_PREFLIGHT_FIX"] = "20261025" if bounded_indexer else "20261020"
