"""Prepare reviewable source overrides; never modify the signed application."""
import ast
import difflib
import hashlib
import json
import re
from pathlib import Path
import sys

source, destination = map(Path, sys.argv[1:3])
destination.mkdir(parents=True, exist_ok=False)
manifest = {}
EXPECTED_VENDOR = {
    "base.py": "c26b0e8acd9ce44bc66be585b7a257d8291474e99d8dbad73ad4902020ef32a4",
    "vlm.py": "40523763959a484e515c9bb924d3f7838867411ec90967b2f292881d682caf69",
    "scheduler.py": "50232ebe9981686fda9ee309e1a026f7e0d0bee49f02641233b34f3709ffbb8d",
    "memory_monitor.py": "3983191f57888ab9d7b6a546410a78cb5a849f1280dc01e7826db14d9500ee3e",
    "language.py": "1c5cc2a04eaca11c60deafe687f6d712bb08284229ad713bc72db6c696151cdb",
}


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError("Unexpected vendor source; re-review this patch")
    return text.replace(old, new, 1)


for name in ("base.py", "vlm.py", "scheduler.py", "memory_monitor.py", "language.py"):
    if hashlib.sha256((source / name).read_bytes()).hexdigest() != EXPECTED_VENDOR[name]:
        raise RuntimeError(f"Unreviewed vendor version: {name}")
    original = (source / name).read_text(encoding="utf-8")
    text = original
    if name == "base.py":
        text = replace_once(text, "    executor: Any | None = None,\n",
                            "    executor: Any | None = None,\n"
                            "    prompt_token_ids: list[int] | None = None,\n")
        text = replace_once(text, "    while True:\n        eviction_request = scheduler.preflight_eviction_request(",
                            "    while True:\n"
                            "        credit = {}\n"
                            "        if prompt_token_ids is not None:\n"
                            "            lookup = scheduler.route_preflight_cache_credit\n"
                            "            if executor is None:\n"
                            "                cached, restore_bytes = lookup(prompt_token_ids)\n"
                            "            else:\n"
                            "                cached, restore_bytes = await asyncio.get_running_loop().run_in_executor(\n"
                            "                    executor, lookup, prompt_token_ids\n"
                            "                )\n"
                            "            credit = dict(cached_tokens=cached, cache_restore_bytes=restore_bytes)\n"
                            "        eviction_request = scheduler.preflight_eviction_request(")
        start = text.index("async def _run_scheduler_preflight_with_cleanup_retry(")
        end = text.index("\n\n@dataclass", start)
        helper = text[start:end]
        helper = re.sub(r"(?m)^([ ]+)num_prompt_tokens=num_prompt_tokens,\n",
                        lambda m: m[0] + m[1] + "**credit,\n", helper)
        text = text[:start] + helper + text[end:]
    elif name == "vlm.py":
        start = text.index("    async def _preflight_or_raise_with_eviction(")
        end = text.index("\n    @property", start)
        helper = text[start:end]
        helper = replace_once(helper, "        request_id: str | None,\n",
                              "        request_id: str | None,\n"
                              "        prompt_token_ids: list[int] | None = None,\n")
        helper = replace_once(helper, "            num_prompt_tokens=num_prompt_tokens,\n",
                              "            num_prompt_tokens=num_prompt_tokens,\n"
                              "            prompt_token_ids=prompt_token_ids,\n")
        text = text[:start] + helper + text[end:]
        start = text.index("    async def preflight_chat(")
        end = text.index("    async def preflight_completion(", start)
        helper = text[start:end]
        helper = replace_once(helper, "            num_tokens = len(self._tokenizer.encode(prompt))",
                              "            prompt_token_ids = self._tokenizer.encode(prompt)\n"
                              "            num_tokens = len(prompt_token_ids)")
        helper = replace_once(helper, "            num_prompt_tokens=num_tokens,\n",
                              "            num_prompt_tokens=num_tokens,\n"
                              "            prompt_token_ids=prompt_token_ids if not images and not videos\n"
                              "                and not any(isinstance(m.get('content'), list) for m in messages) else None,\n")
        text = text[:start] + helper + text[end:]
    elif name == "memory_monitor.py":
        text = replace_once(text,
                            "                self.index_n_heads * query_tokens * pooled * 4\n",
                            "                # M3 override: fallback scores materialize one 512-row tile.\n"
                            "                # Reserve four head-sized temporaries plus retained score outputs.\n"
                            "                (4 * self.index_n_heads * min(query_tokens, 512)\n"
                            "                 + 2 * query_tokens) * pooled * 4\n")
    elif name == "language.py":
        text = replace_once(text,
                            "                        axis=2,\n                    )\n                valid_candidates = (\n",
                            "                        axis=2,\n                    )\n"
                            "                    # Release each head-score tile before building the next lazy graph.\n"
                            "                    mx.eval(index_scores)\n"
                            "                    del head_scores\n"
                            "                valid_candidates = (\n")
    else:
        method = '''    def route_preflight_cache_credit(self, tokens: list[int]) -> tuple[int, int]:
        """Price text prefix reuse, including RAM needed to restore SSD state.

        The request restores and validates the real blocks again before its
        normal admission and per-chunk guards; a stale match cannot bypass them.
        """
        cache = self.block_aware_cache
        monitor = self.memory_monitor
        if cache is None or monitor is None or self._model_has_unreconstructible_cache():
            return 0, 0
        blocks, matched = cache.paged_cache.get_computed_blocks(tokens)
        if matched >= len(tokens) and blocks:
            matched -= blocks[-1].token_count
        matched = max(0, min(matched, len(tokens) - 1))
        if not matched:
            return 0, 0
        restore = int(monitor.estimate_resident_kv_bytes(matched, chunk_tokens=1))
        return matched, max(0, restore)

'''
        text = replace_once(text, "    def preflight_or_raise(\n",
                            method + "    def preflight_or_raise(\n")
        for function, following in (("preflight_or_raise", "preflight_eviction_request"),
                                    ("preflight_eviction_request", "_preflight_safety_rejection")):
            start = text.index("    def " + function + "(")
            end = text.index("    def " + following + "(", start)
            helper = text[start:end]
            helper = replace_once(helper, "        cached_tokens: int = 0,\n",
                                  "        cached_tokens: int = 0,\n"
                                  "        cache_restore_bytes: int = 0,\n")
            helper = replace_once(helper,
                                  "        current = self._current_usage_bytes(refresh_mlx_active=False)",
                                  "        current = self._current_usage_bytes(refresh_mlx_active=False)\n"
                                  "        current += max(0, int(cache_restore_bytes))")
            text = text[:start] + helper + text[end:]
    ast.parse(text)
    (destination / name).write_text(text, encoding="utf-8")
    (destination / (name + ".patch")).write_text("".join(difflib.unified_diff(
        original.splitlines(True), text.splitlines(True),
        fromfile="vendor/" + name, tofile="patched/" + name)), encoding="utf-8")
    manifest[name] = dict(vendor=hashlib.sha256((source / name).read_bytes()).hexdigest(),
                          patched=hashlib.sha256((destination / name).read_bytes()).hexdigest())
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest))
