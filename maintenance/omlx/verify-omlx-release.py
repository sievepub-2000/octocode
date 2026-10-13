if not __debug__:
    raise RuntimeError('This verification requires Python assertions; do not use -O/-OO or PYTHONOPTIMIZE')

import argparse, datetime, json, pathlib, subprocess, urllib.request

def validate_since(value):
    try:
        parsed = datetime.datetime.strptime(value, '%Y-%m-%d %H:%M:%S')
    except ValueError as error:
        raise argparse.ArgumentTypeError('Expected a valid local timestamp YYYY-MM-DD HH:MM:SS') from error
    if parsed.strftime('%Y-%m-%d %H:%M:%S') != value:
        raise argparse.ArgumentTypeError('Expected timestamp YYYY-MM-DD HH:MM:SS')
    return value

parser = argparse.ArgumentParser()
parser.add_argument('--since', required=True, type=validate_since, help='Local server timestamp YYYY-MM-DD HH:MM:SS')
args = parser.parse_args()
root = pathlib.Path.home() / 'llmserver/servers/omlx/runtime'
lines = [line for line in (root / 'logs/server.log').read_text().splitlines() if line[:19] >= args.since and line[:4].isdigit()]
issues = [line for line in lines if ' - WARNING - ' in line or ' - ERROR - ' in line or ' - CRITICAL - ' in line]
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open('http://127.0.0.1:8000/health', timeout=10) as response:
    health = json.load(response)
pids = subprocess.check_output(['lsof', '-nP', '-iTCP:8000', '-sTCP:LISTEN', '-t'], text=True).splitlines()
assert len(set(pids)) == 1
owner = subprocess.check_output(['ps', '-p', pids[0], '-o', 'user='], text=True).strip()
assert owner == 'zillafan'
assert health['status'] == 'healthy' and health['engine_pool']['model_count'] == 1 and health['engine_pool']['loaded_count'] == 1
result = {'checkedAt': datetime.datetime.now().astimezone().isoformat(), 'since': args.since, 'health': health, 'listenerPid': int(pids[0]), 'owner': owner, 'issues': issues, 'settledUnload': any('Unloaded model:' in s and '(settled)' in s for s in lines), 'mtpEnabledInLogs': any('Lightning MTP enabled' in s for s in lines), 'flashAttentionPatched': any('FA-256 steel attention patch applied' in s for s in lines)}
(root / 'release-verification.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
assert not issues, 'Unexpected warnings/errors in the specified verification interval'
assert result['settledUnload'] and result['mtpEnabledInLogs'] and result['flashAttentionPatched']
