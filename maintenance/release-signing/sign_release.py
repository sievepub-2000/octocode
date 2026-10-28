"""Create and use the local DPAPI-protected OctoCode release-signing identity."""
from __future__ import annotations

import argparse
import base64
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import zipfile

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

SOURCE = Path(__file__).resolve().parents[2]
KEY_DIRECTORY = Path("E:/Program Files/octocode/data/signing")
REPOSITORY = "sievepub-2000/octocode"


class Blob(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]


def dpapi(data: bytes, *, decrypt: bool = False) -> bytes:
    if os.name != "nt":
        raise RuntimeError("This signing store requires Windows DPAPI")
    buffer = ctypes.create_string_buffer(data)
    incoming = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    entropy_buffer = ctypes.create_string_buffer(b"OctoCode release signing v1")
    entropy = Blob(len(entropy_buffer.raw) - 1, ctypes.cast(entropy_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    if not function(ctypes.byref(incoming), None, ctypes.byref(entropy), None, None, 1, ctypes.byref(output)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel.LocalFree(output.data)


def powershell(script: str) -> str:
    return subprocess.check_output(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" + script], text=True).strip()


def reject_reparse(path: Path) -> None:
    for parent in (path, *path.parents):
        try:
            attributes = parent.lstat().st_file_attributes
        except FileNotFoundError:
            continue
        if attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError("Signing directory must not traverse a reparse point")


def plain_directory(directory: Path) -> Path:
    directory = Path(os.path.abspath(directory))
    reject_reparse(directory)
    if directory.exists() and not directory.is_dir():
        raise ValueError("Release output must be an ordinary directory")
    directory.mkdir(parents=True, exist_ok=True)
    reject_reparse(directory)
    return directory


def protect_directory(directory: Path) -> Path:
    directory = plain_directory(directory)
    literal = "'" + str(directory).replace("'", "''") + "'"
    powershell(
        "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;"
        f"$owner=[System.IO.Directory]::GetAccessControl({literal}).GetOwner([System.Security.Principal.SecurityIdentifier]).Value;"
        "if($owner -ne $sid.Value){throw 'Signing directory is owned by another identity'};"
        "$acl=[System.Security.AccessControl.DirectorySecurity]::new();"
        "$acl.SetAccessRuleProtection($true,$false);"
        "foreach($identity in @($sid,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){"
        "$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)};"
        f"[System.IO.Directory]::SetAccessControl({literal},$acl);"
        f"$actual=[System.IO.Directory]::GetAccessControl({literal});"
        "if($actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner){throw 'Signing owner changed'};"
        "if(!$actual.AreAccessRulesProtected -or @($actual.Access).Count -ne 2){throw 'Unexpected signing ACL'};"
        "foreach($rule in $actual.Access){$id=$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;"
        "if($id -notin @($sid.Value,'S-1-5-18') -or $rule.AccessControlType -ne 'Allow'){throw 'Unexpected signing identity'}}"
    )
    return directory


def create_only(path: Path, contents: bytes) -> None:
    reject_reparse(path)
    if path.exists():
        if path.read_bytes() != contents:
            raise ValueError(f"Refusing to replace an existing file: {path.name}")
        return
    with path.open("xb") as stream:
        stream.write(contents)
        stream.flush()
        os.fsync(stream.fileno())


def public_source_file(path: Path, contents: bytes) -> None:
    # Respect each project's formatter without accepting executable statements.
    def public_exports(raw: bytes) -> list[tuple[str, str]]:
        text = re.sub(r"/\*.*?\*/", "", raw.decode("utf-8"), flags=re.DOTALL)
        exports = []
        position = 0
        for match in re.finditer(r"export\s+const\s+([A-Z_][A-Z0-9_]*)\s*=\s*(['\"])([A-Za-z0-9+/=]+)\2\s*;?", text):
            if text[position:match.start()].strip():
                raise ValueError("Unexpected public signing source statements")
            exports.append((match[1], match[3]))
            position = match.end()
        if text[position:].strip() or not exports:
            raise ValueError("Unexpected public signing source statements")
        return exports

    reject_reparse(path)
    if path.exists():
        if public_exports(path.read_bytes()) != public_exports(contents):
            raise ValueError("Existing public signing source does not match the protected identity")
        return  # Never rewrite an existing public anchor, even for formatting.
    create_only(path, contents)


def private_key(directory: Path, *, initialize: bool = False) -> Ed25519PrivateKey:
    directory = protect_directory(directory)
    file = directory / "ed25519-private.dpapi"
    if not file.exists():
        if not initialize:
            raise FileNotFoundError("Initialize the protected release-signing identity first")
        key = Ed25519PrivateKey.generate()
        encrypted = dpapi(key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()))
        create_only(file, encrypted)
    reject_reparse(file)
    return Ed25519PrivateKey.from_private_bytes(dpapi(file.read_bytes(), decrypt=True))


def public_anchor(key: Ed25519PrivateKey) -> dict:
    der = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return {"schemaVersion": 1, "algorithm": "Ed25519", "publicKeySpkiBase64": base64.b64encode(der).decode("ascii"), "publicKeySha256": hashlib.sha256(der).hexdigest()}


def initialize() -> dict:
    if not (KEY_DIRECTORY / "ed25519-private.dpapi").exists() and Path(__file__).with_name("release-public-key.json").exists():
        raise ValueError("A public anchor is already committed; restore the matching protected identity instead of generating another key")
    anchor = public_anchor(private_key(KEY_DIRECTORY, initialize=True))
    anchor_file = Path(__file__).with_name("release-public-key.json")
    reject_reparse(anchor_file)
    if anchor_file.exists():
        if json.loads(anchor_file.read_text(encoding="utf-8")) != anchor:
            raise ValueError("Existing public anchor does not match the protected identity")
    else:
        create_only(anchor_file, (json.dumps(anchor, indent=2) + "\n").encode())
    generated = ("/* Public release-signing identity. Never include a private key here. */\n"
                 f"export const RELEASE_PUBLIC_KEY_SPKI_BASE64 = '{anchor['publicKeySpkiBase64']}';\n"
                 f"export const RELEASE_PUBLIC_KEY_SHA256 = '{anchor['publicKeySha256']}';\n").encode()
    for relative in ["desktop-shell/src/vs/platform/update/common/releaseTrust.ts", "octocode-core/src/services/update/releaseTrust.ts"]:
        public_source_file(SOURCE / relative, generated)
    return anchor


def version(value: str) -> str:
    if not re.fullmatch(r"v?(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?", value):
        raise ValueError("Expected a stable two- or three-part version")
    value = value.removeprefix("v")
    return value + ".0" if value.count(".") == 1 else value


def file_snapshot(file: Path) -> tuple[int, int, int, int]:
    details = file.stat()
    return details.st_dev, details.st_ino, details.st_size, details.st_mtime_ns


def artifact(file: Path, expected: tuple[int, int, int, int] | None = None) -> dict:
    reject_reparse(file)
    before = file_snapshot(file)
    if not file.is_file() or before[2] <= 0:
        raise ValueError("Release artifact must be a real nonempty file")
    if expected is not None and before != expected:
        raise ValueError("Release artifact changed while reading its metadata")
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if file_snapshot(file) != before:
        raise ValueError("Release artifact changed while hashing")
    return {"name": file.name, "sha256": digest.hexdigest(), "size": before[2]}


def build_release(arguments: argparse.Namespace) -> dict:
    output = Path(os.path.abspath(arguments.output))
    if output.is_relative_to(KEY_DIRECTORY) or KEY_DIRECTORY.is_relative_to(output):
        raise ValueError("Release output must not contain or overlap the private signing store")
    output = plain_directory(output)
    key = private_key(KEY_DIRECTORY)
    anchor = json.loads(Path(__file__).with_name("release-public-key.json").read_text(encoding="utf-8"))
    if public_anchor(key) != anchor:
        raise ValueError("Local signing identity does not match the committed public anchor")
    product_version = version(arguments.version)
    if version(arguments.tag) != product_version:
        raise ValueError("Release tag does not match the product version")
    installer = Path(os.path.abspath(arguments.installer))
    reject_reparse(installer)
    installer_snapshot = file_snapshot(installer)
    if installer.name != "OctoCodeSetup.exe":
        raise ValueError("Expected canonical system installer OctoCodeSetup.exe")
    with installer.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError("Installer is not a Windows executable")
    literal = "'" + str(installer).replace("'", "''") + "'"
    actual_version = powershell(f"[System.Diagnostics.FileVersionInfo]::GetVersionInfo({literal}).ProductVersion")
    if version(actual_version) != product_version:
        raise ValueError("Actual installer product version does not match the release")
    assets = {"windows-x64-system": artifact(installer, installer_snapshot)}
    snapshots = [(installer, installer_snapshot)]
    if arguments.extension:
        extension = Path(os.path.abspath(arguments.extension))
        reject_reparse(extension)
        extension_snapshot = file_snapshot(extension)
        with zipfile.ZipFile(extension) as archive:
            package = json.loads(archive.read("extension/package.json"))
        extension_version = package["version"]
        if version(extension_version) != extension_version or extension.name != f"octocode-{extension_version}.vsix":
            raise ValueError("VSIX name must match its actual stable package version")
        assets["extension"] = {**artifact(extension, extension_snapshot), "version": extension_version, "minShellVersion": product_version}
        snapshots.append((extension, extension_snapshot))
    manifest = {"schemaVersion": 1, "product": "OctoCode", "repository": REPOSITORY, "version": product_version, "tag": arguments.tag, "assets": assets}
    raw = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    if any(file_snapshot(file) != previous for file, previous in snapshots):
        raise ValueError("Release artifact changed before signing")
    signature = key.sign(raw)
    key.public_key().verify(signature, raw)
    if any(file_snapshot(file) != previous for file, previous in snapshots):
        raise ValueError("Release artifact changed during signing")
    reject_reparse(output)
    create_only(output / "octocode-release.json", raw)
    create_only(output / "octocode-release.json.sig", signature)
    return {"manifest": str(output / "octocode-release.json"), "signatureBytes": len(signature), "publicKeySha256": anchor["publicKeySha256"], "assets": assets}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("init")
    build = commands.add_parser("build")
    build.add_argument("--installer", type=Path, required=True)
    build.add_argument("--extension", type=Path)
    build.add_argument("--version", required=True)
    build.add_argument("--tag", required=True)
    build.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(initialize() if args.command == "init" else build_release(args), indent=2))


if __name__ == "__main__":
    main()
