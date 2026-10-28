import importlib.util
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("relocate_runtime_paths", Path(__file__).with_name("relocate-runtime-paths.py"))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class RuntimePathRelocationTests(unittest.TestCase):
    def setUp(self):
        test_root = migration.INSTALL_ROOT / "test/relocate-runtime-paths"
        test_root.mkdir(parents=True, exist_ok=True)
        self.fixture = tempfile.TemporaryDirectory(dir=test_root)
        self.addCleanup(self.fixture.cleanup)
        self.root = Path(self.fixture.name) / "installed"
        self.native = self.root / "data/user-data/User/globalStorage/octocode.octocode/octocode.db"
        self.native.parent.mkdir(parents=True)
        self.state = self.native.parent.parent / "state.vscdb"
        (self.root / "workspace/chat").mkdir(parents=True)
        self.old = r"\\?\D:\gpt-workspace\octocode\runtime\workspace\chat"
        with closing(sqlite3.connect(self.native)) as db, db:
            db.executescript("""
                CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace TEXT, title TEXT);
                CREATE TABLE projects (workspace TEXT, directory TEXT);
                CREATE TABLE artifacts (path TEXT);
                CREATE TABLE events (payload BLOB);
            """)
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", ("managed", self.old, self.old))
            db.execute("INSERT INTO sessions VALUES (?, ?, ?)", ("source", "D:/gpt-workspace/octocode/source", self.old))
            db.execute("INSERT INTO projects VALUES (?, ?)", ("D:/Program Files/OctoCode", self.old))
            db.execute("INSERT INTO artifacts VALUES (?)", ("D:/gpt-workspace/octocode/runtime-other/file",))
            db.execute("INSERT INTO events VALUES (?)", (b"credentials and prompt D:\\gpt-workspace\\octocode\\runtime",))
        self.secret = b"\x00credentials\xff D:\\gpt-workspace\\octocode\\runtime"
        with closing(sqlite3.connect(self.state)) as db, db:
            db.execute("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)")
            db.executemany("INSERT INTO ItemTable VALUES (?, ?)", [
                (migration.DIRECTORY_HISTORY, json.dumps({"entries": [{"key": self.old, "value": {"prompt": self.old}}]})),
                ("secret://preserved", self.secret),
                ("terminal.history.entries.commands", self.old),
            ])

    def test_exact_prefix_boundary_and_extended_paths(self):
        self.assertEqual(migration.relocated(self.old, self.root), str(self.root / "workspace/chat"))
        for value in ("D:/gpt-workspace/octocode/runtime-other/file", "D:/gpt-workspace/octocode/source", "prompt: " + self.old):
            self.assertEqual(migration.relocated(value, self.root), value)

    def test_dry_run_then_apply_preserves_other_data_and_is_idempotent(self):
        before = self.native.read_bytes(), self.state.read_bytes()
        plan = migration.migrate(self.root)
        self.assertEqual(plan["changed_rows"], 4)
        self.assertEqual((self.native.read_bytes(), self.state.read_bytes()), before)
        migration.migrate(self.root, apply=True)
        with closing(sqlite3.connect(self.native)) as db, db:
            self.assertEqual(db.execute("SELECT workspace, title FROM sessions WHERE id='managed'").fetchone(), (str(self.root / "workspace/chat"), self.old))
            self.assertEqual(db.execute("SELECT workspace FROM sessions WHERE id='source'").fetchone()[0], "D:/gpt-workspace/octocode/source")
            self.assertEqual(db.execute("SELECT payload FROM events").fetchone()[0], b"credentials and prompt D:\\gpt-workspace\\octocode\\runtime")
        with closing(sqlite3.connect(self.state)) as db, db:
            self.assertEqual(db.execute("SELECT value FROM ItemTable WHERE key='secret://preserved'").fetchone()[0], self.secret)
            self.assertEqual(db.execute("SELECT value FROM ItemTable WHERE key='terminal.history.entries.commands'").fetchone()[0], self.old)
            history = json.loads(db.execute("SELECT value FROM ItemTable WHERE key=?", (migration.DIRECTORY_HISTORY,)).fetchone()[0])
            self.assertEqual(history["entries"][0], {"key": str(self.root / "workspace/chat"), "value": {"prompt": self.old}})
        self.assertEqual(migration.migrate(self.root)["changed_rows"], 0)

    def test_missing_target_aborts_before_any_write(self):
        (self.root / "workspace/chat").rmdir()
        before = self.native.read_bytes(), self.state.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "verify every target"):
            migration.migrate(self.root, apply=True)
        self.assertEqual((self.native.read_bytes(), self.state.read_bytes()), before)

    def test_transaction_rolls_back_both_databases_on_write_failure(self):
        with closing(sqlite3.connect(self.state)) as db, db:
            db.execute("CREATE TRIGGER refuse_update BEFORE UPDATE ON ItemTable BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            migration.migrate(self.root, apply=True)
        with closing(sqlite3.connect(self.native)) as db, db:
            self.assertEqual(db.execute("SELECT workspace FROM sessions WHERE id='managed'").fetchone()[0], self.old)


if __name__ == "__main__":
    unittest.main()
