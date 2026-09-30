import datetime, hashlib, json, os, pathlib, shutil, subprocess
root = pathlib.Path.home() / 'llmserver/servers/omlx/runtime'
subprocess.run(['codesign', '--verify', '--deep', '--strict', '/Applications/oMLX.app'], check=True)
verification = json.loads((root / 'release-verification.json').read_text())
assert not verification['issues'] and verification['settledUnload'] and verification['mtpEnabledInLogs']
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
