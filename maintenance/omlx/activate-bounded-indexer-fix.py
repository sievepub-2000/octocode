"""Activate only the hash-reviewed 0.7.3 dev indexer fix, with native rollback."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import socket
import subprocess
import time
import urllib.request

base = Path.home() / "llmserver/servers/omlx"
patch = base / "maintenance-20261025/indexer-review-dev2"
runtime = base / "runtime"
app = Path("/Applications/oMLX.app")
resources = app / "Contents/Resources"
agent = Path.home() / "Library/LaunchAgents/local.omlx.gui-autostart.plist"
backup = patch / "gui-autostart-before.plist"
socket_path = Path.home() / "Library/Application Support/oMLX/control.sock"
label = "local.omlx.gui-autostart"
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
SUPPORTED_VERSIONS = ("0.7.3.dev1", "0.7.3.dev2")


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def status():
    with opener.open(urllib.request.Request(origin + "/api/status", headers=headers), timeout=5) as response:
        return json.load(response)


def control(command):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(60)
        connection.connect(str(socket_path))
        connection.sendall((json.dumps({"command": command}) + "\n").encode())
        result = bytearray()
        while b"\n" not in result:
            chunk = connection.recv(4096)
            if not chunk:
                break
            result.extend(chunk)
            if len(result) > 65536:
                raise RuntimeError("Oversized native control response")
        response = json.loads(result)
        if not response.get("ok"):
            raise RuntimeError("Native control operation failed")
        return response


def wait_ready():
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        try:
            live = status()
            if live["version"] in SUPPORTED_VERSIONS and "glm53" in live["loaded_models"]:
                return
        except (OSError, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError("Native GLM did not become ready")


def job_state():
    result = subprocess.run(["launchctl", "print", domain + "/" + label],
                            capture_output=True, text=True)
    if result.returncode:
        return False, None
    match = re.search(r"(?m)^\s*pid\s*=\s*(\d+)\s*$", result.stdout)
    return True, int(match[1]) if match else None


def process_alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def wait_gui_exit(pid):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        loaded, _ = job_state()
        if not loaded and not process_alive(pid):
            return
        time.sleep(.2)
    raise RuntimeError("Native GUI job/process has not exited; refusing a racing bootstrap")


def write_agent(contents):
    mode = agent.stat().st_mode & 0o777
    temporary = agent.with_suffix(".plist.pending")
    temporary.write_bytes(contents)
    temporary.chmod(mode)
    temporary.replace(agent)


def activate():
    global domain, headers, origin
    if not __debug__:
        raise RuntimeError("Activation requires assertions; do not use Python optimization")
    domain = f"gui/{os.getuid()}"
    configuration = json.loads((runtime / "settings.json").read_text())
    headers = {"Authorization": "Bearer " + configuration["auth"]["api_key"]}
    origin = "http://127.0.0.1:" + str(configuration["server"]["port"])
    hashes = {name: hashlib.sha256((runtime / name).read_bytes()).digest()
              for name in ("settings.json", "model_settings.json", "model_profiles.json")}
    live = status()
    assert live["version"] in SUPPORTED_VERSIONS
    assert live["active_requests"] == live["waiting_requests"] == 0
    run("codesign", "--verify", "--deep", "--strict", str(app))
    original = agent.read_bytes()
    settings = plistlib.loads(original)
    assert settings["ProgramArguments"] == [str(app / "Contents/MacOS/oMLX")]
    assert not settings.get("EnvironmentVariables", {}).get("OMLX_PYTHON_OVERRIDE")
    assert not run("launchctl", "getenv", "OMLX_PYTHON_OVERRIDE").strip()
    loaded, original_pid = job_state()
    if not loaded or not original_pid:
        raise RuntimeError("Cannot identify the managed GUI process before activation")
    if backup.exists():
        if backup.read_bytes() != original:
            raise RuntimeError("Existing backup differs from the current unmodified LaunchAgent")
    else:
        backup.write_bytes(original)
        backup.chmod(0o600)
    wrapper = patch / "python-with-bounded-indexer"
    wrapper.write_text(
        "#!/bin/sh\nset -eu\n"
        f"export PYTHONPATH='{patch}:{resources}:{resources}/Python/framework-mlx-base/lib/python3.11/site-packages'\n"
        "export PYTHONDONTWRITEBYTECODE=1\n"
        f"exec '{resources}/Python/cpython-3.11/bin/python3' \"$@\"\n")
    wrapper.chmod(0o700)
    assert run(str(wrapper), "-c", "import os; print(os.environ['OCTOCODE_OMLX_PREFLIGHT_FIX'])").strip() == "20261025"
    stop_requested = agent_changed = False
    try:
        assert status()["active_requests"] == status()["waiting_requests"] == 0
        stop_requested = True
        control("stop")
        run("launchctl", "bootout", domain + "/" + label)
        wait_gui_exit(original_pid)
        settings.setdefault("EnvironmentVariables", {})["OMLX_PYTHON_OVERRIDE"] = str(wrapper)
        agent_changed = True
        write_agent(plistlib.dumps(settings))
        run("launchctl", "bootstrap", domain, str(agent))
        wait_ready()
        assert plistlib.loads(agent.read_bytes())["EnvironmentVariables"]["OMLX_PYTHON_OVERRIDE"] == str(wrapper)
        for name, expected in hashes.items():
            assert hashlib.sha256((runtime / name).read_bytes()).digest() == expected
        run("codesign", "--verify", "--deep", "--strict", str(app))
        print(json.dumps({"activated": True, "version": live["version"],
                          "configuration_unchanged": True, "signature_valid": True,
                          "long_context_acceptance": "pending"}), flush=True)
    except BaseException:
        if stop_requested:
            if agent.read_bytes() != original:
                write_agent(original)
            loaded, pid = job_state()
            if loaded and not agent_changed:
                control("start")
            else:
                if loaded:
                    try:
                        control("stop")
                    except (OSError, RuntimeError, ValueError):
                        pass
                    run("launchctl", "bootout", domain + "/" + label)
                wait_gui_exit(pid or original_pid)
                run("launchctl", "bootstrap", domain, str(agent))
            wait_ready()
        raise


if __name__ == "__main__":
    activate()
