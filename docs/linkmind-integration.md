# LinkMind Integration Guide

## Overview

OctoCode integrates with [LinkMind](https://linkmind.ai) as a first-class provider, enabling access to LinkMind's AI services including chat completion, agent execution, RAG vector search, and multimodal capabilities.

## Configuration

### Basic Setup

Set the LinkMind provider in `config/octocode.conf`:

```ini
provider_id=linkmind
provider_base_url=http://127.0.0.1:8080/v1
default_model=your-model-name
```

### Provider Descriptor

The LinkMind provider registers with these capabilities:

| Field | Value |
|-------|-------|
| ID | `linkmind` |
| Kind | `ProviderKind::LinkMind` |
| Streaming | Yes |
| Tool calling | Yes |
| Default URL | `http://127.0.0.1:8080/v1` |

### API Key

Set the API key via environment variable:

```bash
export OPENAI_API_KEY=your-linkmind-api-key
```

Or configure it in the runtime config.

## Endpoints Used

### Chat Completion (current)

```
POST {base_url}/chat/completions
```

Standard OpenAI-compatible chat completion API. Supports streaming via SSE.

### Agent Execution (planned — Sprint 4)

```
POST {base_url}/chat/go
```

LinkMind Agent Mate mode for autonomous task execution with tool calling.

### Vector Search (planned — Sprint 4)

```
POST {base_url}/vector/search
```

RAG-powered semantic search against document stores.

### Vector Upsert (planned — Sprint 4)

```
POST {base_url}/vector/upsert
```

Index documents into the vector store for later retrieval.

## lagi.yml Configuration

LinkMind uses `lagi.yml` for model routing. Example:

```yaml
models:
  - name: my-model
    type: completion
    enable: true

functions:
  chat:
    - backend: my-model
      priority: 10
      
  rag:
    - backend: my-vector-db
      priority: 10
```

### Multi-model Routing

LinkMind supports routing strategies:

- `best(model1, model2)` — Select the best response from multiple models
- `pass(model1, model2)` — Sequential fallback chain

## Usage Examples

```bash
# Chat with LinkMind provider
cargo run -p octocode-cli -- chat demo "explain this code"

# Check LinkMind provider health
cargo run -p octocode-cli -- health

# View provider routing
cargo run -p octocode-cli -- routes
```

## Fallback Behavior

When LinkMind is configured as the primary provider, the fallback chain is:

```
linkmind → local-openai → remote-openai → stub
```

The circuit breaker triggers after 2 consecutive failures with a 30-second cooldown.
