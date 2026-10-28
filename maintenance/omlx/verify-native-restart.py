import hashlib
import json
import os
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

app = Path('/Applications/oMLX.app')
runtime = Path.home() / 'llmserver/servers/omlx/runtime'
settings = json.loads((runtime / 'settings.json').read_text())
before = {name: hashlib.sha256((runtime / name).read_bytes()).digest() for name in ('settings.json', 'model_settings.json', 'model_profiles.json')}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
headers = {'Authorization': 'Bearer ' + settings['auth']['api_key']}
origin = 'http://127.0.0.1:' + str(settings['server'].get('port', 8000))

def request(route):
    with opener.open(urllib.request.Request(origin + route, headers=headers), timeout=10) as response:
        return json.load(response)

status = request('/api/status')
assert status['version'] == '0.7.1.dev2'
assert status['active_requests'] == 0 and status['waiting_requests'] == 0
rows = subprocess.check_output(['ps', '-axo', 'uid=,pid=,comm='], text=True).splitlines()
owned = [row.split(None, 2) for row in rows if row.strip().endswith(str(app / 'Contents/MacOS/oMLX'))]
assert len(owned) == 1 and int(owned[0][0]) == os.getuid()
old_pid = int(owned[0][1])
print(json.dumps({'phase': 'before_stop', 'app_pid': old_pid, 'active_requests': 0}), flush=True)
subprocess.run([str(app / 'Contents/MacOS/omlx-cli'), 'stop', '--timeout', '60'], check=True, capture_output=True)
os.kill(old_pid, signal.SIGTERM)
deadline = time.monotonic() + 30
while True:
    try:
        os.kill(old_pid, 0)
    except ProcessLookupError:
        break
    assert time.monotonic() < deadline, 'Native app did not stop'
    time.sleep(1)
subprocess.run(['open', '-g', '-a', str(app)], check=True, capture_output=True)
started = time.monotonic()
deadline = started + 240
while True:
    try:
        status = request('/api/status')
        health = request('/health')
        if status['version'] == '0.7.1.dev2' and 'glm53' in status['loaded_models'] and health['status'] == 'healthy':
            break
    except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError):
        pass
    assert time.monotonic() < deadline, 'Pinned model did not become healthy'
    time.sleep(2)
assert all(hashlib.sha256((runtime / name).read_bytes()).digest() == digest for name, digest in before.items())
print(json.dumps({'cold_app_restart': True, 'model_loaded': 'glm53', 'backend_version': status['version'], 'ready_seconds': round(time.monotonic() - started, 2), 'settings_unchanged': True, 'cache_reuse_test': 'pending'}), flush=True)
