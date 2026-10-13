if not __debug__:
    raise RuntimeError('This verification requires Python assertions; do not use -O/-OO or PYTHONOPTIMIZE')

import datetime, json, pathlib, time, urllib.request
root = pathlib.Path.home() / 'llmserver/servers/omlx/runtime'
key = json.loads((root / 'settings.json').read_text())['auth']['api_key']
reference = '\n'.join(f'Record {i}: sample value {i % 97}.' for i in range(1800))
body = {'model': 'qwen38-flash-next', 'messages': [{'role': 'user', 'content': reference + '\nIgnore the reference records for this answer. What is 17 times 19? Reply with the integer only.'}], 'max_tokens': 512, 'thinking_budget': 128, 'chat_template_kwargs': {'enable_thinking': True}}
request = urllib.request.Request('http://127.0.0.1:8000/v1/chat/completions', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
started = time.monotonic()
with opener.open(request, timeout=240) as response:
    result = json.load(response)
message = result['choices'][0]['message']
assert (message.get('content') or '').strip() == '323', 'Wrong long-context answer'
assert result['usage']['prompt_tokens'] > 8192
assert message.get('reasoning_content') or message.get('reasoning'), 'Thinking output absent'
report = {'checkedAt': datetime.datetime.now().astimezone().isoformat(), 'seconds': round(time.monotonic() - started, 2), 'usage': result['usage'], 'answer': message['content'], 'thinkingPresent': True, 'finishReason': result['choices'][0]['finish_reason']}
(root / 'long-context-verification.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report))
