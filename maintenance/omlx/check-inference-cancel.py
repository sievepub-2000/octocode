"""Verify a disconnected streaming client releases its model request."""
if not __debug__:
    raise RuntimeError('This verification requires Python assertions; do not use -O/-OO or PYTHONOPTIMIZE')

import datetime, json, pathlib, time, urllib.request

root = pathlib.Path.home() / 'llmserver/servers/omlx/runtime'
key = json.loads((root / 'settings.json').read_text())['auth']['api_key']
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}
def status(timeout=10):
    with http.open(urllib.request.Request('http://127.0.0.1:8000/api/status', headers=headers), timeout=timeout) as response:
        return json.load(response)


def await_idle(timeout=30):
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        assert remaining > 0, 'Disconnected request remains active at deadline'
        current = status(timeout=min(10, remaining))
        # An idle response received after the deadline is not a timely release.
        remaining = deadline - time.monotonic()
        assert remaining > 0, 'Disconnected request exceeded cancellation deadline'
        if not current['active_requests'] and not current['waiting_requests']:
            return current
        time.sleep(min(0.5, remaining))


before = status()
assert not before['active_requests'] and not before['waiting_requests'], 'Model is busy'
body = {'model': 'qwen38-flash-next', 'messages': [{'role': 'user', 'content': 'Explain a detailed proof that there are infinitely many prime numbers, then discuss five alternative proofs.'}], 'stream': True, 'max_tokens': 4096, 'thinking_budget': 2048, 'chat_template_kwargs': {'enable_thinking': True}}
request = urllib.request.Request('http://127.0.0.1:8000/v1/chat/completions', data=json.dumps(body).encode(), headers=headers)
with http.open(request, timeout=120) as response:
    while True:
        line = response.readline()
        assert line, 'Stream ended before cancellation'
        if line.startswith(b'data: ') and line.strip() != b'data: [DONE]':
            event = json.loads(line[6:])
            choices = event.get('choices', [])
            if choices and any(choices[0].get('delta', {}).get(k) for k in ('content', 'reasoning_content', 'reasoning')):
                break
started = time.monotonic()
current = await_idle()
result = {'checkedAt': datetime.datetime.now().astimezone().isoformat(), 'cancelReleasedSeconds': round(time.monotonic() - started, 2), 'active': current['active_requests'], 'waiting': current['waiting_requests']}
(root / 'inference-cancel-check.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
