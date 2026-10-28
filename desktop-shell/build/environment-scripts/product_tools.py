"""Verified, transactional updates of the explicitly enumerated bundled programs."""
from __future__ import annotations

import ast
import base64
import contextlib
import csv
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile


PROGRAMS = {
    "code-review-graph": "mcp/code-review-graph/code_review_graph",
    "llmwiki-modules": "mcp/llmwiki/node_modules",
    "llmwiki-package": "mcp/llmwiki/package.json",
    "llmwiki-lock": "mcp/llmwiki/package-lock.json",
    "llmwiki-archive": "mcp/llmwiki/llmwiki-core-0.1.2.tgz",
    "scrapling": "mcp/scrapling/server.py",
}
OWNERSHIP = ".product-programs.json"


def relocate_console_launchers(root: Path):
    """Rebind installed console commands to this physical Python installation."""
    root = root.resolve()
    boundary = root / "environments"
    python = boundary / "python/python.exe"
    if Path(sys.executable).resolve() != python.resolve():
        raise ValueError("Launcher relocation requires the installed Python")
    destination = python.parent / "Scripts"
    safe_path(destination, boundary)
    if destination.exists():
        inventory(destination, boundary)
    entries = {}
    devices = {"CON", "PRN", "AUX", "NUL"} | {f"{prefix}{number}" for prefix in ("COM", "LPT") for number in range(1, 10)}
    for entry in importlib.metadata.entry_points(group="console_scripts"):
        name = entry.name
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) or name.endswith(".") or name.split(".")[0].upper() in devices:
            raise ValueError("Unsafe console entry point name")
        key = name.casefold()
        if key in entries and entries[key].value != entry.value:
            raise ValueError("Conflicting console entry point metadata")
        entries[key] = entry
    from pip._vendor.distlib.scripts import ScriptMaker
    maker = ScriptMaker(None, str(destination))
    maker.executable = str(python)
    maker.variants = {""}
    maker.clobber = True
    for entry in entries.values():
        maker.make(f"{entry.name} = {entry.value}")
    if "pip" in entries:
        alias = f"pip{sys.version_info.major}.{sys.version_info.minor}"
        if alias not in entries:
            maker.make(f"{alias} = {entries['pip'].value}")
    inventory(destination, boundary)
    return {"console_launchers_relocated": len(entries)}


@contextlib.contextmanager
def retire_incomplete_runtime_metadata(root: Path):
    """Retain uninstall leftovers outside Python's active distribution search path."""
    boundary = root / "environments"
    site = boundary / "python/Lib/site-packages"
    pins = {}
    for line in Path(__file__).with_name("runtime-python-requirements.txt").read_text().splitlines():
        if line and not line.startswith("#"):
            name, version = line.split(" --hash=sha256:", 1)[0].split("==", 1)
            pins[name.lower().replace("-", "_")] = version
    retired = []
    for directory in site.glob("*.dist-info"):
        name = directory.name.rsplit(".dist-info", 1)[0].partition("-")[0].lower()
        if name not in pins or (directory / "METADATA").exists():
            continue
        inventory(directory, boundary)
        replacement = site / f"{name}-{pins[name]}.dist-info"
        safe_path(replacement, boundary)
        metadata = importlib.metadata.Distribution.at(replacement).metadata
        if metadata.get("Name", "").lower().replace("-", "_") != name or metadata.get("Version") != pins[name]:
            raise ValueError(f"No verified current runtime metadata for {name}; leftovers preserved")
        retired.append(directory)
    if not retired:
        yield
        return
    backups = root / "backups/python-metadata"
    safe_path(backups, root)
    backups.mkdir(parents=True, exist_ok=True)
    archive = Path(tempfile.mkdtemp(prefix="uninstall-leftovers-", dir=backups))
    moved = []
    try:
        for directory in retired:
            destination = archive / directory.name
            os.replace(directory, destination)
            moved.append((directory, destination))
        yield
    except BaseException:
        for directory, destination in reversed(moved):
            os.replace(destination, directory)
        archive.rmdir()
        raise


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def record_files(dist) -> dict[str, str]:
    # Distribution.files may omit paths after namespace consolidation. RECORD is
    # the installed wheel's complete ownership list, including moved files.
    rows = list(csv.reader(io.StringIO(dist.read_text("RECORD") or "")))
    if any(len(row) != 3 for row in rows) or len({row[0] for row in rows}) != len(rows):
        raise ValueError("Invalid or duplicate wheel RECORD entries")
    return {row[0]: row[1] for row in rows}


def safe_path(path: Path, boundary: Path) -> None:
    """The environment boundary may be the installer's validated storage junction."""
    path, boundary = path.absolute(), boundary.absolute()
    if not path.is_relative_to(boundary):
        raise ValueError(f"Program path escaped its approved root: {path}")
    for ancestor in (boundary, *boundary.parents):
        if ancestor.is_symlink() or ancestor.is_junction():
            expected = Path(r"D:\gpt-workspace\octocode\runtime") / ancestor.name
            if (ancestor.parent != Path(r"D:\Program Files\OctoCode")
                    or ancestor.name not in ("environments", "data", "workspace")
                    or ancestor.resolve() != expected):
                raise ValueError(f"Refusing unapproved storage link: {ancestor}")
    current = boundary
    for part in path.relative_to(boundary).parts:
        current /= part
        if current.is_symlink() or current.is_junction():
            raise ValueError(f"Refusing linked program path: {current}")


def inventory(path: Path, boundary: Path) -> dict[str, str]:
    safe_path(path, boundary)
    if path.is_file():
        return {".": digest(path)}
    if not path.is_dir():
        return {}
    result = {}
    for directory, dirs, names in os.walk(path, followlinks=False):
        for name in dirs + names:
            entry = Path(directory) / name
            # The root chain was checked above. Validate each physical child
            # before os.walk descends; repeatedly restatting every ancestor for
            # every package file makes real node_modules trees prohibitively slow.
            if entry.is_symlink() or entry.is_junction():
                raise ValueError(f"Refusing linked program content: {entry}")
        for name in names:
            entry = Path(directory) / name
            if "__pycache__" in entry.relative_to(path).parts or name.endswith((".pyc", ".pyo")):
                continue
            if not entry.is_file():
                raise ValueError(f"Program content is not a regular file: {entry}")
            result[entry.relative_to(path).as_posix()] = digest(entry)
    return result


def version_key(version: str) -> tuple[int, ...]:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:\+octocode\.(\d+))?", version)
    if not match:
        raise ValueError(f"Unrecognized product program version: {version}")
    return tuple(int(part or 0) for part in match.groups())


def namespace_version(path: Path) -> str:
    tree = ast.parse((path / "__init__.py").read_text(encoding="utf-8-sig"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__version__" for t in node.targets):
            value = ast.literal_eval(node.value)
            version_key(value)
            return value
    raise ValueError(f"Missing Python program identity/version: {path}")


def distribution_version(environments: Path, name: str) -> str:
    site = environments / "python/Lib/site-packages"
    safe_path(site, environments)
    matches = []
    for path in site.glob("*.dist-info"):
        safe_path(path / "METADATA", environments)
        dist = importlib.metadata.Distribution.at(path)
        if dist.metadata.get("Name", "").lower().replace("_", "-") == name:
            inventory(path, environments)
            matches.append(dist)
    if name == "code-review-graph" and matches:
        matches.sort(key=lambda d: version_key(d.version), reverse=True)
        if len(matches) == 1 or version_key(matches[0].version) > version_key(matches[1].version):
            return matches[0].version
    if len(matches) != 1:
        raise ValueError(f"Ambiguous installed distribution: {name}")
    version_key(matches[0].version)
    return matches[0].version


@contextlib.contextmanager
def retire_old_graph_metadata(root: Path, version: str):
    boundary = root / "environments"
    site = boundary / "python/Lib/site-packages"
    safe_path(site, boundary)
    retired = []
    for path in site.glob("*.dist-info"):
        safe_path(path / "METADATA", boundary)
        dist = importlib.metadata.Distribution.at(path)
        if dist.metadata.get("Name", "").lower().replace("_", "-") != "code-review-graph" or version_key(dist.version) >= version_key(version):
            continue
        if path.name != f"code_review_graph-{dist.version}.dist-info":
            raise ValueError(f"Unknown old distribution metadata preserved: {path}")
        records = record_files(dist)
        if f"{path.name}/RECORD" not in records:
            raise ValueError(f"Old distribution has no ownership RECORD: {path}")
        for relative, checksum in inventory(path, boundary).items():
            record = records.get(f"{path.name}/{relative}")
            if relative == "RECORD":
                continue
            expected = base64.urlsafe_b64encode(bytes.fromhex(checksum)).rstrip(b"=").decode()
            if record != "sha256=" + expected:
                raise ValueError(f"Modified old metadata preserved: {path / relative}")
        for recorded in records:
            if not (recorded.startswith(path.name + "/") or recorded.startswith("code_review_graph/")
                    or recorded in {"../../Scripts/code-review-graph.exe", "../../Scripts/crg-daemon.exe",
                                    "../../Scripts/code-review-graph", "../../Scripts/crg-daemon"}):
                raise ValueError(f"Unrecognized old distribution ownership: {recorded}")
        retired.append(path)
    if not retired:
        yield
        return
    temporary = Path(tempfile.mkdtemp(prefix=".retired-graph-metadata-", dir=site))
    moved = []
    try:
        for path in retired:
            safe_path(path, boundary)
            backup = temporary / path.name
            os.replace(path, backup)
            moved.append((path, backup))
        yield
    except BaseException:
        for path, backup in reversed(moved):
            safe_path(path, boundary)
            os.replace(backup, path)
        raise
    finally:
        safe_path(temporary, site)
        inventory(temporary, site)
        shutil.rmtree(temporary)


def component(root: Path, identity: str, version: str) -> dict:
    version_key(version)
    path = root / "environments/tools" / PROGRAMS[identity]
    files = inventory(path, root / "environments")
    if not files:
        raise ValueError(f"Bundled program is missing: {path}")
    return {"id": identity, "path": PROGRAMS[identity], "version": version, "files": files}


def verify_graph_record(namespace: Path, boundary: Path, version: str) -> None:
    dist = next(d for d in importlib.metadata.distributions(path=[str(boundary / "python/Lib/site-packages")])
                if d.metadata.get("Name", "").lower().replace("_", "-") == "code-review-graph" and d.version == version)
    records = record_files(dist)
    for relative, checksum in inventory(namespace, boundary).items():
        recorded = records.get("code_review_graph/" + relative)
        expected = base64.urlsafe_b64encode(bytes.fromhex(checksum)).rstrip(b"=").decode()
        if recorded != "sha256=" + expected:
            raise ValueError(f"Python program source does not match wheel RECORD: {relative}")


def read_ownership(tools: Path, boundary: Path) -> dict:
    path = tools / OWNERSHIP
    safe_path(path, boundary)
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if data.get("schema") != 1:
        raise ValueError("Unknown product program ownership schema")
    return {entry["id"]: entry for entry in data["programs"]}


def validate_previous(root: Path, entry: dict, previous: dict | None) -> bool:
    tools, boundary = root / "environments/tools", root / "environments"
    target = tools / entry["path"]
    actual = inventory(target, boundary)
    if not actual:
        return False
    if previous:
        if previous.get("path") != entry["path"] or actual != previous.get("files"):
            raise ValueError(f"Modified product program; existing content preserved: {target}")
        old_version = previous["version"]
    elif entry["id"] == "code-review-graph":
        old_version = namespace_version(target)
        # Legacy releases have no ownership manifest. Only package filenames from
        # the new release or retained wheel RECORDs can be claimed as program files.
        known = set(entry["files"])
        hashes = {name: {checksum} for name, checksum in entry["files"].items()}
        for dist in importlib.metadata.distributions(path=[str(boundary / "python/Lib/site-packages")]):
            if dist.metadata.get("Name", "").lower().replace("_", "-") == "code-review-graph":
                for path, recorded in record_files(dist).items():
                    if not path.startswith("code_review_graph/"):
                        continue
                    name = path[len("code_review_graph/"):]
                    known.add(name)
                    if recorded.startswith("sha256="):
                        value = recorded[len("sha256="):]
                        hashes.setdefault(name, set()).add(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).hex())
        if set(actual) - known:
            raise ValueError(f"Unknown Python namespace content; preserved: {target}")
        if any(checksum not in hashes.get(name, set()) for name, checksum in actual.items()):
            raise ValueError(f"Modified legacy Python namespace preserved: {target}")
    elif entry["id"] == "llmwiki-archive":
        if actual != entry["files"]:
            raise ValueError(f"Unowned llmwiki archive preserved: {target}")
        return True
    elif entry["id"].startswith("llmwiki-"):
        base = tools / "mcp/llmwiki"
        old_version = legacy_llmwiki_version(base, boundary)
    elif entry["id"] == "scrapling":
        if not target.read_text(encoding="utf-8-sig").startswith('"""Scrapling as a stdio MCP server,'):
            raise ValueError(f"Custom Scrapling server preserved: {target}")
        old_version = entry["version"]
    else:
        raise ValueError(f"Unknown existing program: {target}")
    if version_key(old_version) > version_key(entry["version"]):
        raise ValueError(f"Refusing program downgrade: {target}")
    return actual == entry["files"]


def legacy_llmwiki_version(base: Path, boundary: Path) -> str:
    inventory(base / "node_modules", boundary)
    for name in ("package.json", "package-lock.json"):
        safe_path(base / name, boundary)
    package = json.loads((base / "package.json").read_text(encoding="utf-8-sig"))
    lock = json.loads((base / "package-lock.json").read_text(encoding="utf-8-sig"))
    if set(package.get("dependencies", {})) != {"@llmwiki/core"} or set(package) - {"dependencies", "name", "version", "private", "lockfileVersion"}:
        raise ValueError(f"Custom llmwiki package preserved: {base}")
    core = base / "node_modules/@llmwiki/core/package.json"
    safe_path(core, boundary)
    identity = json.loads(core.read_text(encoding="utf-8-sig"))
    if identity.get("name") != "@llmwiki/core":
        raise ValueError(f"Unknown llmwiki package identity: {core}")
    known = set(lock.get("packages", {}))
    if "node_modules/@llmwiki/core" not in known:
        raise ValueError(f"Missing llmwiki package ownership: {base}")
    for manifest in (base / "node_modules").rglob("package.json"):
        folder = manifest.parent
        if folder.parent.name != "node_modules" and not (folder.parent.name.startswith("@") and folder.parent.parent.name == "node_modules"):
            continue
        if folder.relative_to(base).as_posix() not in known:
            raise ValueError(f"Custom Node package preserved: {folder}")
        installed = json.loads(manifest.read_text(encoding="utf-8-sig"))
        expected_name = f"{folder.parent.name}/{folder.name}" if folder.parent.name.startswith("@") else folder.name
        recorded = lock["packages"][folder.relative_to(base).as_posix()]
        if installed.get("name") != expected_name or installed.get("version") != recorded.get("version"):
            raise ValueError(f"Node package identity/version does not match lock: {manifest}")
    for child in (base / "node_modules").iterdir():
        if child.is_file() and child.name != ".package-lock.json":
            raise ValueError(f"Unknown Node module root file preserved: {child}")
    version_key(identity["version"])
    return identity["version"]


@contextlib.contextmanager
def replace_programs(root: Path, entries: list[dict], sources: dict[str, Path]):
    """Stage/read back everything, then swap; retain old programs until commit."""
    root = root.absolute()
    tools, boundary = root / "environments/tools", root / "environments"
    safe_path(tools, boundary)
    previous = read_ownership(tools, boundary)
    identities = set()
    changed = []
    for entry in entries:
        identity = entry["id"]
        if identity in identities or PROGRAMS.get(identity) != entry["path"]:
            raise ValueError("Unknown or repeated program payload identity")
        identities.add(identity)
        version_key(entry["version"])
        if inventory(sources[identity], boundary) != entry["files"]:
            raise ValueError(f"Program payload checksum mismatch: {identity}")
        if not validate_previous(root, entry, previous.get(identity)):
            changed.append(entry)
    tools.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".octocode-program-update-", dir=tools))
    swapped = []
    owner = tools / OWNERSHIP
    old_owner = owner.read_bytes() if owner.exists() else None
    try:
        for entry in changed:
            source, staged = sources[entry["id"]], temporary / entry["id"]
            if source.is_dir():
                shutil.copytree(source, staged, ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"))
            else:
                shutil.copy2(source, staged)
            if inventory(staged, boundary) != entry["files"]:
                raise OSError("Staged program read-back failed")
        for entry in changed:
            target = tools / entry["path"]
            safe_path(target, boundary)
            target.parent.mkdir(parents=True, exist_ok=True)
            backup = temporary / (entry["id"] + ".old")
            if target.exists():
                os.replace(target, backup)
            swapped.append((target, backup))
            os.replace(temporary / entry["id"], target)
        previous.update({entry["id"]: entry for entry in entries})
        new_owner = temporary / "ownership.json"
        new_owner.write_text(json.dumps({"schema": 1, "programs": list(previous.values())}, indent=2), encoding="utf-8")
        safe_path(owner, boundary)
        os.replace(new_owner, owner)
        if os.name == "nt":
            # Elevated private staging ACLs must not replace the secured runtime parent's access.
            for target in [*(tools / entry["path"] for entry in entries), owner]:
                subprocess.run(["icacls.exe", str(target), "/reset", "/T", "/Q"], check=True,
                               capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
        yield
    except BaseException:
        for target, backup in reversed(swapped):
            safe_path(target, boundary)
            if target.is_dir():
                inventory(target, boundary)
                shutil.rmtree(target)
            elif target.exists():
                target.unlink()
            if backup.exists():
                os.replace(backup, target)
        if old_owner is None:
            owner.unlink(missing_ok=True)
        else:
            owner.write_bytes(old_owner)
        raise
    finally:
        # This is a generated physical child of tools, never a computed user root.
        safe_path(temporary, tools)
        inventory(temporary, tools)
        shutil.rmtree(temporary)


def build_bundle(root: Path) -> Path:
    root = root.absolute()
    environments = root / "environments"
    tools = environments / "tools"
    core = tools / "mcp/llmwiki/node_modules/@llmwiki/core/package.json"
    safe_path(core, environments)
    package = json.loads(core.read_text(encoding="utf-8-sig"))
    if package.get("name") != "@llmwiki/core":
        raise ValueError("Bundled llmwiki identity mismatch")
    legacy_llmwiki_version(tools / "mcp/llmwiki", environments)
    versions = {"code-review-graph": distribution_version(environments, "code-review-graph"),
                "scrapling": distribution_version(environments, "scrapling")}
    versions.update({name: package["version"] for name in PROGRAMS if name.startswith("llmwiki-")})
    entries = [component(root, name, versions[name]) for name in PROGRAMS]
    if version_key(namespace_version(tools / PROGRAMS["code-review-graph"]))[:3] != version_key(versions["code-review-graph"])[:3]:
        raise ValueError("Python namespace/distribution version mismatch")
    verify_graph_record(tools / PROGRAMS["code-review-graph"], environments, versions["code-review-graph"])
    destination = environments / "installer/system-tools.zip"
    safe_path(destination, environments)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".zip.new")
    safe_path(temporary, environments)
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        defaults = Path(__file__).with_name("mcp_defaults.json").read_bytes()
        archive.writestr("manifest.json", json.dumps({"schema": 1, "programs": entries,
                          "defaults_sha256": hashlib.sha256(defaults).hexdigest()}, indent=2))
        archive.writestr("defaults/mcp_settings.json", defaults)
        for entry in entries:
            base = tools / entry["path"]
            for relative in entry["files"]:
                source = base if relative == "." else base / relative
                archive.write(source, f"programs/{entry['id']}/{relative if relative != '.' else 'file'}")
    os.replace(temporary, destination)
    # A subsequent offline wheel reinstall removes its old RECORD. Keep the
    # verified build-stage program baseline so the next ordinary upgrade can
    # still distinguish our old namespace from modified user content.
    previous = read_ownership(tools, environments)
    previous.update({entry["id"]: entry for entry in entries})
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix=".program-ownership-", dir=tools, delete=False) as stream:
        ownership_temporary = Path(stream.name)
        json.dump({"schema": 1, "programs": list(previous.values())}, stream, indent=2)
    try:
        safe_path(tools / OWNERSHIP, environments)
        os.replace(ownership_temporary, tools / OWNERSHIP)
    finally:
        ownership_temporary.unlink(missing_ok=True)
    return destination


@contextlib.contextmanager
def install_bundle(root: Path):
    root = root.absolute()
    boundary = root / "environments"
    archive_path = boundary / "installer/system-tools.zip"
    safe_path(archive_path, boundary)
    if not archive_path.exists():
        yield
        return
    scratch_parent = boundary / "installer"
    temporary = Path(tempfile.mkdtemp(prefix=".program-payload-", dir=scratch_parent))
    default_created = False
    settings = boundary / "tools/mcp/mcp_settings.json"
    try:
        with zipfile.ZipFile(archive_path) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            if manifest.get("schema") != 1 or {e["id"] for e in manifest["programs"]} != set(PROGRAMS):
                raise ValueError("Incomplete product program payload")
            allowed = {"manifest.json", "defaults/mcp_settings.json"}
            defaults = archive.read("defaults/mcp_settings.json")
            if hashlib.sha256(defaults).hexdigest() != manifest.get("defaults_sha256"):
                raise ValueError("Default MCP settings checksum mismatch")
            json.loads(defaults)
            safe_path(settings, boundary)
            sources = {}
            for entry in manifest["programs"]:
                identity = entry["id"]
                if PROGRAMS.get(identity) != entry["path"] or not entry["files"]:
                    raise ValueError("Invalid program payload path")
                base = temporary / identity
                sources[identity] = base
                for relative, checksum in entry["files"].items():
                    path = PurePosixPath(relative)
                    if path.is_absolute() or ".." in path.parts or "\\" in relative or ":" in relative or not re.fullmatch(r"[0-9a-f]{64}", checksum):
                        raise ValueError("Unsafe program payload member")
                    member = f"programs/{identity}/{relative if relative != '.' else 'file'}"
                    allowed.add(member)
                    data = archive.read(member)
                    if hashlib.sha256(data).hexdigest() != checksum:
                        raise ValueError(f"Program payload checksum mismatch: {member}")
                    destination = base if relative == "." else base / path
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(data)
            if len(archive.namelist()) != len(set(archive.namelist())) or set(archive.namelist()) != allowed:
                raise ValueError("Unexpected or duplicate program archive members")
            versions = {entry["id"]: entry["version"] for entry in manifest["programs"]}
            if version_key(namespace_version(sources["code-review-graph"]))[:3] != version_key(versions["code-review-graph"])[:3]:
                raise ValueError("Payload Python namespace/version mismatch")
            core = json.loads((sources["llmwiki-modules"] / "@llmwiki/core/package.json").read_text(encoding="utf-8-sig"))
            lock = json.loads(sources["llmwiki-lock"].read_text(encoding="utf-8-sig"))
            package = json.loads(sources["llmwiki-package"].read_text(encoding="utf-8-sig"))
            if (core.get("name") != "@llmwiki/core" or set(package.get("dependencies", {})) != {"@llmwiki/core"}
                    or any(versions[name] != core.get("version") for name in versions if name.startswith("llmwiki-"))
                    or lock.get("packages", {}).get("node_modules/@llmwiki/core", {}).get("version") != core.get("version")):
                raise ValueError("Payload Node package identity/version mismatch")
        with replace_programs(root, manifest["programs"], sources):
            try:
                legacy_settings = root / "data/user-data/User/globalStorage/octocode.octocode/settings/mcp_settings.json"
                safe_path(legacy_settings, root / "data")
                if not settings.exists() and not legacy_settings.exists():
                    settings.parent.mkdir(parents=True, exist_ok=True)
                    with settings.open("xb") as stream:
                        stream.write(defaults)
                    default_created = True
                yield
            except BaseException:
                if default_created:
                    safe_path(settings, boundary)
                    settings.unlink()
                raise
    finally:
        safe_path(temporary, scratch_parent)
        inventory(temporary, scratch_parent)
        shutil.rmtree(temporary)


@contextlib.contextmanager
def consolidate_namespace(root: Path, *, bundled: bool = False):
    root = root.absolute()
    boundary = root / "environments"
    source = boundary / "python/Lib/site-packages/code_review_graph"
    safe_path(source, boundary)
    if not source.is_dir():
        if bundled:
            owned = read_ownership(boundary / "tools", boundary)["code-review-graph"]
            with retire_old_graph_metadata(root, owned["version"]):
                yield
        else:
            yield
        return
    if bundled:
        # Older installers left the namespace in site-packages. The incoming
        # bundle has the new program; retaining that old namespace would shadow
        # the .pth import path. Retire only a RECORD-verified old distribution.
        owned = read_ownership(boundary / "tools", boundary)["code-review-graph"]
        source_version = namespace_version(source)
        matching = []
        for dist in importlib.metadata.distributions(path=[str(source.parent)]):
            if dist.metadata.get("Name", "").lower().replace("_", "-") != "code-review-graph" or version_key(dist.version)[:3] != version_key(source_version)[:3]:
                continue
            safe_path(source.parent / f"code_review_graph-{dist.version}.dist-info/RECORD", boundary)
            records = record_files(dist)
            if all(records.get("code_review_graph/" + relative) == "sha256=" + base64.urlsafe_b64encode(bytes.fromhex(checksum)).rstrip(b"=").decode()
                   for relative, checksum in inventory(source, boundary).items()):
                matching.append(dist.version)
        if not matching or max(map(version_key, matching)) > version_key(owned["version"]):
            raise ValueError("Unrecognized or newer site-packages namespace preserved")
        temporary = Path(tempfile.mkdtemp(prefix=".retired-graph-namespace-", dir=source.parent))
        backup = temporary / "code_review_graph"
        try:
            os.replace(source, backup)
            try:
                with retire_old_graph_metadata(root, owned["version"]):
                    yield
            except BaseException:
                os.replace(backup, source)
                raise
        finally:
            safe_path(temporary, source.parent)
            inventory(temporary, source.parent)
            shutil.rmtree(temporary)
        return
    version = distribution_version(boundary, "code-review-graph")
    if version_key(namespace_version(source))[:3] != version_key(version)[:3]:
        raise ValueError("Python source namespace/distribution mismatch")
    entry = {"id": "code-review-graph", "path": PROGRAMS["code-review-graph"],
             "version": version, "files": inventory(source, boundary)}
    verify_graph_record(source, boundary, version)
    target = boundary / "tools" / entry["path"]
    if inventory(target, boundary) == entry["files"]:
        with retire_old_graph_metadata(root, version):
            yield
        return
    with replace_programs(root, [entry], {"code-review-graph": source}), retire_old_graph_metadata(root, version):
        yield


@contextlib.contextmanager
def consolidate_scrapling(root: Path):
    root = root.absolute()
    boundary = root / "environments"
    source = boundary / "scripts/scrapling_mcp.py"
    safe_path(source, boundary)
    if not source.exists():
        yield
        return
    entry = {"id": "scrapling", "path": PROGRAMS["scrapling"],
             "version": distribution_version(boundary, "scrapling"), "files": inventory(source, boundary)}
    if inventory(boundary / "tools" / entry["path"], boundary) == entry["files"]:
        yield
        return
    with replace_programs(root, [entry], {"scrapling": source}):
        yield
