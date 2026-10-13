"""One-time migration: Host memory rows -> the harness memory file.

OctoCode used to keep two memory systems. Memory now lives with the harness
(Markdown + index under harness-runtime/memory). This copies anything the Host
store still holds into the global memory file so nothing is lost, and is safe to
re-run: entries already present are skipped.

usage: python migrate-host-memory.py <globalStorage dir> [--apply]
       (default globalStorage: the installed product's)
"""
from __future__ import annotations

import sqlite3
import re
import sys
import time
from pathlib import Path

DEFAULT = Path(r"D:\Program Files\OctoCode\data\user-data\User\globalStorage\octocode.octocode")
HEADER = "## Imported from the Host memory store"


def rows(db: Path):
    if not db.exists():
        return []
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        con.execute("select 1 from memory_items limit 1")
    except sqlite3.Error:
        return []
    out = []
    for content, scope, created in con.execute(
        "select content, scope, created_at from memory_items where valid = 1 order by created_at"
    ):
        text = (content or "").strip()
        if text:
            day = time.strftime("%Y-%m-%d", time.localtime((created or 0) / 1000))
            out.append((f"{text}", scope or "global", day))
    return out


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else DEFAULT
    apply = "--apply" in sys.argv
    memory = root / "harness-runtime" / "memory" / "MEMORY.md"
    items = rows(root / "octocode.db")
    if not items:
        print("nothing to migrate")
        return 0
    existing = memory.read_text(encoding="utf-8") if memory.exists() else ""
    # Match each complete source body rather than splitting on dated bullets:
    # those bullets can also occur verbatim inside a multiline body. Prefer the
    # longest bodies so their internal bullets are not counted as separate rows.
    dated = r"- \[\d{4}-\d{2}-\d{2}\] "
    matches = []
    for text in {item[0].replace("\r\n", "\n").replace("\r", "\n") for item in items}:
        pattern = rf"(?m)^{dated}{re.escape(text)}(?=\n+(?:{dated}|\Z)|\Z)"
        matches.extend((match.start(), match.end(), text) for match in re.finditer(pattern, existing))
    seen = set()
    spans = []
    for start, end, text in sorted(matches, key=lambda match: match[1] - match[0], reverse=True):
        if not any(start < prior_end and end > prior_start for prior_start, prior_end in spans):
            seen.add(text)
            spans.append((start, end))
    new = []
    for item in items:
        identity = item[0].replace("\r\n", "\n").replace("\r", "\n")
        if identity not in seen:
            new.append(item)
            seen.add(identity)
    print(f"{len(items)} memory rows, {len(new)} not yet in {memory}")
    for text, scope, day in new:
        print(f"  [{day}] ({scope}) {text[:90]}")
    if not (apply and new):
        print("(dry run; pass --apply to write)" if new else "")
        return 0
    memory.parent.mkdir(parents=True, exist_ok=True)
    body = existing.rstrip("\n")
    if HEADER not in body:
        body += f"\n\n{HEADER}\n"
    body += "".join(f"\n- [{day}] {text}\n" for text, _scope, day in new)
    memory.write_text(body + "\n", encoding="utf-8", newline="")
    print(f"appended {len(new)} entries to {memory}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
