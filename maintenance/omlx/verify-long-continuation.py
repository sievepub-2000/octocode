"""Exercise full-history continuation against the native local oMLX service."""
import hashlib
import json
from pathlib import Path
import time
import urllib.request
import urllib.error
import uuid

runtime = Path.home() / "llmserver/servers/omlx/runtime"
settings = json.loads((runtime / "settings.json").read_text())
headers = {"Authorization": "Bearer " + settings["auth"]["api_key"],
           "Content-Type": "application/json"}
origin = "http://127.0.0.1:" + str(settings["server"]["port"])
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open(urllib.request.Request(origin + "/api/status", headers=headers),
                 timeout=10) as response:
    status = json.load(response)
assert status["active_requests"] == status["waiting_requests"] == 0
rows = 15300
text = (
    f"{uuid.uuid4()} OctoCode synthetic cold benchmark before {rows}.\n"
    + "".join(f"Row {i:06d}: verify the source and report the build status.\n"
              for i in range(rows))
    + "\nReply with exactly 128 repetitions of the word ready, separated by spaces."
)
messages = [{"role": "user", "content": text}]
original_digest = hashlib.sha256(text.encode()).hexdigest()
for turn in range(2):
    start = time.perf_counter()
    payload = {"model": "glm53", "messages": messages, "temperature": 0,
               "max_tokens": 256, "stream": True,
               "stream_options": {"include_usage": True},
               "chat_template_kwargs": {"enable_thinking": False}}
    request = urllib.request.Request(
        origin + "/v1/chat/completions", headers=headers,
        data=json.dumps(payload).encode())
    parts, reasoning = [], []
    usage = None
    try:
        response = opener.open(request, timeout=900)
    except urllib.error.HTTPError as error:
        print(json.dumps({"turn": turn + 1, "http_status": error.code,
                          "error": error.read(65536).decode("utf-8", "replace")}), flush=True)
        raise
    with response:
        assert response.status == 200
        for raw in response:
            if not raw.startswith(b"data: ") or raw[6:].strip() == b"[DONE]":
                continue
            frame = json.loads(raw[6:])
            assert not frame.get("error"), frame.get("error")
            usage = frame.get("usage") or usage
            for choice in frame.get("choices", []):
                delta = choice.get("delta", {})
                parts.append(delta.get("content") or "")
                reasoning.append(delta.get("reasoning_content") or "")
    assert usage and usage["prompt_tokens"] >= 237052
    if turn == 0:
        assert usage.get("prompt_tokens_details", {}).get("cached_tokens", 0) == 0, "Cold input reused cached tokens"
    assert hashlib.sha256(messages[0]["content"].encode()).hexdigest() == original_digest
    content = "".join(parts)
    reasoning_text = "".join(reasoning)
    assert content or reasoning_text, "The model returned no assistant output"
    print(json.dumps({"turn": turn + 1, "http_status": 200,
                      "elapsed_seconds": round(time.perf_counter() - start, 3),
                      "usage": usage, "original_history_intact": True,
                      "message_count": len(messages),
                      "visible_characters": len(content),
                      "reasoning_characters": len(reasoning_text)}), flush=True)
    if turn == 0:
        assistant = {"role": "assistant", "content": content}
        if reasoning_text:
            assistant["reasoning_content"] = reasoning_text
        messages.extend([assistant, {"role": "user",
                                    "content": "Continue this same conversation. Reply ready."}])
