"""Read the selected Windows desktop model without persisting decrypted credentials."""
from __future__ import annotations

import base64
import ctypes
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import time
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, HTTPRedirectHandler, build_opener

_CONTEXT_CACHE: dict[str, tuple[float, int]] = {}


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


def _valid_context(value):
    return type(value) is int and 4096 <= value <= 100_000_000


def _model_context(value):
    if not isinstance(value, dict):
        return None
    for name in ("max_model_len", "context_length", "contextWindow", "max_context_length", "inputTokenLimit", "context_window"):
        if _valid_context(value.get(name)):
            return value[name]
    info = value.get("model_info")
    if isinstance(info, dict):
        return next((number for name, number in info.items() if name.endswith(".context_length") and _valid_context(number)), None)
    return None


def context_window(profile: dict) -> int:
    """Match ModelContextDiscovery's manual/server order, without a silent lower fallback."""
    identity = hashlib.sha256(json.dumps(profile, sort_keys=True).encode()).hexdigest()
    cached = _CONTEXT_CACHE.get(identity)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    custom = profile.get("openAiCustomModelInfo") or {}
    manual = profile.get("modelContextWindow")
    if manual is None:
        manual = custom.get("contextWindow") if isinstance(custom, dict) else None
    found = manual if profile.get("autoContextWindow") is False and _valid_context(manual) else None
    deadline = time.monotonic() + 5
    if found is None:
        endpoints = [value.strip() for value in profile["openAiBaseUrl"].split(",") if value.strip()][:8]
        for endpoint in endpoints:
            try:
                url = urlsplit(endpoint)
                if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
                    raise ValueError("Invalid model metadata endpoint")
                target = urlunsplit(url._replace(path=url.path.rstrip("/") + "/models"))
                headers = dict(profile.get("openAiHeaders") or {})
                if profile.get("openAiApiKey"):
                    headers["Authorization"] = "Bearer " + profile["openAiApiKey"]
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                with build_opener(_NoRedirect()).open(Request(target, headers=headers), timeout=remaining) as response:
                    chunks, size = [], 0
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise TimeoutError("Model metadata deadline expired")
                        sock = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
                        if sock is not None:
                            sock.settimeout(remaining)
                        chunk = response.read1(min(65536, 4 * 1024 * 1024 + 1 - size))
                        if not chunk:
                            break
                        chunks.append(chunk)
                        size += len(chunk)
                        if size > 4 * 1024 * 1024:
                            raise ValueError("Model metadata exceeds 4 MiB")
                body = json.loads(b"".join(chunks))
                data = body.get("data", []) if isinstance(body, dict) else []
                if not isinstance(data, list):
                    raise ValueError("Invalid model metadata list")
                selected = next((item for item in data if isinstance(item, dict) and item.get("id") == profile["openAiModelId"]), None)
                found = _model_context(selected)
                if found is not None:
                    break
            except (OSError, ValueError, TypeError):
                continue
    if found is None:
        raise RuntimeError("The model did not report its context window; set an explicit manual context instead of reducing it")
    if len(_CONTEXT_CACHE) >= 128:
        _CONTEXT_CACHE.pop(next(iter(_CONTEXT_CACHE)))
    _CONTEXT_CACHE[identity] = (time.monotonic() + 60, found)
    return found


def _unprotect(value: bytes) -> bytes:
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.c_void_p)]

    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt.CryptUnprotectData.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    crypt.CryptUnprotectData.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    buffer = ctypes.create_string_buffer(value)
    source = Blob(len(value), ctypes.cast(buffer, ctypes.c_void_p))
    output = Blob()
    if not crypt.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise RuntimeError("Desktop credential is unavailable to this Windows user")
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel.LocalFree(output.data)


def selected_model(root: Path) -> dict:
    if sys.platform != "win32":
        raise RuntimeError("Pass an explicit model and endpoint on this platform")
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        user = root / "data/user-data"
        local = json.loads((user / "Local State").read_text(encoding="utf-8"))
        wrapped = base64.b64decode(local["os_crypt"]["encrypted_key"], validate=True)
        if not wrapped.startswith(b"DPAPI"):
            raise ValueError("Unsupported desktop encryption format")
        key = _unprotect(wrapped[5:])
        with closing(sqlite3.connect((user / "User/globalStorage/state.vscdb").resolve().as_uri() + "?mode=ro", uri=True)) as db:
            global_rows = db.execute("SELECT value FROM ItemTable WHERE lower(key)=?", ("octocode.octocode",)).fetchall()
            secret_row = db.execute("SELECT value FROM ItemTable WHERE key=?",
                ('secret://{"extensionId":"octocode.octocode","key":"octocode_config_api_config"}',)).fetchone()
        if len(global_rows) != 1:
            raise ValueError("Missing or ambiguous desktop profile selection")
        current = json.loads(global_rows[0][0])["currentApiConfigName"]
        if not isinstance(current, str) or not current:
            raise ValueError("No selected desktop profile")
        encoded = json.loads(secret_row[0])["data"]
        if not isinstance(encoded, list) or not all(type(v) is int and 0 <= v <= 255 for v in encoded):
            raise ValueError("Invalid encrypted desktop credential")
        encrypted = bytes(encoded)
        if not encrypted.startswith(b"v10") or len(encrypted) < 31:
            raise ValueError("Unsupported encrypted desktop credential")
        profiles = json.loads(AESGCM(key).decrypt(encrypted[3:15], encrypted[15:], None))
        profile = profiles["apiConfigs"][current]
        if profile.get("apiProvider") != "openai":
            raise ValueError("The selected desktop provider requires an explicit API model")
        model, endpoint = profile["openAiModelId"], profile["openAiBaseUrl"]
        api_key = profile.get("openAiApiKey", "")
        if not all(isinstance(value, str) for value in (model, endpoint, api_key)) or not model or not endpoint:
            raise ValueError("Selected desktop model is incomplete")
        return {"model": model, "base_url": endpoint, "api_key": api_key,
                "context_window": context_window(profile), "provider": profile}
    except Exception:
        # Never embed decrypted JSON, ciphertext, or provider credentials in diagnostics.
        raise RuntimeError("Cannot read the selected desktop OpenAI-compatible model; configure it in OctoCode or pass an explicit model and endpoint") from None
