import os, pathlib, plistlib, subprocess
root = pathlib.Path.home() / 'llmserver/servers/omlx/runtime'
subprocess.run(['python3', str(root / 'check-dev-update.py')], check=True)
subprocess.run(['python3', str(root / 'update-dev.py')], check=True)
label = 'app.omlx.dev-updater'
domain = f'gui/{os.getuid()}'
plist = pathlib.Path.home() / 'Library/LaunchAgents' / (label + '.plist')
plist.parent.mkdir(parents=True, exist_ok=True)
(root / 'logs').mkdir(parents=True, exist_ok=True)
settings = {'Label': label, 'ProgramArguments': ['/usr/bin/python3', str(root / 'update-dev.py')], 'StartInterval': 21600, 'RunAtLoad': True, 'ProcessType': 'Background', 'StandardOutPath': str(root / 'logs/dev-update.log'), 'StandardErrorPath': str(root / 'logs/dev-update-error.log')}
plist.write_bytes(plistlib.dumps(settings))
subprocess.run(['launchctl', 'bootout', domain + '/' + label], capture_output=True)
subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
print('User Dev update service registered; checks every 6 hours')
