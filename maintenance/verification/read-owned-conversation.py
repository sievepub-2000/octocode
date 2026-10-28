"""Read only the isolated acceptance session; never dump unrelated conversations."""
import json
from pathlib import Path
import sqlite3
import sys

session_id, after = sys.argv[1], int(sys.argv[2])
database = Path("E:/Program Files/octocode/data/user-data/User/globalStorage/octocode.octocode/octocode.db")
with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
    rows = db.execute(
        "SELECT sequence,kind,payload FROM events WHERE session_id=? AND sequence>? ORDER BY sequence",
        (session_id, after),
    ).fetchall()
result = {"cursor": after, "text": "", "errors": [], "usage": [], "toolEvents": 0}
for sequence, kind, raw in rows:
    result["cursor"] = sequence
    payload = json.loads(raw)
    if kind.startswith(("tool", "function_call")):
        result["toolEvents"] += 1
    if kind == "text":
        result["text"] += payload.get("data", "")
    elif kind in ("error", "agent.error"):
        result["errors"].append(payload.get("message", "Runtime error"))
    elif kind == "usage":
        result["usage"].append(payload.get("usage", {}))
    elif kind == "agent.finished":
        result["finished"] = payload
print(json.dumps(result))
