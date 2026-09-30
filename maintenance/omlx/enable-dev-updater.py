import pathlib, plistlib, subprocess
root = pathlib.Path.home() / 'llmserver/servers/omlx/runtime'
subprocess.run(['python3', str(root / 'check-dev-update.py')], check=True)
subprocess.run(['python3', str(root / 'update-dev.py')], check=True)
label = 'app.omlx.dev-updater'
plist = pathlib.Path.home() / 'Library/LaunchAgents' / (label + '.plist')
settings = {'Label': label, 'ProgramArguments': ['/usr/bin/python3', str(root / 'update-dev.py')], 'StartInterval': 21600, 'RunAtLoad': True, 'ProcessType': 'Background', 'StandardOutPath': str(root / 'logs/dev-update.log'), 'StandardErrorPath': str(root / 'logs/dev-update-error.log')}
plist.write_bytes(plistlib.dumps(settings))
subprocess.run(['launchctl', 'bootout', 'gui/501/' + label], capture_output=True)
subprocess.run(['launchctl', 'bootstrap', 'gui/501', str(plist)], check=True)
print('User Dev update service registered; checks every 6 hours')
