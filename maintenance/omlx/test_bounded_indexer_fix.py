import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from prepare_bounded_indexer_fix import prepare


class PreparationTest(unittest.TestCase):
    def test_rejects_unreviewed_vendor_without_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "memory_monitor.py").write_text("changed")
            (root / "language.py").write_text("changed")
            with self.assertRaisesRegex(ValueError, "Unreviewed vendor"):
                prepare(root, root / "output")
            self.assertFalse((root / "output").exists())

    def test_materializes_only_fallback_and_preserves_remaining_code(self):
        memory = "value = (\n                self.index_n_heads * query_tokens * pooled * 4\n)\n"
        language = """class Indexer:
    def score(self):
        if enabled:
            if fallback:
                if index_scores is None:
                    index_scores = mx.sum(
                        weights * head_scores,
                        axis=2,
                    )
                valid_candidates = (
                    None
                )
"""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = {"memory_monitor.py": memory, "language.py": language}
            for name, value in values.items():
                (root / name).write_bytes(value.encode())
            expected = {name: hashlib.sha256(value.encode()).hexdigest() for name, value in values.items()}
            with patch("prepare_bounded_indexer_fix.EXPECTED", expected):
                result = prepare(root, root / "output")
            updated = (root / "output" / "language.py").read_text()
            self.assertEqual(updated.count("mx.eval(index_scores)"), 1)
            self.assertEqual(updated.count("del head_scores"), 1)
            self.assertIn("min(query_tokens, 512)", (root / "output" / "memory_monitor.py").read_text())
            self.assertEqual(set(result), set(values))
            for name, value in values.items():
                self.assertEqual((root / name).read_text(), value)


if __name__ == "__main__":
    unittest.main()
