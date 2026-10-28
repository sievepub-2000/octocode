"""Consolidate product-owned tools. Conflicts fail before any source is removed."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
from product_tools import build_bundle, consolidate_namespace, consolidate_scrapling, install_bundle, legacy_llmwiki_version, retire_incomplete_runtime_metadata, safe_path, relocate_console_launchers


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def normalize_server(server: dict) -> dict:
    """Compare legacy and current product paths after the same migration."""
    args = server.get("args", [])
    if "args" in server:
        server["args"] = [arg.replace("${env:OCTOCODE_ENVIRONMENTS}/llmwiki/", "${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/llmwiki/").replace("${env:OCTOCODE_ENVIRONMENTS}/scripts/scrapling_mcp.py", "${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/scrapling/server.py") if isinstance(arg, str) else arg for arg in args]
    if "code_review_graph" in args:
        server.setdefault("env", {}).setdefault("PYTHONPATH", "${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/code-review-graph")
    return server


def migrate(root: Path, *, packaging: bool = False) -> dict:
    bundled = not packaging and (root / "environments/installer/system-tools.zip").is_file()
    with contextlib.ExitStack() as transaction:
        transaction.enter_context(retire_incomplete_runtime_metadata(root))
        if bundled:
            transaction.enter_context(install_bundle(root))
        transaction.enter_context(consolidate_namespace(root, bundled=bundled))
        if not bundled:
            transaction.enter_context(consolidate_scrapling(root))
        return _migrate(root, bundled=bundled)


def _migrate(root: Path, *, bundled: bool = False) -> dict:
    root = root.absolute()
    environments = root / "environments"
    tools = environments / "tools"
    safe_path(tools, environments)
    for kind in ("skills", "mcp", "hooks"):
        (tools / kind).mkdir(parents=True, exist_ok=True)
    # Product-owned legacy roots only; workspace config may be project-private.
    moves: list[tuple[Path, Path]] = []
    for source, target in (
        (environments / "llmwiki", tools / "mcp/llmwiki"),
        (environments / "python/Lib/site-packages/code_review_graph", tools / "mcp/code-review-graph/code_review_graph"),
        (root / "data/user-data/User/globalStorage/octocode.octocode/harness-runtime/hooks", tools / "hooks"),
        (root / "data/user-data/User/globalStorage/octocode.octocode/harness-runtime/skills", tools / "skills"),
    ):
        if source.is_dir():
            moves.append((source, target))
    legacy_mcp = root / "data/user-data/User/globalStorage/octocode.octocode/settings/mcp_settings.json"
    authoritative = tools / "mcp/mcp_settings.json"
    safe_path(authoritative, environments)
    safe_path(legacy_mcp, root / "data")
    sources = [legacy_mcp] if legacy_mcp.is_file() else []
    merged = json.loads(authoritative.read_text(encoding="utf-8-sig")) if authoritative.exists() else {"mcpServers": {}}
    for source in sources:
        data = json.loads(source.read_text(encoding="utf-8-sig"))
        for key, value in data.items():
            if key == "mcpServers":
                continue
            if key in merged and merged[key] != value:
                raise ValueError(f"Conflicting MCP configuration field: {key} ({source})")
            merged[key] = value
        for name, server in data.get("mcpServers", {}).items():
            previous = merged["mcpServers"].get(name)
            if previous is not None and normalize_server(previous) != normalize_server(server):
                raise ValueError(f"Conflicting MCP configuration: {name} ({source})")
            merged["mcpServers"][name] = normalize_server(server)
    files: list[tuple[Path, Path, str]] = []
    for source, destination in moves:
        safe_path(source, environments if source.is_relative_to(environments) else root / "data")
        safe_path(destination, environments)
        if not any(source.resolve().is_relative_to(base.resolve()) for base in [root / "data", environments]):
            raise ValueError(f"Legacy source escaped its approved root: {source}")
        if source.is_symlink() or source.is_junction():
            raise ValueError(f"Refusing to migrate linked tool directory: {source}")
        bundled_wiki = source == environments / "llmwiki" and bundled
        if bundled_wiki:
            legacy_llmwiki_version(source, environments)
        for folder, dirs, names in os.walk(source, followlinks=False):
            for name in dirs + names:
                entry = Path(folder) / name
                if entry.is_symlink() or entry.is_junction():
                    raise ValueError(f"Refusing linked tool content: {entry}")
            dirs[:] = [name for name in dirs if name != "__pycache__"]
            if bundled_wiki and Path(folder) == source:
                dirs[:] = [name for name in dirs if name != "node_modules"]
            for name in names:
                if bundled_wiki and Path(folder) == source and name in ("package.json", "package-lock.json"):
                    continue
                if name.endswith((".pyc", ".pyo")):
                    continue
                entry = Path(folder) / name
                target = destination / entry.relative_to(source)
                safe_path(target, environments)
                checksum = digest(entry)
                if target.exists() and digest(target) != checksum:
                    raise ValueError(f"Conflicting tool file: {target}; preserved {entry}")
                files.append((entry, target, checksum))
    for source, target, checksum in files:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copy2(source, target)
        if digest(target) != checksum:
            raise OSError(f"Tool copy verification failed: {target}")
    # Config values retain environment placeholders so custom install paths work.
    for server in merged["mcpServers"].values():
        normalize_server(server)
    scrapling = environments / "scripts/scrapling_mcp.py"
    safe_path(scrapling, environments)
    if scrapling.is_file():
        target = tools / "mcp/scrapling/server.py"
        safe_path(target, environments)
        target.parent.mkdir(parents=True, exist_ok=True)
        obsolete_bundled_wrapper = bundled and scrapling.read_text(encoding="utf-8-sig").startswith('"""Scrapling as a stdio MCP server,')
        if target.exists() and digest(target) != digest(scrapling) and not obsolete_bundled_wrapper:
            raise ValueError("Conflicting Scrapling server; both sources preserved")
        if not obsolete_bundled_wrapper:
            shutil.copy2(scrapling, target)
        if not obsolete_bundled_wrapper and digest(target) != digest(scrapling):
            raise OSError("Scrapling copy read-back failed")
    if not authoritative.exists() or json.loads(authoritative.read_text(encoding="utf-8-sig")) != merged:
        temporary = authoritative.with_suffix(".json.tmp")
        safe_path(temporary, environments)
        temporary.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, authoritative)
        if json.loads(authoritative.read_text(encoding="utf-8")) != merged:
            raise OSError("MCP configuration read-back failed")
    site_packages = environments / "python/Lib/site-packages"
    if site_packages.is_dir() and (tools / "mcp/code-review-graph/code_review_graph").is_dir():
        import_path = site_packages / "octocode-system-tools.pth"
        safe_path(import_path, environments)
        expected = os.path.relpath(tools / "mcp/code-review-graph", site_packages) + "\n"
        if import_path.exists() and import_path.read_text(encoding="utf-8").strip() != expected.strip():
            raise ValueError(f"Custom system tools import path preserved: {import_path}")
        if not import_path.exists():
            with import_path.open("x", encoding="utf-8") as stream:
                stream.write(expected)
        if import_path.read_text(encoding="utf-8").strip() != expected.strip():
            raise OSError("System tools import path read-back failed")
    # Every source is in an explicitly enumerated root and all files read back.
    for source, _ in moves:
        shutil.rmtree(source)
    for source in sources:
        source.unlink()
    if scrapling.is_file():
        scrapling.unlink()
    return {"files_verified": len(files), "mcp_configs_merged": len(sources), "tools": str(tools)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--build-bundle", action="store_true", help="Package verified product programs after consolidation")
    parser.add_argument("--relocate-launchers", action="store_true", help="Rebind console launchers to the installed Python")
    args = parser.parse_args()
    print(json.dumps(migrate(args.root, packaging=args.build_bundle), ensure_ascii=False))
    if args.build_bundle:
        print(json.dumps({"program_bundle": str(build_bundle(args.root))}))
    if args.relocate_launchers:
        print(json.dumps(relocate_console_launchers(args.root)))
