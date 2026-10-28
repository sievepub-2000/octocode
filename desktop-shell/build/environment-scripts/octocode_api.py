"""OctoCode daemon: an HTTP API, routines and goal loops for the OctoCode agent.

A FastAPI server that keeps running after the desktop window closes. Every run
goes through the OctoCode host (the same process the desktop uses), so fallback
models, stream rules and the reviewer apply to API, routine and goal runs too,
and memory is shared with the desktop.

    "$env:OCTOCODE_PYTHON_BASE" "$env:OCTOCODE_ENVIRONMENTS/scripts/octocode_api.py" --port 8765

Interactive docs: http://127.0.0.1:8765/docs

Environment:
    OCTOCODE_MODEL_API_KEY  key for the model endpoint (requests may pass their own)
    OCTOCODE_API_TOKEN      bearer token clients must send; required off loopback
    OCTOCODE_ROOT           install directory (default: two levels above this file)
    OCTOCODE_HARNESS / OCTOCODE_HOST  executables (default: the installed extension's)
    OCTOCODE_PROMPT_TEMPLATE  alternative system prompt template (evaluation)
    OCTOCODE_DAEMON_STATE   state directory (default harness-runtime/daemon); one per instance
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import json
import os
import re
import secrets
import sqlite3
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import uuid
import unicodedata
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from octocode_credentials import selected_model, context_window

ROOT = Path(os.environ.get("OCTOCODE_ROOT") or Path(__file__).absolute().parents[2])
STORE = ROOT / "data" / "user-data" / "User" / "globalStorage" / "octocode.octocode" / "harness-runtime"
# One state directory (and host database) per daemon instance: the host holds a
# single-instance lock on its database, so two daemons must not share one.
STATE = Path(os.environ.get("OCTOCODE_DAEMON_STATE") or STORE / "daemon")
TERMINAL = {"completed", "failed", "cancelled", "interrupted"}
STARTED = time.time()
STOP = threading.Event()
SERVER: uvicorn.Server | None = None
ACTIVE_SESSIONS: dict[str, dict] = {}
RECOVERY_PENDING: set[str] = set()
MONITOR_LOCK = threading.Lock()
DESKTOP_PID = int(os.environ.get("OCTOCODE_DESKTOP_PID", "0"))
DESKTOP_LOCK = threading.Lock()
# Cap on the parent-command line read by `watch_parent`. The only valid command is
# "stop\n" (5 bytes); the cap is generous enough to reject garbage without allowing
# an unbounded read on the stdin pipe (see test_parent_pipe.py).
MAX_COMMAND_BYTES = 32
RESOURCE_STREAK = 0
RESTART_REQUESTED = False
LAST_RESOURCE_RESTART = 0.0


def extension_binary(env_name: str, stem: str) -> Path:
    if os.environ.get(env_name):
        binary = Path(os.environ[env_name])
        if not binary.is_file():
            raise RuntimeError(f"{env_name} does not exist: {binary}")
        return binary
    name = f"{stem}.exe" if sys.platform == "win32" else stem
    found = sorted((ROOT / "data" / "extensions").glob(f"octocode.octocode-*/bin/*/{name}"), key=os.path.getmtime)
    if not found:
        raise RuntimeError(f"No {stem} under {ROOT / 'data' / 'extensions'}; set {env_name}.")
    return found[-1]


def last_app_model() -> dict:
    """Read the selected desktop profile; session proxy URLs expire with their task."""
    return selected_model(ROOT)


def bundled_mcp_servers() -> dict:
    """Use the same installation-wide MCP registry as desktop sessions."""
    settings = ROOT / "environments/tools/mcp/mcp_settings.json"
    if not settings.is_file():
        return {}
    def expand(value):
        if isinstance(value, str):
            return re.sub(r"\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}", lambda match: os.environ[match[1]], value)
        if isinstance(value, list):
            return [expand(item) for item in value]
        if isinstance(value, dict):
            return {key: expand(item) for key, item in value.items()}
        return value
    servers = json.loads(settings.read_text(encoding="utf-8-sig"))["mcpServers"]
    return {name: expand({key: server[key] for key in ("command", "args", "env") if key in server})
            for name, server in servers.items() if server.get("command") and not server.get("disabled")}


def isolated_mcp_servers(cwd: str) -> tuple[dict, Path | None]:
    """Give global MCP executables project-local configuration and data paths."""
    servers = bundled_mcp_servers()
    if not servers:
        return servers, None
    workspace = Path(cwd).resolve()
    parent = workspace / ".octocode" / "tool-copies"
    parent.mkdir(parents=True, exist_ok=True)
    if not parent.resolve().is_relative_to(workspace):
        raise ValueError("Tool copy path leaves the workspace")
    session = Path(tempfile.mkdtemp(prefix="daemon-", dir=parent))
    try:
        for name, server in servers.items():
            key = hashlib.sha256(f"mcp:{name}".encode()).hexdigest()[:16]
            copy = session / "mcp" / key
            (copy / "data").mkdir(parents=True)
            (copy / "config.json").write_text("{}\n", encoding="utf-8")
            (copy / "reference.json").write_text(json.dumps({
                "kind": "mcp", "name": name,
                "globalPath": str(ROOT / "environments/tools/mcp/mcp_settings.json"),
            }), encoding="utf-8")
            server["env"] = {**server.get("env", {}),
                             "OCTOCODE_PROJECT_TOOL_CONFIG": str(copy / "config.json"),
                             "OCTOCODE_PROJECT_TOOL_DATA": str(copy / "data")}
        return servers, session
    except BaseException:
        shutil.rmtree(session)
        raise


# ---------------------------------------------------------------- models

class ModelSpec(BaseModel):
    model: str | None = Field(None, description="Model id, e.g. qwen38-flash-next:instruct")
    base_url: str | None = Field(None, description="OpenAI-compatible base URL (comma-separated list = preference order)")
    api_key: str | None = Field(None, description="Key for this endpoint; defaults to OCTOCODE_MODEL_API_KEY")
    context_window: int | None = Field(None, ge=4096)
    thinking: Literal["disable", "low", "medium", "high"] | None = Field(None, description="Thinking tier for hybrid models")


class RunRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    cwd: str = Field(..., description="Existing working directory the agent may read and edit")
    session_id: str | None = Field(None, description="Continue this daemon session (with resume=true)")
    resume: bool = False
    max_turns: int = Field(60, ge=1, le=1000)
    permission_mode: Literal["review", "directory", "full"] = "directory"
    model: ModelSpec | None = None
    fallbacks: list[ModelSpec] = Field(default_factory=list, description="Tried in order on endpoint/context failures")
    review: bool = Field(True, description="Let the model check its finished answer against the tool evidence once")
    stream_rules: list[dict] | None = Field(None, description="Stream rules ({id, scope: text|tool_input, pattern, message}); omitted = built-in rules")
    wait: bool = Field(False, description="Block until the run ends and return the final state")


class RoutineRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    prompt: str = Field(..., min_length=1)
    cwd: str
    every_minutes: int | None = Field(None, ge=5, description="Run every N minutes")
    daily_at: str | None = Field(None, pattern=r"^\d{2}:\d{2}$", description="Run daily at HH:MM (local time)")
    continue_session: bool = Field(False, description="Resume one session each time instead of starting fresh")
    model: ModelSpec | None = None
    enabled: bool = True

    @field_validator("daily_at")
    @classmethod
    def valid_daily_time(cls, value: str | None) -> str | None:
        if value is not None:
            hour, minute = map(int, value.split(":"))
            if hour > 23 or minute > 59:
                raise ValueError("daily_at must be a valid local HH:MM time")
        return value


class GoalRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="What must be achieved")
    cwd: str
    check: str = Field(..., min_length=1, description="Shell command that exits 0 once the goal is met")
    check_timeout: int = Field(600, ge=10, le=7200)
    max_iterations: int = Field(6, ge=1, le=50)
    budget_minutes: int = Field(240, ge=5, le=24 * 60)
    model: ModelSpec | None = None


# ---------------------------------------------------------------- host client

class HostClient:
    """JSON-RPC over the host's stdio: one reader thread routes replies and events."""

    def __init__(self) -> None:
        STATE.mkdir(parents=True, exist_ok=True)
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        self.stderr = open(STATE / "host.stderr.log", "ab")
        process = None
        try:
            self.process = process = subprocess.Popen(
                [str(extension_binary("OCTOCODE_HOST", "octocode-host")), "--db", str(STATE / "daemon.db")],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, creationflags=flags,
            )
            self.lock = threading.Lock()
            self.pending: dict[int, tuple[threading.Event, list]] = {}
            self.listeners: dict[str, "Run"] = {}
            self.next_id = 0
            threading.Thread(target=self._read, daemon=True).start()
            time.sleep(0.5)
            if self.process.poll() is not None:
                raise RuntimeError(
                    f"octocode-host exited at start (code {self.process.returncode}); another daemon may be using "
                    f"{STATE} - give each instance its own OCTOCODE_DAEMON_STATE. See {STATE / 'host.stderr.log'}."
                )
        except BaseException:
            try:
                if process is not None:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired) as error:
                print(f"[daemon] failed host startup cleanup: {error}", file=sys.stderr, flush=True)
            finally:
                if process is not None:
                    for stream in (process.stdin, process.stdout):
                        if stream is not None:
                            stream.close()
                self.stderr.close()
            raise

    def _read(self) -> None:
        assert self.process.stdout
        for raw in self.process.stdout:
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if "kind" in message:
                run = self.listeners.get(message.get("task_id", ""))
                if run:
                    try:
                        run.accept(message["kind"], message.get("payload") or {})
                    except Exception as error:  # noqa: BLE001 - the reader must survive a bad event
                        print(f"[daemon] event handling failed for {run.id}: {error!r}", file=sys.stderr, flush=True)
                continue
            waiter = self.pending.pop(message.get("id"), None)
            if waiter:
                waiter[1].append(message)
                waiter[0].set()

    def call(self, method: str, params: dict, timeout: float = 180) -> dict:
        with self.lock:
            self.next_id += 1
            request_id = self.next_id
            done, box = threading.Event(), []
            self.pending[request_id] = (done, box)
            assert self.process.stdin
            self.process.stdin.write((json.dumps({"id": request_id, "method": method, "params": params}) + "\n").encode())
            self.process.stdin.flush()
        if not done.wait(timeout):
            self.pending.pop(request_id, None)
            raise RuntimeError(f"host did not answer {method}")
        reply = box[0]
        if reply.get("error"):
            raise RuntimeError(reply["error"].get("message", str(reply["error"])))
        return reply.get("result")


HOST: HostClient | None = None
HOST_LOCK = threading.Lock()


def host() -> HostClient:
    """The one host process. Created under a lock: the host holds a single-instance
    lock on its database, so a second process started by a racing thread exits at
    once, and requests sent to it would never be answered."""
    global HOST
    with HOST_LOCK:
        if HOST is None or HOST.process.poll() is not None:
            if HOST is not None:
                print(f"[daemon] host exited with {HOST.process.returncode}; restarting", file=sys.stderr, flush=True)
            HOST = HostClient()
        return HOST


# ---------------------------------------------------------------- runs

def provider_input(spec: ModelSpec | None) -> tuple[dict, str]:
    spec = spec or ModelSpec()
    try:
        model = {} if spec.model and spec.base_url else dict(last_app_model())
    except RuntimeError:
        raise HTTPException(400, "Configure an OpenAI-compatible model in OctoCode or pass model.model and model.base_url explicitly") from None
    base_url = spec.base_url or model.get("base_url")
    model_id = spec.model or model.get("model")
    if not base_url or not model_id:
        raise HTTPException(400, "No model configured: pick one in OctoCode once, or pass model.model and model.base_url.")
    key = spec.api_key or os.environ.get("OCTOCODE_MODEL_API_KEY") or model.get("api_key", "")
    provider = dict(model.get("provider") or {})
    provider.update({
        "apiProvider": "openai", "openAiBaseUrl": base_url, "openAiModelId": model_id, "openAiApiKey": key,
    })
    try:
        resolved_context = spec.context_window or context_window(provider)
    except RuntimeError:
        raise HTTPException(400, "The model must report its context window, or pass model.context_window explicitly; no lower default was applied") from None
    provider.update(autoContextWindow=False, modelContextWindow=resolved_context)
    if spec.thinking:
        provider.update(reasoningEffort=spec.thinking, enableReasoningEffort=spec.thinking != "disable", reasoningStyle="template")
    return provider, key


def materialize(spec: ModelSpec | None) -> dict:
    provider, key = provider_input(spec)
    route = host().call("provider.resolve", provider)
    return {**route["model"], "api_key": route["model"].get("api_key") or key}


class Run:
    def __init__(self, request: RunRequest, origin: str = "api"):
        self.id = str(uuid.uuid4())
        self.request = request
        self.origin = origin
        self.session_id = request.session_id
        self.task_id: str | None = None
        self.status = "running"
        self.events: list[dict] = []
        self.started = time.time()
        self.finished: float | None = None
        self.result: dict = {}
        self.done = threading.Event()
        self.tool_copy_dir: Path | None = None
        self.working_directory = request.cwd

    def accept(self, kind: str, payload: dict) -> None:
        self.events.append({"type": kind, **payload} if isinstance(payload, dict) else {"type": kind, "value": payload})
        if kind in ("agent.finished", "agent.error"):
            self.result = payload if isinstance(payload, dict) else {}
            if self.status == "running":
                self.status = "completed" if kind == "agent.finished" and self.result.get("success") else "failed"
            self.finished = time.time()
            host().listeners.pop(self.task_id or "", None)
            try:
                persist_run(self)
            finally:
                if self.tool_copy_dir:
                    try:
                        shutil.rmtree(self.tool_copy_dir)
                    except OSError as error:
                        print(f"[daemon] could not release project tool copy: {error}", file=sys.stderr, flush=True)
                    self.tool_copy_dir = None
                self.done.set()

    def summary(self, text: bool = True) -> dict:
        end = next((e for e in reversed(self.events) if e.get("type") == "end"), {})
        error = next((e for e in reversed(self.events) if e.get("type") == "error" and e.get("message")), {})
        out = {
            "run_id": self.id, "session_id": self.session_id, "task_id": self.task_id, "origin": self.origin,
            "status": self.status, "started": self.started, "finished": self.finished,
            "source_cwd": self.request.cwd, "working_directory": self.working_directory,
            "tool_calls": [e.get("toolName") for e in self.events if e.get("type") == "tool_call"],
            "supervisor": [{k: e.get(k) for k in ("action", "detail")} for e in self.events
                           if e.get("type") == "agent.supervisor" and e.get("action") != "attempt_started"],
            "usage": end.get("usage"), "attempts": self.result.get("attempts"),
            "error": (self.result.get("message") or error.get("message")) if self.status == "failed" else None,
        }
        if text:
            out["text"] = final_text(self.events)
        return out


def final_text(events: list[dict]) -> str:
    """The answer after the last tool call (earlier text is progress narration)."""
    last_tool = max((i for i, e in enumerate(events) if e.get("type") == "tool_call"), default=-1)
    return "".join(e.get("data", "") for e in events[last_tool + 1:] if e.get("type") == "text")


RUNS: dict[str, Run] = {}


def persist_run(run: Run) -> None:
    folder = STATE / "runs"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{run.id}.json").write_text(json.dumps({**run.summary(), "prompt": run.request.prompt}, ensure_ascii=False), encoding="utf-8")


def daemon_session_home(session_id: str) -> Path:
    """Keep compatible d-ID homes, accepting only portable single-directory IDs.

    Resolve existing links beneath the sessions parent; this does not protect
    against a malicious filesystem replacement between validation and use.
    """
    if (not isinstance(session_id, str) or not session_id or session_id in (".", "..")
            or session_id.endswith((".", " "))
            or any(c in '/\\<>:"|?*' or unicodedata.category(c) == "Cc" for c in session_id)):
        raise HTTPException(400, "Invalid daemon session directory ID")
    parent = STORE / "sessions"
    home = parent / f"d-{session_id}"
    try:
        resolved_home, resolved_parent = home.resolve(), parent.resolve()
        if resolved_home == resolved_parent or not resolved_home.is_relative_to(resolved_parent):
            raise HTTPException(400, "Daemon session directory escapes sessions storage")
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(400, "Invalid daemon session directory") from error
    return home


def start_run(request: RunRequest, origin: str = "api") -> Run:
    if not Path(request.cwd).is_dir():
        raise HTTPException(400, f"cwd does not exist: {request.cwd}")
    if request.resume and not request.session_id:
        raise HTTPException(400, "resume needs the session_id of an earlier run")
    if request.session_id is not None:
        daemon_session_home(request.session_id)
    busy = [r for r in RUNS.values() if r.session_id and r.session_id == request.session_id and r.status == "running"]
    if busy:
        raise HTTPException(409, f"Session {request.session_id} already has a running run {busy[0].id}")
    run = Run(request, origin)
    provider, _ = provider_input(request.model)
    try:
        if request.resume:
            session = host().call("session.get", {"id": request.session_id})
            workspace = session.get("workspace") if isinstance(session, dict) else None
            if not workspace or not Path(workspace).resolve(strict=True).samefile(Path(request.cwd).resolve(strict=True)):
                raise HTTPException(400, "Continuation source directory does not match the original session project")
            prepared = host().call("harness.continue", {"session_id": request.session_id, "prompt": request.prompt, "provider": provider})
        else:
            prepared = host().call("harness.prepare", {
                "session_id": request.session_id, "title": request.prompt[:120], "workspace": request.cwd,
                "prompt": request.prompt, "provider": provider,
            })
        run.session_id, run.task_id = prepared["session_id"], prepared["task_id"]
        session_home = daemon_session_home(run.session_id)
        # New hosts isolate cwd per conversation; older hosts omit this field.
        working_directory = prepared.get("working_directory") or request.cwd
        source = Path(request.cwd).resolve(strict=True)
        if prepared.get("working_directory"):
            encoded = base64.urlsafe_b64encode(run.session_id.encode("utf-8")).decode("ascii").rstrip("=")
            expected = source / ".octocode" / "sessions" / encoded
            actual = Path(working_directory).resolve(strict=True)
            # Windows native canonicalization returns \\?\ paths; compare file identity.
            if not actual.is_dir() or len(actual.parents) < 3 or not source.samefile(actual.parents[2]) or not actual.samefile(expected):
                raise HTTPException(400, "Prepared working directory does not belong to the requested project/session")
        run.working_directory = str(working_directory)
        prompt = request.prompt if Path(working_directory).resolve() == source else (
            request.prompt
            + "\n\n## Required file-path contract\n"
            + f"Selected source project (input root): {source.as_posix()}\n"
            + f"Isolated conversation cwd (output root): {Path(working_directory).resolve().as_posix()}\n"
            + "Use absolute source-project paths for filesystem read/list/search tool path arguments. "
            + f"A project-relative input must become {source.as_posix()}/<project-relative-input> before the tool call. "
            + "Relative tool paths resolve inside the isolated conversation cwd, not the selected source project. "
            + "Do not guess parent-relative paths or change cwd to the shared project. "
            + "This path contract takes precedence over task-local guidance suggesting relative input paths. "
            + "Keep conversation outputs in the isolated working directory. Existing tool permissions still apply.")
        model = {**prepared["route"]["model"]}
        model["api_key"] = model.get("api_key") or provider["openAiApiKey"]
        supervision = {"fallbacks": [materialize(spec) for spec in request.fallbacks]}
        if request.stream_rules is not None:
            supervision["stream_rules"] = request.stream_rules
        if request.review:
            supervision["advisor"] = {"model": model}
        host().listeners[run.task_id] = run
        RUNS[run.id] = run
        mcp_servers, run.tool_copy_dir = isolated_mcp_servers(run.working_directory)
        host().call("agent.run", {
            "task_id": run.task_id, "session_id": run.session_id,
            "executable": str(extension_binary("OCTOCODE_HARNESS", "octocode-harness")),
            "harness_home": str(session_home),
            "cwd": run.working_directory, "model": model, "prompt": prompt, "resume": request.resume,
            "max_turns": request.max_turns, "permission_profile": request.permission_mode,
            "supervision": supervision, "mcp_servers": mcp_servers,
        })
    except HTTPException:
        raise
    except Exception as error:  # noqa: BLE001 - reported to the client
        RUNS.pop(run.id, None)
        if run.tool_copy_dir:
            shutil.rmtree(run.tool_copy_dir)
        raise HTTPException(502, f"Could not start the run: {error}") from error
    session_home.mkdir(parents=True, exist_ok=True)
    persist_run(run)
    return run


# ---------------------------------------------------------------- routines and goals

def load_json(name: str) -> dict:
    try:
        data = json.loads((STATE / name).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise ValueError(f"Invalid state in {STATE / name}: expected object")
    return data


def save_json(name: str, data: dict) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    temporary = STATE / f"{name}.tmp"
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    temporary.replace(STATE / name)


STATE_LOCK = threading.Lock()


def next_due(routine: dict, after: datetime) -> str:
    if routine.get("every_minutes"):
        return (after + timedelta(minutes=routine["every_minutes"])).isoformat(timespec="seconds")
    hour, minute = map(int, routine["daily_at"].split(":"))
    due = after.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if due <= after:
        due += timedelta(days=1)
    return due.isoformat(timespec="seconds")


def available_resources() -> dict:
    disk = shutil.disk_usage(ROOT)
    result = {"disk_free_percent": round(100 * disk.free / disk.total, 1)}
    if sys.platform == "win32":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong),
                        ("total_physical", ctypes.c_ulonglong), ("available_physical", ctypes.c_ulonglong),
                        ("total_page", ctypes.c_ulonglong), ("available_page", ctypes.c_ulonglong),
                        ("total_virtual", ctypes.c_ulonglong), ("available_virtual", ctypes.c_ulonglong),
                        ("available_extended", ctypes.c_ulonglong)]
        memory = MemoryStatus()
        memory.length = ctypes.sizeof(memory)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)):
            result["memory_free_percent"] = round(100 * memory.available_physical / memory.total_physical, 1)
    return result


def update_resource_pressure(resources: dict, now: float) -> bool:
    """Ask for one graceful desktop restart after sustained critical pressure."""
    global RESOURCE_STREAK, RESTART_REQUESTED, LAST_RESOURCE_RESTART
    critical = resources.get("memory_free_percent", 100) < 5 or resources["disk_free_percent"] < 2
    RESOURCE_STREAK = RESOURCE_STREAK + 1 if critical else 0
    if RESOURCE_STREAK >= 3 and not RESTART_REQUESTED and now - LAST_RESOURCE_RESTART >= 600:
        RESTART_REQUESTED = True
        LAST_RESOURCE_RESTART = now
        save_json("resource-restart.json", {"last_requested": now})
    return RESTART_REQUESTED


def monitor_active_sessions() -> list[dict]:
    """Read the desktop's task database without opening a second writer/host."""
    with MONITOR_LOCK:
        return _read_active_sessions()


def _read_active_sessions() -> list[dict]:
    database = STORE.parent / "octocode.db"
    if not database.is_file():
        ACTIVE_SESSIONS.clear()
        RECOVERY_PENDING.clear()
        return []
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=2)) as connection:
        sessions = list(connection.execute("SELECT id,status,updated_at FROM sessions"))
        statuses = {session_id: status for session_id, status, _ in sessions}
        active = [session_id for session_id, status in statuses.items() if status == "running"]
        for session_id in active:
            state = ACTIVE_SESSIONS.setdefault(session_id, {"sequence": 0, "high_compactions": 0})
            encoded = base64.urlsafe_b64encode(session_id.encode()).decode().rstrip("=")
            config = STORE / "sessions" / f"s-{encoded}" / "config.toml"
            try:
                context_window = int(tomllib.loads(config.read_text(encoding="utf-8"))["model"]["octocode-selected"]["context_window"])
            except (OSError, KeyError, ValueError, tomllib.TOMLDecodeError):
                context_window = 0
            events = connection.execute(
                "SELECT sequence,kind,payload FROM events WHERE session_id=? AND sequence>? ORDER BY sequence",
                (session_id, state["sequence"]),
            )
            for sequence, kind, payload in events:
                state["sequence"] = sequence
                if kind == "auto_compact_completed":
                    state["awaiting_usage"] = True
                elif kind == "usage":
                    usage = json.loads(payload).get("usage", {})
                    used = sum(usage.get(key, 0) for key in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
                    state["context_percent"] = round(100 * used / context_window, 1) if context_window else None
                    if state.pop("awaiting_usage", False):
                        state["high_compactions"] = state["high_compactions"] + 1 if state["context_percent"] is not None and state["context_percent"] >= 90 else 0
            state["needs_new_session"] = state["high_compactions"] >= 3 and (state.get("context_percent") or 0) >= 90
        for session_id in list(ACTIVE_SESSIONS):
            if session_id not in active:
                del ACTIVE_SESSIONS[session_id]
        recent = int((time.time() - 300) * 1000)
        RECOVERY_PENDING.update(session_id for session_id, status, updated_at in sessions
                                if status == "interrupted" and updated_at >= recent)
        for session_id in list(RECOVERY_PENDING):
            if statuses.get(session_id) != "interrupted" or connection.execute(
                "SELECT 1 FROM events WHERE kind='harness.prepared' AND json_extract(payload,'$.handoff.source_session_id')=? LIMIT 1",
                (session_id,),
            ).fetchone():
                RECOVERY_PENDING.remove(session_id)
    return [{"session_id": session_id, **state} for session_id, state in ACTIVE_SESSIONS.items()]


def scheduler() -> None:
    """Heartbeat plus routine dispatch, every 30 seconds."""
    while not STOP.is_set():
        now = datetime.now()
        with STATE_LOCK:
            routines = load_json("routines.json")
            changed = False
            for routine in routines.values():
                if not routine.get("enabled") or now < datetime.fromisoformat(routine["next_run"]):
                    continue
                running = RUNS.get(routine.get("last_run_id") or "")
                if running and running.status == "running":
                    continue  # never overlap a routine with itself
                request = RunRequest(
                    prompt=routine["prompt"], cwd=routine["cwd"], model=ModelSpec(**(routine.get("model") or {})),
                    session_id=routine.get("session_id") if routine.get("continue_session") else None,
                    resume=bool(routine.get("continue_session") and routine.get("session_id")),
                )
                try:
                    run = start_run(request, origin=f"routine:{routine['id']}")
                    routine.update(last_run_id=run.id, last_started=now.isoformat(timespec="seconds"), last_error=None)
                    if routine.get("continue_session"):
                        routine["session_id"] = run.session_id
                except HTTPException as error:
                    routine["last_error"] = str(error.detail)
                routine["next_run"] = next_due(routine, now)
                changed = True
            if changed:
                save_json("routines.json", routines)
        save_json("heartbeat.json", {
            "at": now.isoformat(timespec="seconds"), "pid": os.getpid(), "uptime_s": int(time.time() - STARTED),
            "running": [r.id for r in RUNS.values() if r.status == "running"],
        })
        try:
            resources = available_resources()
            active_sessions = monitor_active_sessions()
            with MONITOR_LOCK:
                recovery_pending = sorted(RECOVERY_PENDING)
            save_json("supervision.json", {"active": active_sessions, "recovery_pending": recovery_pending,
                                           "resources": resources, "restart_requested": update_resource_pressure(resources, time.time()),
                                           "at": now.isoformat(timespec="seconds")})
        except (OSError, ValueError, sqlite3.Error) as error:
            print(f"[daemon] supervision check failed: {error}", file=sys.stderr, flush=True)
        STOP.wait(30)


def run_check(command: str, cwd: str, timeout: int) -> tuple[int, str]:
    shell = ["powershell", "-NoProfile", "-Command", command] if sys.platform == "win32" else ["bash", "-lc", command]
    process = subprocess.Popen(shell, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
                               start_new_session=sys.platform != "win32")
    try:
        stdout, stderr = process.communicate(timeout=timeout)
        return process.returncode, (stdout + stderr).decode("utf-8", "replace")[-4000:]
    except subprocess.TimeoutExpired:
        try:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True, timeout=10, check=False)
            else:
                os.killpg(process.pid, signal.SIGKILL)
        except (OSError, subprocess.TimeoutExpired):
            pass
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)
        return -1, f"check timed out after {timeout}s"


def goal_loop(goal_id: str) -> None:
    """Run → check → resume with the check's output, until the check passes or the budget ends."""
    with STATE_LOCK:
        goal = load_json("goals.json")[goal_id]
    deadline = goal["created"] + goal["budget_minutes"] * 60
    prompt = (f"{goal['prompt']}\n\nThe goal is met when this command exits 0 in the working directory:\n"
              f"{goal['check']}\nRun it yourself before you finish.")
    session_id = goal.get("session_id")
    while True:
        if STOP.is_set():
            goal["status"] = "interrupted"
            break
        iteration = len(goal["iterations"]) + 1
        if iteration > goal["max_iterations"] or time.time() > deadline:
            goal["status"] = "exhausted"
            break
        request = RunRequest(prompt=prompt, cwd=goal["cwd"], session_id=session_id, resume=bool(session_id),
                             model=ModelSpec(**(goal.get("model") or {})), max_turns=120)
        try:
            run = start_run(request, origin=f"goal:{goal_id}")
        except HTTPException as error:
            goal["status"], goal["error"] = "failed", str(error.detail)
            break
        session_id = goal["session_id"] = run.session_id
        if not run.done.wait(max(0, deadline - time.time())):
            try:
                host().call("agent.cancel", {"task_id": run.task_id})
            except Exception as error:
                goal["error"] = f"Timed out; cancellation failed: {error}"
            else:
                goal["error"] = ("Run timed out and was cancelled" if run.done.wait(15)
                                 else "Run timed out; cancellation was not confirmed")
            goal["status"] = "failed"
            break
        if STOP.is_set():
            goal["status"] = "interrupted"
            break
        if run.status != "completed":
            goal["status"] = "failed"
            goal["error"] = f"Run ended with status {run.status}"
            break
        code, output = run_check(goal["check"], goal["cwd"], goal["check_timeout"])
        goal["iterations"].append({"run_id": run.id, "run_status": run.status, "check_exit": code, "check_tail": output[-600:]})
        with STATE_LOCK:
            goals = load_json("goals.json")
            goals[goal_id] = goal
            save_json("goals.json", goals)
        if code == 0:
            goal["status"] = "met"
            break
        prompt = (f"[Goal check] Not met yet: `{goal['check']}` exited {code}. Last output:\n{output[-2500:]}\n"
                  "Find the cause, fix it, and run the check again.")
    goal["finished"] = time.time()
    with STATE_LOCK:
        goals = load_json("goals.json")
        goals[goal_id] = goal
        save_json("goals.json", goals)


# ---------------------------------------------------------------- HTTP

app = FastAPI(title="OctoCode Daemon", version="2.0", description="Run, schedule and drive the OctoCode agent over HTTP.")


def authorize(request: Request) -> None:
    token = os.environ.get("OCTOCODE_API_TOKEN")
    if token and not secrets.compare_digest(request.headers.get("authorization", "").encode("utf-8"), f"Bearer {token}".encode("utf-8")):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing or wrong bearer token")


def public_record(value):
    """Return detached API data without exposing persisted model credentials."""
    if isinstance(value, dict):
        return {key: public_record(item) for key, item in value.items() if key != "api_key"}
    if isinstance(value, list):
        return [public_record(item) for item in value]
    return value


def get_run(run_id: str) -> Run:
    if run_id not in RUNS:
        raise HTTPException(404, f"Unknown run {run_id}")
    return RUNS[run_id]


@app.get("/health")
def health() -> dict:
    problems = []
    try:
        model = last_app_model()
    except RuntimeError:
        model = {}
    harness = None
    try:
        extension_binary("OCTOCODE_HOST", "octocode-host")
        harness = str(extension_binary("OCTOCODE_HARNESS", "octocode-harness"))
    except RuntimeError as error:
        problems.append(str(error))
    try:
        heartbeat = load_json("heartbeat.json").get("at")
        if not heartbeat or abs((datetime.now() - datetime.fromisoformat(heartbeat)).total_seconds()) > 90:
            problems.append("scheduler heartbeat is missing or stale")
    except (OSError, ValueError) as error:
        heartbeat = None
        problems.append(f"scheduler state is unreadable: {error}")
    try:
        STATE.mkdir(parents=True, exist_ok=True)
        probe = STATE / ".health-write-check"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as error:
        problems.append(f"daemon state is not writable: {error}")
    return {
        "ok": not problems, "problems": problems, "pid": os.getpid(),
        "uptime_s": int(time.time() - STARTED), "harness": harness, "store": str(STORE),
        "model": model.get("model"), "base_url": model.get("base_url"),
        "default_model_available": bool(model), "explicit_model_required": not bool(model),
        "running": sum(1 for r in RUNS.values() if r.status == "running"),
        "monitored_sessions": len(ACTIVE_SESSIONS),
        "desktop_pid": DESKTOP_PID,
        "heartbeat": heartbeat,
    }


@app.post("/v1/daemon/attach", dependencies=[Depends(authorize)])
def attach_desktop(pid: int) -> dict:
    global DESKTOP_PID
    if pid <= 0 or not process_alive(pid):
        raise HTTPException(400, "Desktop process is not running")
    with DESKTOP_LOCK:
        DESKTOP_PID = pid
    return {"desktop_pid": pid}


@app.post("/v1/daemon/shutdown", dependencies=[Depends(authorize)])
def stop_desktop_daemon() -> dict:
    threading.Thread(target=shutdown, daemon=True).start()
    return {"stopping": True}


@app.post("/v1/daemon/restart-ack", dependencies=[Depends(authorize)])
def acknowledge_restart() -> dict:
    global RESTART_REQUESTED
    RESTART_REQUESTED = False
    return {"acknowledged": True}


@app.post("/v1/runs", status_code=202, dependencies=[Depends(authorize)])
def create_run(request: RunRequest) -> dict:
    run = start_run(request)
    if request.wait:
        run.done.wait()
    return run.summary()


@app.get("/v1/runs", dependencies=[Depends(authorize)])
def list_runs() -> list[dict]:
    history = {entry["run_id"]: entry for entry in (read_saved_run(path) for path in (STATE / "runs").glob("*.json"))}
    history.update({run.id: run.summary(text=False) for run in RUNS.values()})
    return list(history.values())


def read_saved_run(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("run_id"), str):
        raise ValueError(f"Invalid run history in {path}")
    return {key: value for key, value in data.items() if key != "prompt"}


@app.get("/v1/runs/{run_id}", dependencies=[Depends(authorize)])
def read_run(run_id: str) -> dict:
    if run_id in RUNS:
        return RUNS[run_id].summary()
    if not re.fullmatch(r"[A-Za-z0-9-]+", run_id):
        raise HTTPException(404, f"Unknown run {run_id}")
    path = STATE / "runs" / f"{run_id}.json"
    if not path.is_file():
        raise HTTPException(404, f"Unknown run {run_id}")
    return read_saved_run(path)


@app.get("/v1/runs/{run_id}/events", dependencies=[Depends(authorize)])
async def stream_events(run_id: str) -> StreamingResponse:
    """Server-sent events: every event from the start, then live ones, then `done`."""
    import asyncio

    run = get_run(run_id)

    async def events():
        sent = 0
        while True:
            while sent < len(run.events):
                yield f"data: {json.dumps(run.events[sent], ensure_ascii=False)}\n\n"
                sent += 1
            if run.done.is_set() and sent >= len(run.events):
                yield f"event: done\ndata: {json.dumps(run.summary(), ensure_ascii=False)}\n\n"
                return
            await asyncio.sleep(0.2)

    return StreamingResponse(events(), media_type="text/event-stream")


@app.post("/v1/runs/{run_id}/cancel", dependencies=[Depends(authorize)])
def cancel_run(run_id: str) -> dict:
    run = get_run(run_id)
    if run.status == "running" and run.task_id:
        run.status = "cancelled"
        host().call("agent.cancel", {"task_id": run.task_id})
        run.done.wait(15)
    return run.summary()


@app.get("/v1/extensions", dependencies=[Depends(authorize)])
def list_extensions() -> list[dict]:
    """What daemon runs can use, in the same entry shape as the app's component market.

    Read-only: installing and removing stays in the app (the component market), so
    there is one install surface. MCP servers are the ones handed to every run.
    """
    entries = [{"kind": "mcp", "id": name, "name": name, "scope": "system", "installed": True,
                "builtIn": True, "actions": []} for name in bundled_mcp_servers()]
    for scope, folder in (("global", ROOT / "environments/tools/skills"),):
        for skill in sorted(folder.glob("*/SKILL.md")) if folder.is_dir() else []:
            entries.append({"kind": "skill", "id": skill.parent.name, "name": skill.parent.name, "scope": scope,
                            "installed": True, "builtIn": scope == "project", "actions": []})
    for env in sorted((ROOT / "environments").iterdir()) if (ROOT / "environments").is_dir() else []:
        if env.is_dir():
            entries.append({"kind": "environment", "id": env.name, "name": env.name, "scope": "system",
                            "installed": True, "builtIn": env.name in ("node", "scripts", "python"), "actions": []})
    return entries


@app.get("/v1/routines", dependencies=[Depends(authorize)])
def list_routines() -> dict:
    return public_record(load_json("routines.json"))


@app.post("/v1/routines", status_code=201, dependencies=[Depends(authorize)])
def create_routine(request: RoutineRequest) -> dict:
    if bool(request.every_minutes) == bool(request.daily_at):
        raise HTTPException(400, "Set exactly one of every_minutes or daily_at")
    if not Path(request.cwd).is_dir():
        raise HTTPException(400, f"cwd does not exist: {request.cwd}")
    routine = {**request.model_dump(), "id": uuid.uuid4().hex[:12], "created": datetime.now().isoformat(timespec="seconds")}
    routine["next_run"] = next_due(routine, datetime.now())
    with STATE_LOCK:
        routines = load_json("routines.json")
        routines[routine["id"]] = routine
        save_json("routines.json", routines)
    return public_record(routine)


@app.delete("/v1/routines/{routine_id}", dependencies=[Depends(authorize)])
def delete_routine(routine_id: str) -> dict:
    with STATE_LOCK:
        routines = load_json("routines.json")
        removed = routines.pop(routine_id, None)
        save_json("routines.json", routines)
    if not removed:
        raise HTTPException(404, f"Unknown routine {routine_id}")
    return {"deleted": routine_id}


@app.post("/v1/goals", status_code=202, dependencies=[Depends(authorize)])
def create_goal(request: GoalRequest) -> dict:
    if not Path(request.cwd).is_dir():
        raise HTTPException(400, f"cwd does not exist: {request.cwd}")
    goal_id = uuid.uuid4().hex[:12]
    goal = {**request.model_dump(), "id": goal_id, "status": "running", "iterations": [], "created": time.time()}
    with STATE_LOCK:
        goals = load_json("goals.json")
        goals[goal_id] = goal
        save_json("goals.json", goals)
    threading.Thread(target=goal_loop, args=(goal_id,), daemon=True).start()
    return public_record(goal)


@app.get("/v1/goals", dependencies=[Depends(authorize)])
def list_goals() -> dict:
    return public_record(load_json("goals.json"))


@app.get("/v1/goals/{goal_id}", dependencies=[Depends(authorize)])
def read_goal(goal_id: str) -> dict:
    goal = load_json("goals.json").get(goal_id)
    if not goal:
        raise HTTPException(404, f"Unknown goal {goal_id}")
    return public_record(goal)


@app.post("/v1/goals/{goal_id}/resume", status_code=202, dependencies=[Depends(authorize)])
def resume_goal(goal_id: str) -> dict:
    """Continue a goal the daemon was stopped in the middle of (or that ran out of iterations)."""
    with STATE_LOCK:
        goals = load_json("goals.json")
        goal = goals.get(goal_id)
        if not goal:
            raise HTTPException(404, f"Unknown goal {goal_id}")
        if goal["status"] == "running":
            raise HTTPException(409, f"Goal {goal_id} is already running")
        goal.update(status="running", created=time.time())
        goal.pop("finished", None)
        goal.pop("error", None)
        goal["max_iterations"] = len(goal["iterations"]) + max(1, goal["max_iterations"] - len(goal["iterations"]))
        save_json("goals.json", goals)
    threading.Thread(target=goal_loop, args=(goal_id,), daemon=True).start()
    return public_record(goal)


def export_product_environment() -> None:
    """The variables the desktop shell exports at start-up, so daemon runs see the same
    bundled Python and Node the desktop's do (the host and harness inherit them)."""
    environments = ROOT / "environments"
    python_dir = environments / "python"
    node_dir = environments / "node"
    os.environ.setdefault("OCTOCODE_ENVIRONMENTS", str(environments))
    os.environ.setdefault("OCTOCODE_NODE", str(node_dir / ("node.exe" if sys.platform == "win32" else "bin/node")))
    os.environ.setdefault("OCTOCODE_WORKSPACE", str(ROOT / "workspace"))
    os.environ.setdefault("OCTOCODE_DATA", str(ROOT / "data"))
    if python_dir.is_dir():
        os.environ.setdefault("OCTOCODE_PYTHON_BASE", str(python_dir / ("python.exe" if sys.platform == "win32" else "bin/python3")))
    extra = [str(p) for p in (python_dir, python_dir / "Scripts", node_dir) if p.is_dir()]
    path = os.environ.get("PATH", "")
    os.environ["PATH"] = os.pathsep.join([p for p in extra if p not in path.split(os.pathsep)] + [path])


def mark_interrupted() -> None:
    """Persist the interrupted state of work left by an earlier process."""
    with STATE_LOCK:
        goals = load_json("goals.json")
        for goal in goals.values():
            if goal.get("status") == "running":
                goal["status"] = "interrupted"
        save_json("goals.json", goals)
    for path in (STATE / "runs").glob("*.json"):
        record = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(record, dict):
            raise ValueError(f"Invalid run history in {path}")
        if record.get("status") == "running":
            record.update(status="interrupted", finished=time.time())
            temporary = path.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            temporary.replace(path)


def shutdown() -> None:
    """Stop scheduling, cancel live work, and release the host before the desktop exits."""
    if STOP.is_set():
        return
    STOP.set()
    try:
        client = HOST
        if client and client.process.poll() is None:
            for run in list(RUNS.values()):
                if run.status == "running" and run.task_id:
                    run.status = "cancelled"
                    try:
                        client.call("agent.cancel", {"task_id": run.task_id}, timeout=10)
                    except Exception as error:  # noqa: BLE001 - finish shutting down even if cancellation fails
                        print(f"[daemon] could not cancel run {run.id}: {error}", file=sys.stderr, flush=True)
            for run in list(RUNS.values()):
                if run.status == "cancelled" and not run.done.wait(15):
                    run.status = "interrupted"
                    run.finished = time.time()
                    persist_run(run)
                    if run.tool_copy_dir:
                        shutil.rmtree(run.tool_copy_dir, ignore_errors=True)
                        run.tool_copy_dir = None
                    run.done.set()
            if client.process.stdin:
                client.process.stdin.close()
            try:
                client.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if sys.platform == "win32":
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(client.process.pid)],
                                   capture_output=True, timeout=10, check=False)
                else:
                    client.process.kill()
                    client.process.wait(timeout=5)
            client.stderr.close()
        mark_interrupted()
    finally:
        if SERVER:
            SERVER.should_exit = True


def watch_parent() -> None:
    """A normal Exit sends stop; a broken pipe leaves supervision running."""
    # A buffered reader held by a daemon thread can abort Python during HTTP shutdown.
    command = bytearray()
    while len(command) <= MAX_COMMAND_BYTES:
        chunk = os.read(sys.stdin.fileno(), 1)
        if not chunk:
            return
        command.extend(chunk)
        if chunk == b"\n":
            if command.strip() == b"stop":
                shutdown()
            return


def process_alive(pid: int) -> bool:
    if sys.platform != "win32":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        return bool(ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def watch_desktop() -> None:
    """Keep supervising after an Electron crash, including after a reattached restart."""
    global DESKTOP_PID
    restarts: list[float] = []
    reported_limit = False
    while not STOP.wait(5):
        with DESKTOP_LOCK:
            pid = DESKTOP_PID
        if not pid or process_alive(pid):
            continue
        if STOP.wait(5):
            return
        with DESKTOP_LOCK:
            if DESKTOP_PID != pid:
                continue
        if process_alive(pid):
            continue
        try:
            monitor_active_sessions()
        except (OSError, ValueError, sqlite3.Error) as error:
            print(f"[daemon] could not snapshot tasks before restart: {error}", file=sys.stderr, flush=True)
        restarts = [at for at in restarts if time.monotonic() - at < 600]
        if len(restarts) >= 3:
            if not reported_limit:
                print("[daemon] desktop restart paused after three crashes in ten minutes", file=sys.stderr, flush=True)
                reported_limit = True
            continue
        reported_limit = False
        executable = ROOT / ("OctoCode.exe" if sys.platform == "win32" else "octocode")
        if not executable.is_file():
            print(f"[daemon] desktop executable is missing: {executable}", file=sys.stderr, flush=True)
            return
        try:
            child = subprocess.Popen([str(executable)], cwd=ROOT,
                                     creationflags=subprocess.DETACHED_PROCESS if sys.platform == "win32" else 0,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as error:
            print(f"[daemon] desktop restart failed: {error}", file=sys.stderr, flush=True)
            restarts.append(time.monotonic())
            continue
        with DESKTOP_LOCK:
            if DESKTOP_PID == pid:
                DESKTOP_PID = child.pid
        restarts.append(time.monotonic())
        print(f"[daemon] restarted desktop pid={child.pid} ({len(restarts)}/3 in ten minutes)", file=sys.stderr, flush=True)


def main() -> None:
    global SERVER, LAST_RESOURCE_RESTART
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    if args.host not in ("127.0.0.1", "localhost", "::1") and not os.environ.get("OCTOCODE_API_TOKEN"):
        sys.exit("Refusing to listen beyond loopback without OCTOCODE_API_TOKEN: the API runs an agent that edits files.")
    export_product_environment()
    mark_interrupted()
    previous = load_json("supervision.json")
    LAST_RESOURCE_RESTART = float(load_json("resource-restart.json").get("last_requested", 0))
    ACTIVE_SESSIONS.update({item["session_id"]: {key: value for key, value in item.items() if key != "session_id"}
                            for item in previous.get("active", []) if isinstance(item, dict) and isinstance(item.get("session_id"), str)})
    RECOVERY_PENDING.update(previous.get("recovery_pending", []))
    threading.Thread(target=scheduler, daemon=True).start()
    threading.Thread(target=watch_desktop, daemon=True).start()
    SERVER = uvicorn.Server(uvicorn.Config(app, host=args.host, port=args.port, log_level="warning"))
    if os.environ.get("OCTOCODE_DAEMON_PARENT_PIPE") == "1":
        threading.Thread(target=watch_parent, daemon=True).start()
    SERVER.run()


if __name__ == "__main__":
    main()
