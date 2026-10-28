"""Prepare the hash-reviewed 0.7.3 dev1/dev2 M3 fix; never alter the signed App."""
import ast
import difflib
import hashlib
import json
from pathlib import Path
import sys

EXPECTED = {
    "memory_monitor.py": "ae2d4f474fb2292ab5b060ee6f0bdaf9f3e5a63ec18eafbb5bf15145c464b9cc",
    "language.py": "3ecf82957e5b434d415b534065281c49ac58b2f3413e6636b3c4768aed6e8fea",
}


def prepare(source: Path, destination: Path) -> dict:
    originals = {name: (source / name).read_bytes() for name in EXPECTED}
    for name, contents in originals.items():
        if hashlib.sha256(contents).hexdigest() != EXPECTED[name]:
            raise ValueError(f"Unreviewed vendor: {name}")
    replacements = {
        "memory_monitor.py": (
            "                self.index_n_heads * query_tokens * pooled * 4\n",
            "                # Four 512-row fallback temporaries plus retained reduced scores.\n"
            "                (4 * self.index_n_heads * min(query_tokens, 512)\n"
            "                 + 2 * query_tokens) * pooled * 4\n",
        ),
        "language.py": (
            "                        axis=2,\n                    )\n                valid_candidates = (\n",
            "                        axis=2,\n                    )\n"
            "                    # Release the head-score tile before building the next lazy graph.\n"
            "                    mx.eval(index_scores)\n"
            "                    del head_scores\n"
            "                valid_candidates = (\n",
        ),
    }
    prepared = {}
    for name, (old, new) in replacements.items():
        text = originals[name].decode("utf-8")
        if text.count(old) != 1:
            raise ValueError(f"Unexpected vendor seam: {name}")
        updated = text.replace(old, new, 1)
        ast.parse(updated)
        prepared[name] = updated
    destination.mkdir(parents=True, exist_ok=False)
    manifest = {}
    for name, text in prepared.items():
        contents = text.encode("utf-8")
        (destination / name).write_bytes(contents)
        (destination / (name + ".patch")).write_text("".join(difflib.unified_diff(
            originals[name].decode("utf-8").splitlines(True), text.splitlines(True),
            fromfile="vendor/" + name, tofile="patched/" + name)), encoding="utf-8")
        manifest[name] = {"vendor": EXPECTED[name], "patched": hashlib.sha256(contents).hexdigest()}
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


if __name__ == "__main__":
    print(json.dumps(prepare(*map(Path, sys.argv[1:3]))))
