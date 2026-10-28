import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

import product_tools
from system_tools import migrate


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")


def stage(root, version):
    env = root / "environments"
    tools = env / "tools"
    namespace = tools / product_tools.PROGRAMS["code-review-graph"]
    write(namespace / "__init__.py", f'__version__ = "{version}"\n')
    write(namespace / "program.py", f'REVISION = "{version}"\n')
    for name in ("code-review-graph", "scrapling"):
        info = env / "python/Lib/site-packages" / (name.replace("-", "_") + f"-{version}.dist-info")
        write(info / "METADATA", f"Metadata-Version: 2.4\nName: {name}\nVersion: {version}\n")
        if name == "code-review-graph":
            records = []
            for path in namespace.iterdir():
                value = base64.urlsafe_b64encode(bytes.fromhex(product_tools.digest(path))).rstrip(b"=").decode()
                records.append(f"code_review_graph/{path.name},sha256={value},{path.stat().st_size}")
            metadata = info / "METADATA"
            value = base64.urlsafe_b64encode(bytes.fromhex(product_tools.digest(metadata))).rstrip(b"=").decode()
            records.extend((f"{info.name}/METADATA,sha256={value},{metadata.stat().st_size}", f"{info.name}/RECORD,,"))
            write(info / "RECORD", "\n".join(records))
    wiki = tools / "mcp/llmwiki"
    write(wiki / "package.json", json.dumps({"dependencies": {"@llmwiki/core": version}}))
    write(wiki / "package-lock.json", json.dumps({"lockfileVersion": 3, "packages": {
        "": {"dependencies": {"@llmwiki/core": version}},
        "node_modules/@llmwiki/core": {"version": version}}}))
    write(wiki / "node_modules/@llmwiki/core/package.json", json.dumps({"name": "@llmwiki/core", "version": version}))
    write(wiki / "node_modules/@llmwiki/core/program.js", f'exports.version = "{version}";')
    write(wiki / "llmwiki-core-0.1.2.tgz", f'archive fixture {version}')
    write(tools / "mcp/scrapling/server.py", f'"""Scrapling as a stdio MCP server, product wrapper."""\nVERSION = "{version}"\n')
    product_tools.build_bundle(root)


def deliver(stage_root, app):
    target = app / "environments/installer/system-tools.zip"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(stage_root / "environments/installer/system-tools.zip", target)


class ProductToolsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.old, self.new, self.app = (self.base / name for name in ("old", "new", "app"))
        stage(self.old, "1.0.0")
        stage(self.new, "2.0.0")

    def test_console_launchers_bind_to_the_installed_interpreter(self):
        python = self.app / "environments/python/python.exe"
        (python.parent / "Scripts").mkdir(parents=True)
        entries = [SimpleNamespace(name="pip", value="fixture:main"), SimpleNamespace(name="other", value="fixture:other")]
        with patch.object(product_tools.sys, "executable", str(python)), \
             patch.object(product_tools.importlib.metadata, "entry_points", return_value=entries), \
             patch("pip._vendor.distlib.scripts.ScriptMaker") as factory:
            result = product_tools.relocate_console_launchers(self.app)
        maker = factory.return_value
        self.assertEqual(maker.executable, str(python.resolve()))
        commands = [call.args[0] for call in maker.make.call_args_list]
        self.assertIn("other = fixture:other", commands)
        self.assertIn(f"pip{product_tools.sys.version_info.major}.{product_tools.sys.version_info.minor} = fixture:main", commands)
        self.assertEqual(result["console_launchers_relocated"], 2)

    def test_unsafe_console_metadata_is_rejected_before_writing(self):
        python = self.app / "environments/python/python.exe"
        for name in ("../outside", "NUL", "con.exe", "name:stream", "trailing."):
            with self.subTest(name=name), patch.object(product_tools.sys, "executable", str(python)), \
                 patch.object(product_tools.importlib.metadata, "entry_points", return_value=[SimpleNamespace(name=name, value="fixture:main")]), \
                 patch("pip._vendor.distlib.scripts.ScriptMaker") as factory:
                with self.assertRaisesRegex(ValueError, "Unsafe"):
                    product_tools.relocate_console_launchers(self.app)
                factory.assert_not_called()

    def test_conflicting_console_commands_are_not_overwritten(self):
        python = self.app / "environments/python/python.exe"
        entries = [SimpleNamespace(name="Tool", value="a:main"), SimpleNamespace(name="tool", value="b:main")]
        with patch.object(product_tools.sys, "executable", str(python)), \
             patch.object(product_tools.importlib.metadata, "entry_points", return_value=entries):
            with self.assertRaisesRegex(ValueError, "Conflicting"):
                product_tools.relocate_console_launchers(self.app)

    def test_unowned_wiki_archive_is_preserved(self):
        self.install_old()
        tools = self.app / "environments/tools"
        owner = tools / product_tools.OWNERSHIP
        ownership = json.loads(owner.read_text())
        ownership["programs"] = [entry for entry in ownership["programs"] if entry["id"] != "llmwiki-archive"]
        owner.write_text(json.dumps(ownership))
        archive = tools / product_tools.PROGRAMS["llmwiki-archive"]
        archive.write_text("custom archive")
        deliver(self.new, self.app)
        with self.assertRaisesRegex(ValueError, "Unowned llmwiki archive"):
            migrate(self.app)
        self.assertEqual(archive.read_text(), "custom archive")
        self.assert_old()

    def install_old(self):
        deliver(self.old, self.app)
        for info in (self.old / "environments/python/Lib/site-packages").iterdir():
            shutil.copytree(info, self.app / "environments/python/Lib/site-packages" / info.name)
        migrate(self.app)

    def assert_old(self):
        actual = self.app / "environments/tools/mcp/code-review-graph/code_review_graph/program.py"
        self.assertIn("1.0.0", actual.read_text())

    @unittest.skipUnless(os.name == "nt", "Windows staging DACL regression")
    def test_existing_private_program_access_is_repaired_and_stays_inherited(self):
        self.install_old()
        tools = self.app / "environments/tools"
        environment = {key: value for key, value in os.environ.items() if key.upper() != "PSMODULEPATH"}
        target = str(tools / product_tools.PROGRAMS["llmwiki-modules"]).replace("'", "''")
        command = f"$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath '{target}'; $acl.SetAccessRuleProtection($true,$true); Set-Acl -LiteralPath '{target}' -AclObject $acl"
        subprocess.run(["powershell.exe", "-NoProfile", "-Command", command], check=True, capture_output=True, env=environment)
        for attempt in range(2):
            migrate(self.app)
            for relative in (*product_tools.PROGRAMS.values(), product_tools.OWNERSHIP):
                target = str(tools / relative).replace("'", "''")
                command = f"$ErrorActionPreference='Stop'; if ((Get-Acl -LiteralPath '{target}').AreAccessRulesProtected) {{ throw 'Program retained private staging DACL' }}"
                result = subprocess.run(["powershell.exe", "-NoProfile", "-Command", command], capture_output=True, text=True, env=environment)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_clean_install_upgrade_and_custom_data_preservation(self):
        tools = self.app / "environments/tools"
        preserved = {"mcp/mcp_settings.json": json.dumps({"mcpServers": {"custom": {"command": "custom", "env": {"SECRET_REFERENCE": "unchanged"}}}}),
                     "skills/custom/SKILL.md": "custom skill", "hooks/custom.py": "custom hook",
                     "mcp/llmwiki/knowledge.sqlite": "private knowledge", "mcp/custom/server.py": "custom MCP"}
        for name, contents in preserved.items():
            write(tools / name, contents)
        self.install_old()
        self.assert_old()
        deliver(self.new, self.app)
        migrate(self.app)
        for name, contents in preserved.items():
            if name.endswith("mcp_settings.json"):
                self.assertEqual(json.loads((tools / name).read_text()), json.loads(contents))
            else:
                self.assertEqual((tools / name).read_text(), contents)
        self.assertIn("2.0.0", (tools / "mcp/code-review-graph/code_review_graph/program.py").read_text())
        self.assertIn("2.0.0", (tools / "mcp/llmwiki/node_modules/@llmwiki/core/program.js").read_text())
        self.assertEqual(list(tools.glob(".octocode-program-update-*")), [])
        migrate(self.app)

    def test_legacy_custom_builtin_configuration_and_top_level_fields_preserved(self):
        self.install_old()
        settings = self.app / "environments/tools/mcp/mcp_settings.json"
        legacy = self.app / "data/user-data/User/globalStorage/octocode.octocode/settings/mcp_settings.json"
        custom = {"mcpServers": {"code-review-graph": {"command": "custom-python", "args": ["-m", "code_review_graph"],
                   "env": {"PYTHONPATH": "custom-private-path"}, "disabled": True}}, "ui": {"privatePreference": True}}
        write(legacy, json.dumps(custom))
        settings.unlink()
        deliver(self.new, self.app)
        migrate(self.app)
        self.assertEqual(json.loads(settings.read_text()), custom)
        self.assertFalse(legacy.exists())

    def test_modified_managed_program_is_preserved(self):
        self.install_old()
        changed = self.app / "environments/tools/mcp/llmwiki/node_modules/@llmwiki/core/program.js"
        changed.write_text("custom modification")
        deliver(self.new, self.app)
        with self.assertRaisesRegex(ValueError, "Modified product program"):
            migrate(self.app)
        self.assertEqual(changed.read_text(), "custom modification")
        self.assert_old()

    def test_incomplete_unrelated_metadata_does_not_block_legacy_upgrade(self):
        self.install_old()
        tools = self.app / "environments/tools"
        (tools / product_tools.OWNERSHIP).unlink()
        (tools / product_tools.PROGRAMS["llmwiki-archive"]).unlink()
        site = self.app / "environments/python/Lib/site-packages"
        write(site / "unrelated-1.0.dist-info/licenses/LICENSE", "retained license")
        deliver(self.new, self.app)
        migrate(self.app)
        self.assertIn("2.0.0", (tools / "mcp/code-review-graph/code_review_graph/program.py").read_text())
        self.assertEqual((site / "unrelated-1.0.dist-info/licenses/LICENSE").read_text(), "retained license")

    def test_uninstall_metadata_leftovers_are_retained_outside_python_search_path(self):
        site = self.app / "environments/python/Lib/site-packages"
        version = next(line.split("==", 1)[1].split()[0] for line in Path(product_tools.__file__).with_name("runtime-python-requirements.txt").read_text().splitlines() if line.startswith("mcp=="))
        write(site / f"mcp-{version}.dist-info/METADATA", f"Name: mcp\nVersion: {version}\n")
        old = site / "mcp-0.0.1.dist-info"
        write(old / "licenses/LICENSE", "retained original license")
        with product_tools.retire_incomplete_runtime_metadata(self.app):
            self.assertFalse(old.exists())
        copies = list((self.app / "backups/python-metadata").glob("*/mcp-0.0.1.dist-info/licenses/LICENSE"))
        self.assertEqual(len(copies), 1)
        self.assertEqual(copies[0].read_text(), "retained original license")
        write(old / "PRIVATE.txt", "preserve on failed initialization")
        with self.assertRaisesRegex(RuntimeError, "downstream failure"):
            with product_tools.retire_incomplete_runtime_metadata(self.app):
                raise RuntimeError("downstream failure")
        self.assertEqual((old / "PRIVATE.txt").read_text(), "preserve on failed initialization")
        (site / f"mcp-{version}.dist-info/METADATA").unlink()
        with self.assertRaisesRegex(ValueError, "No verified current runtime metadata"):
            with product_tools.retire_incomplete_runtime_metadata(self.app):
                pass
        self.assertEqual((old / "PRIVATE.txt").read_text(), "preserve on failed initialization")

    def test_build_baseline_survives_next_wheel_replacing_its_record(self):
        tools = self.old / "environments/tools"
        baseline = product_tools.read_ownership(tools, self.old / "environments")
        self.assertEqual(set(baseline), set(product_tools.PROGRAMS))
        site = self.old / "environments/python/Lib/site-packages"
        shutil.rmtree(site / "code_review_graph-1.0.0.dist-info")
        shutil.copytree(self.new / "environments/python/Lib/site-packages/code_review_graph-2.0.0.dist-info",
                        site / "code_review_graph-2.0.0.dist-info")
        shutil.copytree(self.new / "environments/tools/mcp/code-review-graph/code_review_graph", site / "code_review_graph")
        migrate(self.old, packaging=True)
        self.assertIn("2.0.0", (tools / "mcp/code-review-graph/code_review_graph/program.py").read_text())

    def test_legacy_custom_namespace_file_conflicts_before_replacement(self):
        self.install_old()
        tools = self.app / "environments/tools"
        (tools / product_tools.OWNERSHIP).unlink()
        write(tools / "mcp/code-review-graph/code_review_graph/custom-user.txt", "private")
        deliver(self.new, self.app)
        with self.assertRaisesRegex(ValueError, "Unknown Python namespace"):
            migrate(self.app)
        self.assert_old()

    def test_legacy_custom_node_package_conflicts(self):
        self.install_old()
        tools = self.app / "environments/tools"
        (tools / product_tools.OWNERSHIP).unlink()
        write(tools / "mcp/llmwiki/node_modules/custom/package.json", '{"name":"custom","version":"1.0.0"}')
        deliver(self.new, self.app)
        with self.assertRaisesRegex(ValueError, "Custom Node package"):
            migrate(self.app)
        self.assert_old()

    def test_payload_checksum_failure_preserves_all_programs(self):
        self.install_old()
        deliver(self.new, self.app)
        bundle = self.app / "environments/installer/system-tools.zip"
        with zipfile.ZipFile(bundle) as archive:
            items = {name: archive.read(name) for name in archive.namelist()}
        items["programs/code-review-graph/program.py"] = b"corrupt"
        with zipfile.ZipFile(bundle, "w") as archive:
            for name, data in items.items():
                archive.writestr(name, data)
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            migrate(self.app)
        self.assert_old()

    def test_old_metadata_retired_without_shadow_namespace(self):
        self.install_old()
        site = self.app / "environments/python/Lib/site-packages"
        site.mkdir(parents=True, exist_ok=True)
        for source in (self.old, self.new):
            for info in (source / "environments/python/Lib/site-packages").glob("code_review_graph-*.dist-info"):
                shutil.copytree(info, site / info.name, dirs_exist_ok=True)
        deliver(self.new, self.app)
        migrate(self.app)
        self.assertFalse((site / "code_review_graph-1.0.0.dist-info").exists())
        self.assertTrue((site / "code_review_graph-2.0.0.dist-info").exists())

    def test_modified_legacy_namespace_is_preserved(self):
        self.install_old()
        tools = self.app / "environments/tools"
        (tools / product_tools.OWNERSHIP).unlink()
        changed = tools / "mcp/code-review-graph/code_review_graph/program.py"
        changed.write_text("custom Python program modification")
        deliver(self.new, self.app)
        with self.assertRaisesRegex(ValueError, "Modified legacy Python namespace"):
            migrate(self.app)
        self.assertEqual(changed.read_text(), "custom Python program modification")

    def test_unknown_old_metadata_file_preserved_and_programs_rolled_back(self):
        self.install_old()
        note = self.app / "environments/python/Lib/site-packages/code_review_graph-1.0.0.dist-info/PRIVATE_NOTE.txt"
        note.write_text("custom metadata note")
        deliver(self.new, self.app)
        with self.assertRaisesRegex(ValueError, "Modified old metadata"):
            migrate(self.app)
        self.assertEqual(note.read_text(), "custom metadata note")
        self.assert_old()

    def test_mid_transaction_failure_rolls_back_all_programs(self):
        self.install_old()
        owner = self.app / "environments/tools" / product_tools.OWNERSHIP
        previous_owner = owner.read_bytes()
        deliver(self.new, self.app)
        real_replace = product_tools.os.replace
        failed = False

        def fail_second_program(source, target):
            nonlocal failed
            if Path(source).name == "llmwiki-modules" and not failed:
                failed = True
                raise OSError("simulated replacement failure")
            return real_replace(source, target)

        with patch.object(product_tools.os, "replace", side_effect=fail_second_program):
            with self.assertRaisesRegex(OSError, "simulated"):
                migrate(self.app)
        self.assertTrue(failed)
        self.assert_old()
        self.assertEqual(owner.read_bytes(), previous_owner)
        self.assertIn("1.0.0", (self.app / "environments/tools/mcp/llmwiki/node_modules/@llmwiki/core/program.js").read_text())

    def test_downgrade_rejected(self):
        deliver(self.new, self.app)
        migrate(self.app)
        deliver(self.old, self.app)
        with self.assertRaisesRegex(ValueError, "downgrade"):
            migrate(self.app)

    def test_installed_python_namespace_upgrade_verifies_record(self):
        self.install_old()
        source = self.app / "environments/python/Lib/site-packages/code_review_graph"
        shutil.copytree(self.new / "environments/tools/mcp/code-review-graph/code_review_graph", source)
        info = source.parent / "code_review_graph-2.0.0.dist-info"
        write(info / "METADATA", "Name: code-review-graph\nVersion: 2.0.0\n")
        records = []
        for path in source.iterdir():
            value = base64.urlsafe_b64encode(bytes.fromhex(product_tools.digest(path))).rstrip(b"=").decode()
            records.append(f"code_review_graph/{path.name},sha256={value},{path.stat().st_size}")
        write(info / "RECORD", "\n".join(records))
        (self.app / "environments/installer/system-tools.zip").unlink()
        migrate(self.app)
        self.assertFalse(source.exists())
        self.assertIn("2.0.0", (self.app / "environments/tools/mcp/code-review-graph/code_review_graph/program.py").read_text())

    def test_unapproved_destination_link_refused(self):
        self.install_old()
        target = self.app / "environments/tools/mcp/code-review-graph/code_review_graph"
        outside = self.base / "outside"
        target.rename(outside)
        try:
            target.symlink_to(outside, target_is_directory=True)
        except OSError as error:
            if os.name != "nt":
                raise
            script = self.base / "create-junction.ps1"
            script.write_text("param([string]$Link,[string]$Target)\n$ErrorActionPreference='Stop'\nNew-Item -ItemType Junction -Path $Link -Target $Target | Out-Null\n")
            subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"),
                            "-NoProfile", "-File", str(script), "-Link", str(target), "-Target", str(outside)], check=True, capture_output=True)
        self.addCleanup(lambda: target.rmdir() if target.is_junction() else target.unlink())
        if os.name == "nt":
            probe = subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"),
                                    "-NoProfile", "-File", str(Path(__file__).parent.parent / "win32/octocode-validate-tools.ps1"),
                                    "-AppRoot", str(self.app)], capture_output=True)
            self.assertNotEqual(probe.returncode, 0)
            self.assertIn(b"Linked tool installation content", probe.stderr)
            # The installer writes helpers before Python runs, so it must also
            # reject links above AppRoot rather than checking only descendants.
            parent_link = self.base / "linked-parent"
            script = self.base / "create-parent-junction.ps1"
            script.write_text("param([string]$Link,[string]$Target)\n$ErrorActionPreference='Stop'\nNew-Item -ItemType Junction -Path $Link -Target $Target | Out-Null\n")
            subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"),
                            "-NoProfile", "-File", str(script), "-Link", str(parent_link), "-Target", str(self.base)], check=True, capture_output=True)
            self.addCleanup(parent_link.rmdir)
            parent_probe = subprocess.run([str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"),
                                           "-NoProfile", "-File", str(Path(__file__).parent.parent / "win32/octocode-validate-tools.ps1"),
                                           "-AppRoot", str(parent_link / "app")], capture_output=True)
            self.assertNotEqual(parent_probe.returncode, 0)
            self.assertIn(b"Unapproved application storage link", parent_probe.stderr)
        deliver(self.new, self.app)
        with self.assertRaisesRegex(ValueError, "linked|storage link"):
            migrate(self.app)
        self.assertIn("1.0.0", (outside / "program.py").read_text())


if __name__ == "__main__":
    unittest.main(verbosity=2)
