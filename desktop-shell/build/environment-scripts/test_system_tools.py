import json
from pathlib import Path
from tempfile import TemporaryDirectory
from system_tools import migrate


def check():
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        legacy = root / "data/user-data/User/globalStorage/octocode.octocode/harness-runtime/skills/demo/SKILL.md"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("original", encoding="utf-8")
        project_skill = root / "workspace/.agents/skills/private/SKILL.md"
        project_skill.parent.mkdir(parents=True)
        project_skill.write_text("project only", encoding="utf-8")
        config = root / "data/user-data/User/globalStorage/octocode.octocode/settings/mcp_settings.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"mcpServers": {"demo": {"command": "demo"}}}), encoding="utf-8")
        result = migrate(root)
        installed = root / "environments/tools/skills/demo/SKILL.md"
        assert result["files_verified"] == 1 and installed.read_text() == "original"
        assert not legacy.exists() and not config.exists()
        assert project_skill.read_text(encoding="utf-8") == "project only"
        assert not (root / "environments/tools/skills/private").exists()
        assert migrate(root)["files_verified"] == 0
        authoritative = root / "environments/tools/mcp/mcp_settings.json"
        current = json.loads(authoritative.read_text(encoding="utf-8"))
        current["mcpServers"]["code-review-graph"] = {
            "command": "python", "args": ["-m", "code_review_graph"],
            "env": {"PYTHONPATH": "${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/code-review-graph"},
        }
        current["mcpServers"]["llm-wiki"] = {
            "command": "node", "args": ["${env:OCTOCODE_ENVIRONMENTS}/tools/mcp/llmwiki/server.js"],
        }
        authoritative.write_text(json.dumps(current), encoding="utf-8")
        config.write_text(json.dumps({"mcpServers": {
            "code-review-graph": {"command": "python", "args": ["-m", "code_review_graph"]},
            "llm-wiki": {"command": "node", "args": ["${env:OCTOCODE_ENVIRONMENTS}/llmwiki/server.js"]},
        }}), encoding="utf-8")
        assert migrate(root)["mcp_configs_merged"] == 1
        assert not config.exists()
        cache_source = legacy.parent / "__pycache__" / "generated.pyc"
        cache_target = installed.parent / "__pycache__" / "generated.pyc"
        cache_source.parent.mkdir(parents=True)
        cache_target.parent.mkdir(parents=True)
        cache_source.write_bytes(b"old generated cache")
        cache_target.write_bytes(b"new generated cache")
        assert migrate(root)["files_verified"] == 0
        assert cache_target.read_bytes() == b"new generated cache"
        config.write_text(json.dumps({"mcpServers": {"code-review-graph": {"command": "different"}}}), encoding="utf-8")
        try:
            migrate(root)
        except ValueError as error:
            assert "Conflicting MCP configuration" in str(error)
        else:
            raise AssertionError("Expected custom configuration conflict")
        assert config.exists()
        config.unlink()
        legacy.parent.mkdir(parents=True)
        legacy.write_text("conflicting edit", encoding="utf-8")
        try:
            migrate(root)
        except ValueError as error:
            assert "Conflicting" in str(error)
        else:
            raise AssertionError("Expected conflict")
        assert legacy.read_text() == "conflicting edit" and installed.read_text() == "original"
    print("system tools migration: copy/read-back, source cleanup, idempotency, conflict preservation passed")


if __name__ == "__main__":
    check()
