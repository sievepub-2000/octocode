"""Consolidate product-owned tools. Conflicts fail before any source is removed."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def normalize_server(server: dict) -> dict:
    """Compare legacy and current product paths after the same migration."""
    args = server.get("args", [])
    server["args"] = [arg.replace("${env:OCTOCODE_ENVIRONMENTS}/llmwiki/", "${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/llmwiki/").replace("${env:OCTOCODE_ENVIRONMENTS}/scripts/scrapling_mcp.py", "${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/scrapling/server.py") if isinstance(arg, str) else arg for arg in args]
    if "code_review_graph" in args:
        server.setdefault("env", {})["PYTHONPATH"] = "${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/code-review-graph"
    return server


def migrate(root: Path) -> dict:
    root = root.absolute()
    environments = root / "environments"
    tools = environments / "tools"
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
    sources = [legacy_mcp] if legacy_mcp.is_file() else []
    merged = json.loads(authoritative.read_text(encoding="utf-8-sig")) if authoritative.exists() else {"mcpServers": {}}
    for source in sources:
        data = json.loads(source.read_text(encoding="utf-8-sig"))
        for name, server in data.get("mcpServers", {}).items():
            previous = merged["mcpServers"].get(name)
            if previous is not None and normalize_server(previous) != normalize_server(server):
                raise ValueError(f"Conflicting MCP configuration: {name} ({source})")
            merged["mcpServers"][name] = normalize_server(server)
    files: list[tuple[Path, Path, str]] = []
    for source, destination in moves:
        if not any(source.resolve().is_relative_to(base.resolve()) for base in [root / "data", environments]):
            raise ValueError(f"Legacy source escaped its approved root: {source}")
        if source.is_symlink() or source.is_junction():
            raise ValueError(f"Refusing to migrate linked tool directory: {source}")
        for folder, dirs, names in os.walk(source, followlinks=False):
            for name in dirs + names:
                entry = Path(folder) / name
                if entry.is_symlink() or entry.is_junction():
                    raise ValueError(f"Refusing linked tool content: {entry}")
            dirs[:] = [name for name in dirs if name != "__pycache__"]
            for name in names:
                if name.endswith((".pyc", ".pyo")):
                    continue
                entry = Path(folder) / name
                target = destination / entry.relative_to(source)
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
    if scrapling.is_file():
        target = tools / "mcp/scrapling/server.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and digest(target) != digest(scrapling):
            raise ValueError("Conflicting Scrapling server; both sources preserved")
        shutil.copy2(scrapling, target)
        if digest(target) != digest(scrapling):
            raise OSError("Scrapling copy read-back failed")
    if merged["mcpServers"] or sources or not authoritative.exists():
        temporary = authoritative.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, authoritative)
        if json.loads(authoritative.read_text(encoding="utf-8")) != merged:
            raise OSError("MCP configuration read-back failed")
    # Every source is in an explicitly enumerated root and all files read back.
    for source, _ in moves:
        shutil.rmtree(source)
    for source in sources:
        source.unlink()
    if scrapling.is_file():
        scrapling.unlink()
    site_packages = environments / "python/Lib/site-packages"
    if site_packages.is_dir() and (tools / "mcp/code-review-graph/code_review_graph").is_dir():
        (site_packages / "octocode-system-tools.pth").write_text(
            os.path.relpath(tools / "mcp/code-review-graph", site_packages) + "\n", encoding="utf-8")
    return {"files_verified": len(files), "mcp_configs_merged": len(sources), "tools": str(tools)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(migrate(args.root), ensure_ascii=False))
