import hashlib
import json
import os
from pathlib import Path
import plistlib
import signal
import subprocess
import time
import urllib.request

base = Path.home() / "llmserver/servers/omlx"
patch = base / "maintenance-20261020/preflight-fix"
runtime = base / "runtime"
app = Path("/Applications/oMLX.app")
resources = app / "Contents/Resources"
python_home = resources / "Python/cpython-3.11"
framework = resources / "Python/framework-mlx-base/lib/python3.11/site-packages"
agent = Path.home() / "Library/LaunchAgents/local.omlx.gui-autostart.plist"
backup = patch.parent / "gui-autostart-before.plist"
settings = json.loads((runtime / "settings.json").read_text())
assert settings["memory"]["memory_guard_custom_ceiling_gb"] == 240
headers = {"Authorization": "Bearer " + settings["auth"]["api_key"]}
origin = "http://127.0.0.1:" + str(settings["server"]["port"])
hashes = {name: hashlib.sha256((runtime / name).read_bytes()).hexdigest()
          for name in ("settings.json", "model_settings.json", "model_profiles.json")}


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def status():
    with urllib.request.urlopen(urllib.request.Request(
            origin + "/api/status", headers=headers), timeout=5) as response:
        return json.load(response)


def stop():
    run(str(app / "Contents/MacOS/omlx-cli"), "stop", "--timeout", "60")
    expected = str(app / "Contents/MacOS/oMLX")
    for line in run("ps", "-axo", "pid=,comm=").splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and parts[1] == expected:
            os.kill(int(parts[0]), signal.SIGTERM)
    for _ in range(60):
        rows = run("ps", "-axo", "comm=").splitlines()
        if expected not in rows and "omlx-server" not in rows:
            return
        time.sleep(1)
    raise RuntimeError("Owned native processes did not exit normally")


assert not backup.exists(), "Activation already started; inspect before retrying"
live = status()
assert live["active_requests"] == live["waiting_requests"] == 0
assert live["version"] == "0.7.1.dev2"
run("codesign", "--verify", "--deep", "--strict", str(app))
old_override = subprocess.run(["launchctl", "getenv", "OMLX_PYTHON_OVERRIDE"],
                              capture_output=True, text=True).stdout.strip()
assert not old_override, "An existing override needs review"
backup.write_bytes(agent.read_bytes())
backup.chmod(0o600)
wrapper = patch / "python-with-preflight-fix"
wrapper.write_text(
    "#!/bin/sh\n"
    f"export PYTHONHOME='{python_home}'\n"
    f"export PYTHONPATH='{patch}:{resources}:{framework}'\n"
    "export PYTHONDONTWRITEBYTECODE=1\n"
    f"exec '{python_home}/bin/python3' \"$@\"\n")
wrapper.chmod(0o700)
startup = patch / "start-native-app"
startup.write_text("#!/bin/sh\nset -eu\n"
                   f"/bin/launchctl setenv OMLX_PYTHON_OVERRIDE '{wrapper}'\n"
                   f"exec /usr/bin/open --env OMLX_PYTHON_OVERRIDE='{wrapper}' -a '{app}'\n")
startup.chmod(0o700)
changed = False
try:
    assert status()["active_requests"] == 0
    stop()
    configuration = plistlib.loads(backup.read_bytes())
    configuration["ProgramArguments"] = [str(startup)]
    agent.write_bytes(plistlib.dumps(configuration))
    changed = True
    run(str(startup))
    for _ in range(180):
        time.sleep(1)
        try:
            live = status()
            if "glm53" in live["loaded_models"]:
                break
        except Exception:
            continue
    else:
        raise RuntimeError("Patched native app did not load GLM")
    for name, expected in hashes.items():
        assert hashlib.sha256((runtime / name).read_bytes()).hexdigest() == expected
    run("codesign", "--verify", "--deep", "--strict", str(app))
    print(json.dumps(dict(healthy=True, version=live["version"],
                          configuration_unchanged=True, vendor_signature_valid=True,
                          override=str(wrapper))), flush=True)
except BaseException:
    if changed:
        stop()
        agent.write_bytes(backup.read_bytes())
        run("launchctl", "unsetenv", "OMLX_PYTHON_OVERRIDE")
        run("open", "-a", str(app))
    raise
