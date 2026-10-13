if not __debug__:
    raise RuntimeError('This verification requires Python assertions; do not use -O/-OO or PYTHONOPTIMIZE')

import datetime, hashlib, json, os, pathlib, shutil, subprocess


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate verification report field')
        result[key] = value
    return result


def reject_nonfinite_number(value):
    raise ValueError('Invalid verification report number')


def validate_release_verification(verification):
    required = {'checkedAt', 'since', 'health', 'listenerPid', 'owner', 'issues',
                'settledUnload', 'mtpEnabledInLogs', 'flashAttentionPatched'}
    if type(verification) is not dict or set(verification) != required:
        raise ValueError('Invalid verification report schema')
    if type(verification['issues']) is not list or verification['issues']:
        raise ValueError('Verification report contains issues or invalid issue data')
    for field in ('settledUnload', 'mtpEnabledInLogs', 'flashAttentionPatched'):
        if verification[field] is not True:
            raise ValueError('Verification report has an incomplete release gate')
    health = verification['health']
    if type(health) is not dict or health.get('status') != 'healthy':
        raise ValueError('Invalid verification health status')
    pool = health.get('engine_pool')
    if type(pool) is not dict:
        raise ValueError('Invalid verification engine pool')
    for field in ('model_count', 'loaded_count'):
        if type(pool.get(field)) is not int or pool[field] != 1:
            raise ValueError('Invalid verification model count')
    if type(verification['listenerPid']) is not int or verification['listenerPid'] <= 0:
        raise ValueError('Invalid verification listener PID')
    if type(verification['owner']) is not str or verification['owner'] != 'zillafan':
        raise ValueError('Invalid verification listener owner')
    if type(verification['checkedAt']) is not str or type(verification['since']) is not str:
        raise ValueError('Invalid verification timestamps')
    try:
        checked_at = datetime.datetime.fromisoformat(verification['checkedAt'])
        since = datetime.datetime.strptime(verification['since'], '%Y-%m-%d %H:%M:%S')
    except ValueError:
        raise ValueError('Invalid verification timestamps') from None
    if checked_at.tzinfo is None or since.strftime('%Y-%m-%d %H:%M:%S') != verification['since']:
        raise ValueError('Invalid verification timestamp format')
    # since is the same producer's local wall time, not UTC.
    if checked_at.replace(tzinfo=None) < since:
        raise ValueError('Verification interval ends before its start')


root = pathlib.Path.home() / 'llmserver/servers/omlx/runtime'
subprocess.run(['codesign', '--verify', '--deep', '--strict', '/Applications/oMLX.app'], check=True)
verification = json.loads((root / 'release-verification.json').read_text(encoding='utf-8'),
                          object_pairs_hook=reject_duplicate_keys,
                          parse_constant=reject_nonfinite_number)
validate_release_verification(verification)
backup = root / 'backups'
current = backup / 'current-config'
current.mkdir(parents=True, exist_ok=True)
os.chmod(current, 0o700)
files = [root / 'settings.json', root / 'model_settings.json', pathlib.Path.home() / 'Library/LaunchAgents/app.omlx.user.plist', pathlib.Path.home() / 'Library/LaunchAgents/app.omlx.dev-updater.plist']
manifest = []
for source in files:
    dest = current / source.name
    shutil.copy2(source, dest)
    os.chmod(dest, 0o600)
    assert dest.read_bytes() == source.read_bytes()
    manifest.append({'file': dest.name, 'sha256': hashlib.sha256(dest.read_bytes()).hexdigest()})
(current / 'manifest.json').write_text(json.dumps(manifest, indent=2))
removed = []
for entry in list(backup.iterdir()) + list(root.glob('model_settings.before-mtp-*.json')):
    if entry == current:
        continue
    assert entry.parent in (backup, root) and entry.resolve().is_relative_to(root.resolve())
    if entry.is_dir() and not entry.is_symlink():
        shutil.rmtree(entry)
    else:
        entry.unlink()
    removed.append(str(entry.relative_to(root)))
result = {'checkedAt': datetime.datetime.now().astimezone().isoformat(), 'removed': removed, 'retained': 'backups/current-config', 'signatureVerified': True}
(root / 'version-cleanup.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result))
