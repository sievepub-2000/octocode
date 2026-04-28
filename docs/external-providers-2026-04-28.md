# External Providers Catalog (2026-04-28)

This document catalogs every provider exposed by the two GitHub projects you asked
octocode to integrate with, plus the matching octocode profile registered in
`%APPDATA%\octocode\provider-profiles.json` (52 entries).

> **Compatibility note** — Octocode speaks **OpenAI Chat Completions** at
> `<base>/v1/chat/completions`. Both projects below are primarily **Anthropic
> Messages** proxies, but each one re-exposes its upstreams as separate routes,
> and most of those upstreams (NVIDIA NIM, OpenRouter, DeepSeek, Groq, Cerebras,
> SambaNova, Mistral, etc.) are themselves OpenAI-compatible. The profiles below
> point octocode at OpenAI-compatible endpoints whenever possible. If a profile's
> base URL is the proxy itself (`localhost:18765` / `localhost:8082`), it
> requires the proxy to be installed and running.

## Project 1 — `romgX/openrelay`

- Repo: <https://github.com/romgX/openrelay>
- Type: Local desktop binary (Windows / macOS / Linux). Endpoint
  `http://localhost:18765`.
- Routing: `http://localhost:18765/<provider>/v1` for per-provider routes.
- Speaks: Anthropic Messages **and** OpenAI Chat Completions.
- 32 providers (8 IDE auto-discover + 24 direct API).

| # | Provider sub-route          | Profile id (provider-profiles.json) | Flagship model in profile                         | Notes                                                  |
|---|------------------------------|--------------------------------------|---------------------------------------------------|--------------------------------------------------------|
|  1| (default)                    | `10-openrelay-direct`                | `auto`                                            | OpenRelay default route                                |
|  2| `kiro`                       | `11-openrelay-kiro`                  | `claude-sonnet-4.5`                               | Kiro free 50 + 500 credits/month                       |
|  3| `claude-desktop`             | `12-openrelay-claude-desktop`        | `claude-opus-4.7`                                 | Auto-discovers your Claude Desktop subscription        |
|  4| `claude-code`                | `13-openrelay-claude-code`           | `claude-sonnet-4.5`                               | Auto-discovers your Claude Code subscription           |
|  5| `windsurf`                   | `14-openrelay-windsurf`              | `claude-sonnet-4`                                 | Windsurf IDE free quota                                |
|  6| `antigravity`                | `15-openrelay-antigravity`           | `gemini-2.5-pro`                                  | Antigravity Gemini route                               |
|  7| `opencode`                   | `16-openrelay-opencode`              | `glm-4.7`                                         | Built-in GLM-4.7                                       |
|  8| `copilot` (VS Code)          | `17-openrelay-vscode-copilot`        | `gpt-5`                                           | VS Code Copilot subscription auto-discover             |
|  9| `codex`                      | `18-openrelay-codex`                 | `gpt-5.4-codex`                                   | OpenAI Codex free GPT-5.4                              |
| 10| `groq`                       | `20-openrelay-groq`                  | `llama-3.3-70b-versatile`                         | Groq, very fast                                        |
| 11| `cerebras`                   | `21-openrelay-cerebras`              | `llama-3.3-70b`                                   | Cerebras, 1M tok/day free                              |
| 12| `sambanova`                  | `22-openrelay-sambanova`             | `Meta-Llama-4-Maverick-17B-128E-Instruct`         | SambaNova, 200K tok/day free                           |
| 13| `gemini`                     | `23-openrelay-gemini`                | `gemini-2.5-pro`                                  | Google Gemini API, 1M ctx free                         |
| 14| `deepseek`                   | `24-openrelay-deepseek`              | `deepseek-reasoner`                               | DeepSeek, $5M signup credit                            |
| 15| `mistral`                    | `25-openrelay-mistral`               | `codestral-latest`                                | Mistral, 1B tok/month free                             |
| 16| `xai`                        | `26-openrelay-xai`                   | `grok-4`                                          | xAI Grok                                               |
| 17| `together`                   | `27-openrelay-together`              | `Qwen/Qwen3-Coder-480B-A35B-Instruct`             | Together AI, $100 free                                 |
| 18| `fireworks`                  | `28-openrelay-fireworks`             | `accounts/fireworks/models/deepseek-v3p1`         | Fireworks AI                                           |
| 19| `siliconflow`                | `29-openrelay-siliconflow`           | `Qwen/Qwen3-Coder-480B-A35B-Instruct`             | SiliconFlow, 20M tok free                              |
| 20| `zhipu`                      | `30-openrelay-zhipu-glm`             | `glm-4.6`                                         | Zhipu GLM, GLM-4-Flash is free                         |
| 21| `dashscope`                  | `31-openrelay-dashscope-qwen`        | `qwen3-max`                                       | Alibaba DashScope, ¥450 free                           |
| 22| `volcengine`                 | `32-openrelay-volcengine`            | `deepseek-v3-241226`                              | ByteDance Volcengine, ¥100/2M day                      |
| 23| `moonshot`                   | `33-openrelay-moonshot-kimi`         | `kimi-k2-thinking`                                | Moonshot Kimi, 1.5M tok/day free                       |
| 24| `nvidia`                     | `34-openrelay-nvidia-nim`            | `deepseek-ai/deepseek-v3.2`                       | NVIDIA NIM, ~1000 credits free                         |
| 25| `github`                     | `35-openrelay-github-models`         | `gpt-5`                                           | GitHub Models, 50 req/day GPT-4o-class                 |
| 26| `baichuan`                   | `36-openrelay-baichuan`              | `Baichuan4-Turbo`                                 | Baichuan ¥80 free                                      |
| 27| `stepfun`                    | `37-openrelay-stepfun`               | `step-3-5-flash`                                  | Stepfun                                                |
| 28| `minimax`                    | `38-openrelay-minimax`               | `minimax-m2.7`                                    | MiniMax                                                |
| 29| `hunyuan`                    | `39-openrelay-hunyuan`               | `hunyuan-lite`                                    | Tencent Hunyuan Lite is free                           |
| 30| `anthropic`                  | `40-openrelay-anthropic`             | `claude-opus-4.7`                                 | Anthropic native passthrough                           |
| 31| `cloudflare`                 | `41-openrelay-cloudflare`            | `@cf/meta/llama-3.3-70b-instruct-fp8-fast`        | Cloudflare AI, 10K Neurons/day                         |
| 32| `huggingface`                | `42-openrelay-huggingface`           | `Qwen/Qwen3-Coder-480B-A35B-Instruct`             | HuggingFace Inference                                  |

### Install OpenRelay

1. Download the platform binary from the project's GitHub Releases page.
2. Run the binary; it listens on `http://localhost:18765` and auto-detects any
   IDE subscriptions installed (Claude Desktop, Claude Code, Kiro, Windsurf,
   Antigravity, OpenCode, VS Code Copilot, OpenAI Codex).
3. For direct-API routes (rows 10-32) put the upstream key in OpenRelay's UI.
4. Flip octocode to that route, e.g.:
   ```powershell
   .\scripts\switch-provider.ps1 -Profile openrelay -SubRoute kiro
   .\scripts\switch-provider.ps1 -Profile openrelay -SubRoute nvidia -Model deepseek-ai/deepseek-v3.2
   .\scripts\switch-provider.ps1 -Profile profile-id -ProfileId 24-openrelay-deepseek
   ```

## Project 2 — `Alishahryar1/free-claude-code` (FCC)

- Repo: <https://github.com/Alishahryar1/free-claude-code>
- Type: Python 3.14 + uv, FastAPI/uvicorn proxy on `http://localhost:8082`.
- Speaks: **Anthropic Messages only** (`/v1/messages`). The proxy itself is **not**
  directly usable from octocode (octocode is OpenAI Chat Completions). Use it
  with Claude Code / Claude Desktop, OR point octocode directly at the
  underlying upstream URLs (rows 60-74 below).
- 6 backends (from `config/provider_catalog.py`).
- Model addressing inside the proxy: `provider_id/model/name`,
  e.g. `nvidia_nim/z-ai/glm4.7`.

| Backend       | Native base URL                              | OpenAI compatible? | Octocode profile id                        |
|---------------|----------------------------------------------|--------------------|--------------------------------------------|
| `nvidia_nim`  | `https://integrate.api.nvidia.com/v1`        | yes                | `60-fcc-nvidia-nim-glm47` (and 61-69)      |
| `open_router` | `https://openrouter.ai/api/v1`               | yes                | `70-fcc-openrouter` / `80-83`              |
| `deepseek`    | `https://api.deepseek.com/anthropic`         | no (anthropic)     | `71-fcc-deepseek` (use anthropic provider) |
| `lmstudio`    | `http://localhost:1234/v1`                   | yes                | `72-fcc-lmstudio`                          |
| `llamacpp`    | `http://localhost:8080/v1`                   | yes                | `73-fcc-llamacpp-local`                    |
| `ollama`      | `http://localhost:11434/v1`                  | yes                | `74-fcc-ollama`                            |

### NVIDIA NIM model catalog (selected — full list at the end of this doc)

Top picks for coding + reasoning (already registered as profiles `60`-`69`):

| Profile id                        | Model id                                          | Owner       |
|-----------------------------------|---------------------------------------------------|-------------|
| `60-fcc-nvidia-nim-glm47`         | `z-ai/glm4.7`                                     | z-ai        |
| `61-fcc-nvidia-nim-deepseek-v32`  | `deepseek-ai/deepseek-v3.2`                       | deepseek-ai |
| `62-fcc-nvidia-nim-kimi-k25`      | `moonshotai/kimi-k2.5`                            | moonshotai  |
| `63-fcc-nvidia-nim-kimi-thinking` | `moonshotai/kimi-k2-thinking`                     | moonshotai  |
| `64-fcc-nvidia-nim-qwen3-coder`   | `qwen/qwen3-coder-480b-a35b-instruct`             | qwen        |
| `65-fcc-nvidia-nim-llama4`        | `meta/llama-4-maverick-17b-128e-instruct`         | meta        |
| `66-fcc-nvidia-nim-mistral-large3`| `mistralai/mistral-large-3-675b-instruct-2512`    | mistralai   |
| `67-fcc-nvidia-nim-nemotron-ultra`| `nvidia/llama-3.1-nemotron-ultra-253b-v1`         | nvidia      |
| `68-fcc-nvidia-nim-gpt-oss-120b`  | `openai/gpt-oss-120b`                             | openai      |
| `69-fcc-nvidia-nim-minimax-m27`   | `minimaxai/minimax-m2.7`                          | minimaxai   |

### Install free-claude-code

```powershell
git clone https://github.com/Alishahryar1/free-claude-code.git
cd free-claude-code
uv sync
Copy-Item .env.example .env
# edit .env: set NVIDIA_NIM_API_KEY (and others), keep MODEL=nvidia_nim/z-ai/glm4.7
uv run uvicorn server:app --host 0.0.0.0 --port 8082
```

Then for Claude Code clients:
```
ANTHROPIC_BASE_URL=http://localhost:8082
ANTHROPIC_AUTH_TOKEN=freecc
```

For octocode itself, **do NOT point at port 8082** (Anthropic-only). Instead:
```powershell
# best NVIDIA NIM model for coding + reasoning, direct
.\scripts\switch-provider.ps1 -Profile nvidia-nim -ApiKey nvapi-xxxxx
# or any of the 60-69 profiles
.\scripts\switch-provider.ps1 -Profile profile-id -ProfileId 64-fcc-nvidia-nim-qwen3-coder -ApiKey nvapi-xxxxx
```

## Active state

```text
provider_id      = openrouter
provider_base_url= https://openrouter.ai/api/v1
default_model    = anthropic/claude-opus-4.7
```

Profiles are saved at `%APPDATA%\octocode\provider-profiles.json`.

## Verification status (2026-04-28)

| Test                                                              | Result   |
|-------------------------------------------------------------------|----------|
| `local-openai` (192.168.110.2:8000 / gemma-4-31b-it-q8-prod)      | PASS (1719ms; smoke probe earlier) |
| `openrouter` (no API key in env)                                  | DEFERRED (key missing) |
| `nvidia-nim` direct (no `NVIDIA_NIM_API_KEY` in env)              | DEFERRED (key missing) |
| `openrelay` sub-routes (binary not installed)                     | DEFERRED (proxy not running) |
| `fcc` proxy (Python venv not installed)                           | DEFERRED (proxy not running) |

Provide an API key with `-ApiKey` (or set `$env:OCTOCODE_API_KEY` /
`$env:OPENROUTER_API_KEY` / `$env:NVIDIA_NIM_API_KEY`) and rerun
`scripts/test-provider.ps1` to live-verify each profile.

## Full NVIDIA NIM model id list

Sourced from
`https://raw.githubusercontent.com/Alishahryar1/free-claude-code/main/nvidia_nim_models.json`
(150+ entries). Top owners: `z-ai`, `deepseek-ai`, `qwen`, `moonshotai`,
`mistralai`, `meta`, `nvidia`, `openai`, `google`, `microsoft`, `ibm`,
`bytedance`, `minimaxai`, `stepfun-ai`, `01-ai`, `bigcode`, `databricks`,
`writer`, `upstage`, `sarvamai`, `snowflake`, `zyphra`, `aisingapore`,
`baai`, `abacusai`, `adept`, `ai21labs`, `nv-mistralai`.

Highlights (registered as `60`-`69` above; rest available for ad-hoc
override via `-Model`):

```
01-ai/yi-large
abacusai/dracarys-llama-3.1-70b-instruct
adept/fuyu-8b
ai21labs/jamba-1.5-large-instruct
aisingapore/sea-lion-7b-instruct
baai/bge-m3
bigcode/starcoder2-15b
bytedance/seed-oss-36b-instruct
databricks/dbrx-instruct
deepseek-ai/deepseek-coder-6.7b-instruct
deepseek-ai/deepseek-v3.1-terminus
deepseek-ai/deepseek-v3.2
google/codegemma-1.1-7b
google/codegemma-7b
google/deplot
google/gemma-2-2b-it
google/gemma-2b
google/gemma-3-12b-it
google/gemma-3-27b-it
google/gemma-3-4b-it
google/gemma-3n-e2b-it
google/gemma-3n-e4b-it
google/gemma-4-31b-it
google/recurrentgemma-2b
ibm/granite-3.0-3b-a800m-instruct
ibm/granite-3.0-8b-instruct
ibm/granite-34b-code-instruct
ibm/granite-8b-code-instruct
meta/codellama-70b
meta/llama-3.1-405b-instruct
meta/llama-3.1-70b-instruct
meta/llama-3.1-8b-instruct
meta/llama-3.2-11b-vision-instruct
meta/llama-3.2-1b-instruct
meta/llama-3.2-3b-instruct
meta/llama-3.2-90b-vision-instruct
meta/llama-3.3-70b-instruct
meta/llama-4-maverick-17b-128e-instruct
meta/llama-guard-4-12b
meta/llama2-70b
microsoft/kosmos-2
microsoft/phi-3-vision-128k-instruct
microsoft/phi-3.5-moe-instruct
microsoft/phi-4-mini-instruct
microsoft/phi-4-multimodal-instruct
minimaxai/minimax-m2.5
minimaxai/minimax-m2.7
mistralai/codestral-22b-instruct-v0.1
mistralai/devstral-2-123b-instruct-2512
mistralai/magistral-small-2506
mistralai/ministral-14b-instruct-2512
mistralai/mistral-7b-instruct-v0.3
mistralai/mistral-large
mistralai/mistral-large-2-instruct
mistralai/mistral-large-3-675b-instruct-2512
mistralai/mistral-medium-3-instruct
mistralai/mistral-nemotron
mistralai/mistral-small-4-119b-2603
mistralai/mixtral-8x22b-instruct-v0.1
mistralai/mixtral-8x22b-v0.1
mistralai/mixtral-8x7b-instruct-v0.1
moonshotai/kimi-k2-instruct
moonshotai/kimi-k2-instruct-0905
moonshotai/kimi-k2-thinking
moonshotai/kimi-k2.5
nv-mistralai/mistral-nemo-12b-instruct
nvidia/cosmos-reason2-8b
nvidia/embed-qa-4
nvidia/gliner-pii
nvidia/ising-calibration-1-35b-a3b
nvidia/llama-3.1-nemoguard-8b-content-safety
nvidia/llama-3.1-nemoguard-8b-topic-control
nvidia/llama-3.1-nemotron-51b-instruct
nvidia/llama-3.1-nemotron-70b-instruct
nvidia/llama-3.1-nemotron-nano-8b-v1
nvidia/llama-3.1-nemotron-nano-vl-8b-v1
nvidia/llama-3.1-nemotron-safety-guard-8b-v3
nvidia/llama-3.1-nemotron-ultra-253b-v1
nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1
nvidia/llama-3.2-nemoretriever-300m-embed-v1
nvidia/llama-3.2-nv-embedqa-1b-v1
nvidia/llama-3.2-nv-embedqa-1b-v2
nvidia/llama-3.3-nemotron-super-49b-v1
nvidia/llama-3.3-nemotron-super-49b-v1.5
nvidia/llama-nemotron-embed-1b-v2
nvidia/llama-nemotron-embed-vl-1b-v2
nvidia/llama3-chatqa-1.5-70b
nvidia/mistral-nemo-minitron-8b-8k-instruct
nvidia/nemoretriever-parse
nvidia/nemotron-3-content-safety
nvidia/nemotron-3-nano-30b-a3b
nvidia/nemotron-3-super-120b-a12b
nvidia/nemotron-4-340b-instruct
nvidia/nemotron-4-340b-reward
nvidia/nemotron-content-safety-reasoning-4b
nvidia/nemotron-mini-4b-instruct
nvidia/nemotron-nano-12b-v2-vl
nvidia/nemotron-nano-3-30b-a3b
nvidia/nemotron-parse
nvidia/neva-22b
nvidia/nv-embed-v1
nvidia/nv-embedcode-7b-v1
nvidia/nv-embedqa-e5-v5
nvidia/nv-embedqa-mistral-7b-v2
nvidia/nvclip
nvidia/nvidia-nemotron-nano-9b-v2
nvidia/riva-translate-4b-instruct
nvidia/riva-translate-4b-instruct-v1.1
openai/gpt-oss-120b
openai/gpt-oss-20b
qwen/qwen2.5-coder-32b-instruct
qwen/qwen3-coder-480b-a35b-instruct
qwen/qwen3-next-80b-a3b-instruct
qwen/qwen3-next-80b-a3b-thinking
qwen/qwen3.5-122b-a10b
qwen/qwen3.5-397b-a17b
sarvamai/sarvam-m
snowflake/arctic-embed-l
stepfun-ai/step-3.5-flash
stockmark/stockmark-2-100b-instruct
upstage/solar-10.7b-instruct
writer/palmyra-creative-122b
writer/palmyra-fin-70b-32k
writer/palmyra-med-70b
writer/palmyra-med-70b-32k
z-ai/glm-5.1
z-ai/glm4.7
z-ai/glm5
zyphra/zamba2-7b-instruct
```

To use any of these directly, run:

```powershell
.\scripts\switch-provider.ps1 -Profile nvidia-nim -Model qwen/qwen3.5-397b-a17b -ApiKey nvapi-xxxx
```
