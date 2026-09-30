#!/usr/bin/env python3
"""Install signed Dev releases only when existing overrides remain compatible."""
import argparse, datetime, fcntl, hashlib, json, os, pathlib, plistlib
import shutil, subprocess, tempfile, time, urllib.request

ROOT = pathlib.Path.home() / 'llmserver/servers/omlx/runtime'
APP = pathlib.Path('/Applications/oMLX.app')
FIX = ROOT / 'hotfixes/dev4-warnings'
LABEL = f'gui/{os.getuid()}/app.omlx.user'
PLIST = pathlib.Path.home() / 'Library/LaunchAgents/app.omlx.user.plist'
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout

def version(app):
    return plistlib.loads((app / 'Contents/Info.plist').read_bytes())['CFBundleShortVersionString']

def compatible(app):
    manifest = json.loads((FIX / 'manifest.json').read_text())
    for name, hashes in manifest.items():
        for file, expected in [(app / 'Contents/Resources/omlx' / name, hashes['vendor']), (FIX / name, hashes['patched'])]:
            if hashlib.sha256(file.read_bytes()).hexdigest() != expected:
                raise RuntimeError(f'Override needs review before updating: {name}; current installation retained')

def status():
    key = json.loads((ROOT / 'settings.json').read_text())['auth']['api_key']
    request = urllib.request.Request('http://127.0.0.1:8000/api/status', headers={'Authorization': 'Bearer ' + key})
    with HTTP.open(request, timeout=10) as response:
        return json.load(response)

def verify_completion():
    key = json.loads((ROOT / 'settings.json').read_text())['auth']['api_key']
    body = {'model': 'qwen38-flash-next', 'messages': [{'role': 'user', 'content': 'Call release_probe with value 7.'}], 'tools': [{'type': 'function', 'function': {'name': 'release_probe', 'description': 'Verify a release', 'parameters': {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}}}], 'tool_choice': {'type': 'function', 'function': {'name': 'release_probe'}}, 'max_tokens': 1024, 'thinking_budget': 128, 'chat_template_kwargs': {'enable_thinking': True}}
    request = urllib.request.Request('http://127.0.0.1:8000/v1/chat/completions', data=json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    with HTTP.open(request, timeout=120) as response:
        message = json.load(response)['choices'][0]['message']
    calls = message.get('tool_calls', [])
    if not calls or calls[0]['function']['name'] != 'release_probe' or json.loads(calls[0]['function']['arguments']) != {'value': 7}:
        raise RuntimeError('Release tool-call probe failed')

def await_model():
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            # This existing check authenticates privately and verifies the selected model settings.
            info = run('python3', str(ROOT / 'mtp-check.py'))
            model = json.loads(info.splitlines()[0])
            settings = json.loads(info.split('SETTINGS ', 1)[1])
            if model['loaded'] and settings['mtp_enabled'] and settings['temperature'] == 0.85:
                verify_completion()
                return
        except (OSError, ValueError, KeyError, subprocess.CalledProcessError):
            pass
        time.sleep(2)
    raise RuntimeError('Updated service failed model/MTP readiness check')

def install(candidate):
    compatible(candidate)
    run('codesign', '--verify', '--deep', '--strict', str(candidate))
    signature = subprocess.run(['codesign', '-dv', '--verbose=2', str(candidate)], capture_output=True, text=True, check=True).stderr
    if 'TeamIdentifier=PSK5Q5T46L' not in signature:
        raise RuntimeError('Unexpected signing identity')
    run('spctl', '--assess', '--type', 'execute', str(candidate))
    stage = APP.with_name('oMLX-update.app')
    old = APP.with_name('oMLX-update-rollback.app')
    if stage.exists() or old.exists():
        raise RuntimeError('An unfinished update exists; inspect it before retrying')
    run('ditto', str(candidate), str(stage))
    stopped = False
    replaced = False
    try:
        stopped = True
        run('python3', str(ROOT / 'omlx-service.py'), 'stop')
        run('launchctl', 'bootout', LABEL)
        if subprocess.run(['lsof', '-nP', '-iTCP:8000', '-sTCP:LISTEN', '-t'], stdout=subprocess.DEVNULL).returncode == 0:
            raise RuntimeError('Port 8000 still occupied after shutdown')
        APP.rename(old)
        stage.rename(APP)
        replaced = True
        run('launchctl', 'bootstrap', f'gui/{os.getuid()}', str(PLIST))
        await_model()
    except Exception:
        if stopped:
            subprocess.run(['launchctl', 'bootout', LABEL], capture_output=True)
        if replaced:
            APP.rename(stage)
            old.rename(APP)
        elif old.exists() and not APP.exists():
            old.rename(APP)
        if stopped:
            run('launchctl', 'bootstrap', f'gui/{os.getuid()}', str(PLIST))
            await_model()
        raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    # The new App is verified. A cleanup failure must not restore a partly deleted old App.
    shutil.rmtree(old)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    with (ROOT / 'dev-update.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        compatible(APP)
        request = urllib.request.Request('https://api.github.com/repos/jundot/omlx/releases?per_page=20', headers={'User-Agent': 'oMLX-dev-updater'})
        with urllib.request.urlopen(request, timeout=30) as response:
            releases = json.load(response)
        latest = next(r for r in releases if not r['draft'] and 'dev' in r['tag_name'].lower())
        result = {'checkedAt': datetime.datetime.now().astimezone().isoformat(), 'installed': version(APP), 'latest': latest['tag_name'], 'status': 'current'}
        if latest['tag_name'].lstrip('v') != version(APP):
            result['status'] = 'available'
            if not args.check:
                current = status()
                if current['active_requests'] or current['waiting_requests']:
                    raise RuntimeError('Inference active; update deferred until next check')
                asset = next(a for a in latest['assets'] if a['name'].endswith('-macos26-27.dmg'))
                with tempfile.TemporaryDirectory(prefix='dev-update-', dir=ROOT / 'updates') as temp:
                    dmg = pathlib.Path(temp) / 'update.dmg'
                    proxy = urllib.request.getproxies().get('https')
                    run('curl', '--fail', '--location', '--connect-timeout', '20', '--max-time', '900', *(['--proxy', proxy] if proxy else []), '--output', str(dmg), asset['browser_download_url'])
                    if dmg.stat().st_size != asset['size'] or asset.get('digest') != 'sha256:' + hashlib.sha256(dmg.read_bytes()).hexdigest():
                        raise RuntimeError('Release digest mismatch')
                    mounted = plistlib.loads(subprocess.check_output(['hdiutil', 'attach', '-readonly', '-nobrowse', '-plist', str(dmg)]))
                    mount = next(pathlib.Path(e['mount-point']) for e in mounted['system-entities'] if 'mount-point' in e)
                    try:
                        candidate = mount / 'oMLX.app'
                        if version(candidate) != latest['tag_name'].lstrip('v'):
                            raise RuntimeError('Release version mismatch')
                        install(candidate)
                    finally:
                        run('hdiutil', 'detach', str(mount))
                result['status'] = 'updated'
        (ROOT / 'dev-update-status.json').write_text(json.dumps(result, indent=2))
        print(json.dumps(result))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        (ROOT / 'dev-update-status.json').write_text(json.dumps({'checkedAt': datetime.datetime.now().astimezone().isoformat(), 'status': 'failed', 'error': str(error)}, indent=2))
        raise
