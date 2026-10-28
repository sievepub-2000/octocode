"""Exercise the real route-preflight helper without importing MLX."""
import ast
import asyncio
import logging
from pathlib import Path
import sys
import time
import unittest
from typing import Any


def load_helper(path):
    tree = ast.parse(Path(path).read_text(encoding="utf-8"))
    fn = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef)
              and n.name == "_run_scheduler_preflight_with_cleanup_retry")
    scope = dict(Any=Any, asyncio=asyncio, time=time,
                 _PREFLIGHT_CLEANUP_WAIT_TIMEOUT_S=4,
                 _PREFLIGHT_CLEANUP_POLL_INTERVAL_S=.05,
                 _preflight_logger=logging.getLogger("test"))
    exec(compile(ast.Module(body=[fn], type_ignores=[]), str(path), "exec"), scope)
    return scope[fn.name]


class Scheduler:
    def __init__(self, cached=214558):
        self.cached = cached
        self.calls = []

    def route_preflight_cache_credit(self, tokens):
        assert len(tokens) == 215182
        return self.cached, 3 * 1024**3 if self.cached else 0

    def preflight_eviction_request(self, **kwargs):
        self.calls.append(kwargs)
        return None

    def preflight_or_raise(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs.get("cached_tokens", 0) == 0:
            raise ValueError("prefill_memory_exceeded")


class CacheCreditTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if "HELPER" not in globals():
            raise unittest.SkipTest("Historical route helper requires an explicitly supplied reviewed base.py")

    def test_cached_long_conversation_is_priced_with_restore_memory(self):
        scheduler = Scheduler()
        asyncio.run(HELPER(scheduler, num_prompt_tokens=215182,
                          request_id="fixture", eviction_callback=None,
                          prompt_token_ids=[1] * 215182))
        self.assertEqual(len(scheduler.calls), 2)
        for call in scheduler.calls:
            self.assertEqual(call["cached_tokens"], 214558)
            self.assertEqual(call["cache_restore_bytes"], 3 * 1024**3)

    def test_cache_miss_still_rejects(self):
        with self.assertRaisesRegex(ValueError, "prefill_memory_exceeded"):
            asyncio.run(HELPER(Scheduler(0), num_prompt_tokens=215182,
                              request_id="fixture", eviction_callback=None,
                              prompt_token_ids=[1] * 215182))

    def test_nontext_request_retains_full_guard(self):
        with self.assertRaisesRegex(ValueError, "prefill_memory_exceeded"):
            asyncio.run(HELPER(Scheduler(), num_prompt_tokens=215182,
                              request_id="fixture", eviction_callback=None))


if __name__ == "__main__":
    if len(sys.argv) > 1 and not sys.argv[1].startswith("-"):
        HELPER = load_helper(sys.argv.pop(1))
    unittest.main()
