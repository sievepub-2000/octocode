"""Relocate only managed path bindings after OctoCode is stopped and copied to E:."""

import argparse
from contextlib import closing
import json
import ntpath
from pathlib import Path
import sqlite3


INSTALL_ROOT = Path("E:/Program Files/octocode")
LEGACY_ROOTS = ("D:/gpt-workspace/octocode/runtime", "D:/Program Files/OctoCode")
NATIVE_COLUMNS = (("sessions", "workspace"), ("projects", "workspace"), ("projects", "directory"), ("artifacts", "path"))
DIRECTORY_HISTORY = "terminal.history.entries.dirs"


def relocated(value, install_root):
    if not isinstance(value, str):
        return value
    normalized = value[4:] if value.startswith("\\\\?\\") else value
    normalized = ntpath.normpath(normalized)
    for legacy in LEGACY_ROOTS:
        prefix = ntpath.normpath(legacy)
        if normalized.casefold() == prefix.casefold() or normalized.casefold().startswith(prefix.casefold() + "\\"):
            suffix = normalized[len(prefix):].lstrip("\\")
            return str(install_root.joinpath(*suffix.split("\\"))) if suffix else str(install_root)
    return value


def contained(path, root):
    return path.resolve().is_relative_to(root.resolve())


def migrate(install_root=INSTALL_ROOT, apply=False):
    install_root = Path(install_root).absolute()
    if install_root != INSTALL_ROOT and not install_root.is_relative_to(INSTALL_ROOT / "test"):
        raise RuntimeError("Only the formal E installation or its E test fixtures are supported")
    user = install_root / "data/user-data/User"
    native = user / "globalStorage/octocode.octocode/octocode.db"
    state = user / "globalStorage/state.vscdb"
    patches = []
    targets = []
    counts = {}
    with closing(sqlite3.connect(native.as_uri() + "?mode=ro", uri=True)) as db:
        for table, column in NATIVE_COLUMNS:
            count = 0
            for rowid, old in db.execute(f'SELECT rowid, "{column}" FROM "{table}"'):
                new = relocated(old, install_root)
                if new != old:
                    patches.append(("main", table, column, rowid, old, new))
                    targets.append(Path(new))
                    count += 1
            counts[f"{table}.{column}"] = count
    with closing(sqlite3.connect(state.as_uri() + "?mode=ro", uri=True)) as db:
        history_count = 0
        for rowid, old in db.execute("SELECT rowid, value FROM ItemTable WHERE key = ?", (DIRECTORY_HISTORY,)):
            history = json.loads(old)
            for entry in history["entries"]:
                value = entry["key"]
                new = relocated(value, install_root)
                if new != value:
                    entry["key"] = new
                    targets.append(Path(new))
                    history_count += 1
            if history_count:
                patches.append(("editor", "ItemTable", "value", rowid, old, json.dumps(history, ensure_ascii=False)))
        counts["terminal_directory_history_values"] = history_count
        secret_rows = db.execute("SELECT count(*) FROM ItemTable WHERE key LIKE 'secret://%'").fetchone()[0]
    plan = {
        "mode": "apply" if apply else "dry-run",
        "changed_counts": counts,
        "changed_rows": len(patches),
        "missing_targets": sum(not p.exists() for p in targets),
        "targets_outside_physical_install": sum(not contained(p, install_root) for p in targets),
        "databases_outside_physical_install": sum(not contained(p, install_root) for p in (native, state)),
        "secret_rows_skipped": secret_rows,
    }
    if not apply:
        return plan
    if install_root.resolve() != install_root:
        raise RuntimeError("Installation root must be a physical E directory before applying path relocation")
    if any(plan[k] for k in ("missing_targets", "targets_outside_physical_install", "databases_outside_physical_install")):
        raise RuntimeError("Copy physical runtime directories to E and verify every target before applying path relocation")
    with closing(sqlite3.connect(native)) as db, db:
        db.execute("ATTACH DATABASE ? AS editor", (str(state),))
        db.execute("BEGIN IMMEDIATE")
        for schema, table, column, rowid, old, new in patches:
            changed = db.execute(
                f'UPDATE {schema}."{table}" SET "{column}" = ? WHERE rowid = ? AND "{column}" IS ?',
                (new, rowid, old),
            ).rowcount
            actual = db.execute(f'SELECT "{column}" FROM {schema}."{table}" WHERE rowid = ?', (rowid,)).fetchone()
            if changed != 1 or actual != (new,):
                raise RuntimeError("Concurrent change or read-back mismatch; transaction rolled back")
    return plan


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-root", type=Path, default=INSTALL_ROOT)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(json.dumps(migrate(args.install_root, args.apply), indent=2))
