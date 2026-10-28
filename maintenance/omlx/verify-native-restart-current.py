"""Restart a reviewed native LaunchAgent without changing its version or settings.

Keep activate-bounded-indexer-fix.py beside this script. No inference is submitted.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import socket
import time
import urllib.request

spec = importlib.util.spec_from_file_location(
    "bounded_indexer_activation", Path(__file__).with_name("activate-bounded-indexer-fix.py"))
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def wait_backend_down(port):
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                pass
        except ConnectionRefusedError:
            return
        except (TimeoutError, ConnectionError, OSError):
            pass
        time.sleep(.2)
    raise RuntimeError("Native backend port did not close; refusing to restart the GUI")


def healthy(service):
    with service.opener.open(urllib.request.Request(service.origin + "/health", headers=service.headers), timeout=5) as response:
        health = json.load(response)
    if health.get("status") != "healthy":
        raise RuntimeError("Native backend did not report healthy")


def verify_restart(service=native):
    if not __debug__:
        raise RuntimeError("Restart verification requires assertions; do not use Python optimization")
    service.domain = f"gui/{os.getuid()}"
    configuration = json.loads((service.runtime / "settings.json").read_text())
    port = configuration["server"]["port"]
    service.headers = {"Authorization": "Bearer " + configuration["auth"]["api_key"]}
    service.origin = "http://127.0.0.1:" + str(port)
    original_agent = service.agent.read_bytes()
    agent_settings = plistlib.loads(original_agent)
    wrapper = service.patch / "python-with-bounded-indexer"
    if agent_settings.get("ProgramArguments") != [str(service.app / "Contents/MacOS/oMLX")]:
        raise RuntimeError("Unexpected native LaunchAgent program")
    if agent_settings.get("EnvironmentVariables", {}).get("OMLX_PYTHON_OVERRIDE") != str(wrapper):
        raise RuntimeError("Current LaunchAgent does not select the reviewed bounded-indexer override")
    if service.run("launchctl", "getenv", "OMLX_PYTHON_OVERRIDE").strip():
        raise RuntimeError("Unexpected global Python override")
    manifest = json.loads((service.patch / "manifest.json").read_text())
    if set(manifest) != {"memory_monitor.py", "language.py"}:
        raise RuntimeError("Unexpected current hotfix scope")
    paths = [service.runtime / name for name in ("settings.json", "model_settings.json", "model_profiles.json")]
    paths += [service.agent, wrapper] + [service.patch / name for name in ("manifest.json", "sitecustomize.py", "memory_monitor.py", "language.py")]
    baseline = {path: hashlib.sha256(path.read_bytes()).digest() for path in paths}
    service.run("codesign", "--verify", "--deep", "--strict", str(service.app))
    if service.run(str(wrapper), "-c", "import os; print(os.environ['OCTOCODE_OMLX_PREFLIGHT_FIX'])").strip() != "20261025":
        raise RuntimeError("Reviewed import hook did not validate")
    before = service.status()
    if before.get("version") not in native.SUPPORTED_VERSIONS or before.get("active_requests") != 0 or before.get("waiting_requests") != 0:
        raise RuntimeError("Current native service must be pinned and idle before restart")
    loaded, old_pid = service.job_state()
    if not loaded or not old_pid:
        raise RuntimeError("Cannot identify the current managed GUI process")
    stop_requested = ready = False
    try:
        live = service.status()
        if live.get("active_requests") != 0 or live.get("waiting_requests") != 0:
            raise RuntimeError("Requests arrived before restart; native service was left running")
        stop_requested = True
        service.control("stop")
        wait_backend_down(port)
        service.run("launchctl", "bootout", service.domain + "/" + service.label)
        service.wait_gui_exit(old_pid)
        if service.agent.read_bytes() != original_agent:
            raise RuntimeError("LaunchAgent changed during restart; refusing a different configuration")
        started = time.monotonic()
        service.run("launchctl", "bootstrap", service.domain, str(service.agent))
        service.wait_ready()
        healthy(service)
        loaded, new_pid = service.job_state()
        if not loaded or not new_pid or new_pid == old_pid:
            raise RuntimeError("A new managed GUI process was not confirmed")
        ready = True
        if any(hashlib.sha256(path.read_bytes()).digest() != expected for path, expected in baseline.items()):
            raise RuntimeError("Configuration, LaunchAgent or reviewed override changed during restart")
        service.run("codesign", "--verify", "--deep", "--strict", str(service.app))
        if service.run(str(wrapper), "-c", "import os; print(os.environ['OCTOCODE_OMLX_PREFLIGHT_FIX'])").strip() != "20261025":
            raise RuntimeError("Reviewed import hook did not validate after restart")
        after = service.status()
        if after.get("version") != before["version"] or "glm53" not in after.get("loaded_models", []):
            raise RuntimeError("Pinned native model was not confirmed after restart")
        result = {"native_restart": True, "version": after["version"], "old_gui_pid": old_pid, "new_gui_pid": new_pid,
                  "ready_seconds": round(time.monotonic() - started, 2), "configuration_unchanged": True,
                  "configuration_sha256": {path.name: baseline[path].hex() for path in paths[:3]},
                  "launch_agent_unchanged": True, "override_unchanged": True, "signature_valid": True,
                  "loaded_model": "glm53", "inference_after_restart": "pending", "cache_reuse_after_restart": "pending"}
        print(json.dumps(result), flush=True)
        return result
    except BaseException:
        if stop_requested and not ready:
            if service.agent.read_bytes() != original_agent:
                raise RuntimeError("Restart failed and LaunchAgent changed; no configuration was overwritten")
            loaded, pid = service.job_state()
            if loaded and pid and service.process_alive(pid):
                service.control("start")
            else:
                if loaded:
                    service.run("launchctl", "bootout", service.domain + "/" + service.label)
                service.wait_gui_exit(pid or old_pid)
                service.run("launchctl", "bootstrap", service.domain, str(service.agent))
            service.wait_ready()
            healthy(service)
        raise


if __name__ == "__main__":
    verify_restart()
