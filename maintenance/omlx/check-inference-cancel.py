"""Verify a disconnected streaming client releases its model request."""
import datetime, json, pathlib, time, urllib.request

root = pathlib.Path.home() / 'llmserver/servers/omlx/runtime'
key = json.loads((root / 'settings.json').read_text())['auth']['api_key']
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
headers = {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}
def status():
    with http.open(urllib.request.Request('http://127.0.0.1:8000/api/status', headers=headers), timeout=10) as response:
        return json.load(response)
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
while True:
    current = status()
    if not current['active_requests'] and not current['waiting_requests']:
        break
    assert time.monotonic() - started < 30, 'Disconnected request remains active'
    time.sleep(0.5)
result = {'checkedAt': datetime.datetime.now().astimezone().isoformat(), 'cancelReleasedSeconds': round(time.monotonic() - started, 2), 'active': current['active_requests'], 'waiting': current['waiting_requests']}
(root / 'inference-cancel-check.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
