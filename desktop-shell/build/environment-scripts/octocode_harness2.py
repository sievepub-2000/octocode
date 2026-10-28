"""Google Harness2 recursion over OctoCode's existing local task/model API."""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
import sys
import tempfile
import time
from types import SimpleNamespace
from urllib.parse import urlparse
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent / "harness2_vendor"))
from harness2.core import prompts, recursion, tree
from harness2.core.proposer import Reply, ProposerError
from harness2.core.spec import BenchPrompts, BenchSpec, ChannelSpec, RunView

SURFACE = tree.SurfaceSpec(
    # Reuse upstream's AGENTS.md prompt vocabulary; validate_prompt narrows its surface.
    name="codex", always_on=("AGENTS.md",), always_on_max=8000,
    always_on_cap_reason="Task-local guidance is passed whole to every rollout.",
    skill_dir=".agents/skills", skill_name_rule="must_match", trigger_hint="",
    autotrigger_file="AGENTS.md", trigger_line="", subagent_requires_mode=False,
    plugin_dir=None, hooks_file=None, reject_empty_always_on=True,
)


class Client:
    def __init__(self, url: str, timeout: int = 600, model: dict | None = None):
        parsed = urlparse(url)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.username or parsed.password:
            raise ValueError("Harness2 requires an HTTP loopback OctoCode API URL")
        self.url, self.timeout = url.rstrip("/"), timeout
        self.model = model

    def request(self, path: str, payload: dict | None = None) -> dict:
        headers = {"Content-Type": "application/json"}
        root = Path(os.environ.get("OCTOCODE_ROOT", Path(sys.executable).resolve().parents[2]))
        token_file = root / "data/user-data/User/globalStorage/octocode.octocode/daemon/api-token"
        token = os.environ.get("OCTOCODE_API_TOKEN")
        if not token and token_file.is_file():
            token = token_file.read_text(encoding="utf-8").strip()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = Request(self.url + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
        with urlopen(request, timeout=30) as response:
            if path.endswith("/events"):
                return {"events": [json.loads(line[6:]) for line in response if line.startswith(b"data: ")]}
            return json.load(response)

    def run(self, prompt: str, cwd: Path) -> dict:
        # Native directory permissions stay enforced; no approval bypass or session reuse.
        payload = {"prompt": prompt, "cwd": str(cwd), "permission_mode": "directory", "review": True}
        if self.model is not None:
            payload["model"] = self.model
        run = self.request("/v1/runs", payload)
        run_id = run["run_id"]
        deadline = time.monotonic() + self.timeout
        try:
            while run["status"] == "running":
                if time.monotonic() >= deadline:
                    raise TimeoutError("OctoCode Harness2 rollout timed out")
                time.sleep(0.25)
                run = self.request(f"/v1/runs/{run_id}")
        except BaseException:
            self.request(f"/v1/runs/{run_id}/cancel", {})
            raise
        if run["status"] != "completed" or not run.get("text", "").strip():
            raise RuntimeError(f"OctoCode run {run_id} did not produce an answer ({run['status']})")
        run["events"] = self.request(f"/v1/runs/{run_id}/events")["events"]
        return run


def validate_prompt(value: dict) -> None:
    if not isinstance(value, dict) or set(value) != {"AGENTS.md"} or not isinstance(value["AGENTS.md"], str):
        raise ValueError('Only {"AGENTS.md": "task guidance"} is editable')
    tree.validate(SURFACE, value, allow_subagents=False)


class Adapter:
    def __init__(self, client: Client, cwd: Path, prompt: str, work: Path):
        self.client, self.cwd, self.prompt, self.work = client, cwd, prompt, work
        self.substrate = SimpleNamespace(surface=lambda: SURFACE)
        channel = ChannelSpec("opencode", "octocode/saved-model")
        self.spec = BenchSpec("octocode", work, "workspace_agents_md", BenchPrompts(
            work="Complete the user's task using the available project evidence.",
            yardstick="Give a correct, useful answer grounded in observed evidence.",
        ), {"proposer": channel, "selector": channel})

    def task_prompt(self, task_id):
        return self.prompt

    def task_files(self, task_id):
        return None

    def domain_of(self, task_id):
        return "project"

    def validate_tree(self, value):
        validate_prompt(value)

    def execute(self, task_id, harness_dir, run_id, *, timeout=None):
        guidance = (Path(harness_dir) / "AGENTS.md").read_text(encoding="utf-8") if harness_dir else ""
        result = self.client.run(f"Task-local working guidance:\n{guidance}\n\nUser task:\n{self.prompt}", self.cwd)
        folder = self.work / "runs" / run_id
        folder.mkdir(parents=True)
        (folder / "answer.md").write_text(result["text"], encoding="utf-8")
        events = [event for event in result.pop("events", []) if event.get("type") in ("tool_call", "tool_call_update", "error", "text")]
        (folder / "trajectory.json").write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding="utf-8")
        (folder / "run.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        return folder

    def delivered(self, folder):
        return (folder / "answer.md").is_file()

    def deliverable_text(self, folder):
        return (folder / "answer.md").read_text(encoding="utf-8")

    def trajectory(self, folder, *, obs_trunc):
        events = json.loads((folder / "trajectory.json").read_text(encoding="utf-8"))
        tags = {"tool_call": "ACTION", "tool_call_update": "OBSERVATION", "error": "ERROR", "text": "OBSERVATION"}
        return "\n".join(f"[{tags[event['type']]}]\n{json.dumps(event, ensure_ascii=False)[:obs_trunc]}" for event in events) or "[OBSERVATION]\n" + self.deliverable_text(folder)


class Proposer:
    def __init__(self, client):
        self.client = client

    def call(self, mission, context_dir, label, **kwargs):
        root = Path(context_dir)
        evidence = "\n\n".join(f"## {p.relative_to(root).as_posix()}\n{p.read_text(encoding='utf-8')}"
                                for p in sorted(root.rglob("*")) if p.is_file() and ".octocode" not in p.relative_to(root).parts)
        # The pinned upstream decision mission stays; replace its filesystem output protocol.
        mission = mission.replace(prompts._SURFACE_CODEX,
            '# EDITABLE SURFACE\nOnly AGENTS.md text is editable. Return the complete text as JSON; '
            'if no change is supported by the evidence, return the current text unchanged.')
        mission = mission.replace("It is on disk, in `context/`. Read it -- do not answer from this message alone.",
            "All context evidence is embedded below; inspect it in this message without tools.")
        mission = mission.replace("Fix it in `context/harness/` and reply again.", "Correct the JSON proposal and reply again.")
        mission = mission.replace("the harness directory did not come back from the session; edit the files in `context/harness/` in place",
            "The previous reply did not produce a valid JSON guidance proposal; correct its JSON syntax and response format")
        try:
            result = self.client.run("All relevant evidence is embedded below. Do not call tools: "
                "perform this guidance revision entirely in your JSON reply. Only AGENTS.md text is supported; "
                "other components mentioned in the upstream mission are unavailable.\n\n" + mission + "\n\n" + evidence +
                '\n\nFirst output one JSON object {"AGENTS.md":"complete revised guidance"}. '
                'You may append one <notes>...</notes> block for the mission decisions. Put all rationale inside that block. '
                'No prose before the JSON, markdown fences, or other trailing text. Do not call tools or edit files. '
                'Do not add hooks, scripts, skills, permissions, or model settings.', root)
            text = result["text"].strip()
            if text.startswith("```"):
                _, separator, body = text.partition("\n")
                if not separator or not body.endswith("```"):
                    raise ValueError("A fenced proposal must end with its closing fence")
                text = body[:-3].strip()
            value, end = json.JSONDecoder().raw_decode(text)
            notes = text[end:].strip()
            match = re.fullmatch(r"<notes>(.*?)</notes>", notes, re.S) if notes else None
            if notes and (match is None or "<notes>" in match[1] or "</notes>" in match[1]):
                raise ValueError("Only one optional <notes> block may follow the JSON proposal")
            validate_prompt(value)
            tree.write_tree(SURFACE, value, root / "harness")
            return Reply(label, notes or "Updated task-local guidance.", True, attempts=1, workspace=root / "harness")
        except ValueError as error:
            # Let upstream perform its one invalid-proposal retry and retain the base.
            return Reply(label, str(error), True, attempts=1, workspace=None)
        except (OSError, RuntimeError) as error:
            raise ProposerError(str(error), attempts=1) from error


def run(client: Client, cwd: Path, prompt: str, *, mode="seq", k=1, adopt=False):
    cwd = cwd.resolve(strict=True)
    if not cwd.is_dir() or not prompt.strip() or not 1 <= k <= 4 or mode not in ("seq", "agg"):
        raise ValueError("An existing project directory, nonempty task, mode seq/agg, and depth 1..4 are required")
    parent = cwd / ".octocode" / "harness2"
    if not parent.resolve().is_relative_to(cwd):
        raise ValueError("Harness2 output leaves the project")
    parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
    adapter = Adapter(client, cwd, prompt, work)
    base_tree = {"AGENTS.md": "Read the project evidence, follow existing project instructions, and verify your answer.\n"}
    adopted = parent / "adopted.json"
    if not adopted.resolve().is_relative_to(parent.resolve()):
        raise ValueError("Adopted guidance leaves the project state directory")
    if adopted.exists():
        base_tree = json.loads(adopted.read_text(encoding="utf-8"))
        validate_prompt(base_tree)
    base_dir = tree.write_tree(SURFACE, base_tree, work / "base")
    base = []
    for index in range(k):
        label = f"base{index + 1}"
        folder = adapter.execute("task", base_dir, label)
        base.append(RunView(label, label, folder, True, True))
    result = recursion.run_mode(mode, "task", k, base, adapter=adapter, prop=Proposer(client),
        work_dir=work, run_id_of=lambda label: label, base_tree=base_tree,
        propose_workers=1, rollout_workers=1)
    summary = result.to_dict()
    summary["output_dir"] = str(work)
    summary["ok"] = result.ok and not result.fell_back and all(r.ok and r.delivered for r in result.rollouts.values())
    final = result.rollouts.get(result.finals[-1]) if result.finals else None
    summary["answer"] = adapter.deliverable_text(final.run_dir) if final and final.ok else ""
    summary["adopted"] = bool(adopt and summary["ok"])
    if summary["adopted"]:
        guidance = result.trees[result.finals[-1]]
        validate_prompt(guidance)
        pending = work / "adopted.json"
        pending.write_text(json.dumps(guidance, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(pending, adopted)
    (work / "result.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Run Google Harness2 recursion with OctoCode's saved model. Uses read-only directory permissions; depth 1 costs 7 model sessions.")
    parser.add_argument("prompt")
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--api-url", default="http://127.0.0.1:8765")
    parser.add_argument("--mode", choices=("seq", "agg"), default="seq")
    parser.add_argument("--depth", type=int, choices=range(1, 5), default=1)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--model", help="Explicit OpenAI-compatible model; pair with --base-url")
    parser.add_argument("--base-url", help="Explicit model endpoint; pair with --model")
    parser.add_argument("--context-window", type=int, help="Explicit context limit when model metadata is unavailable")
    parser.add_argument("--adopt", action="store_true", help="Keep successful final guidance in this project's Harness2 state for later runs")
    args = parser.parse_args()
    if bool(args.model) != bool(args.base_url):
        parser.error("--model and --base-url must be supplied together")
    model = {"model": args.model, "base_url": args.base_url} if args.model else None
    if args.context_window is not None:
        model = {**(model or {}), "context_window": args.context_window}
    if model is not None and os.environ.get("OCTOCODE_MODEL_API_KEY"):
        model["api_key"] = os.environ["OCTOCODE_MODEL_API_KEY"]
    try:
        result = run(Client(args.api_url, args.timeout, model), args.cwd, args.prompt, mode=args.mode, k=args.depth, adopt=args.adopt)
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Harness2 failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
