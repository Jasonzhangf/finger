---
name: memsearch-flow
description: Configure and validate memsearch to use a local LLM endpoint (Anthropic wire) and LM Studio for embeddings. Use when setting up global memsearch config, running index/search/compact flows, or testing memsearch across projects without touching environment variables.
---

# Memsearch Flow

## Overview

Set global memsearch config for split embedding/LLM base URLs, then run the standard index/search/compact workflow in any project. Do not set environment variables here; assume they are already configured.

## Standard Workflow

1. Confirm global config exists in `~/.memsearch/config.toml` with these keys:

```toml
[embedding]
provider = "openai"
model = "text-embedding-embeddinggemma-300m-qat"
base_url = "http://127.0.0.1:1234/v1"

[compact]
llm_provider = "anthropic"
llm_model = "qwen.qwen3.5-plus"
llm_base_url = "http://localhost:5520/v1"
```

2. In any project, prepare a markdown directory and index it:

```bash
mkdir -p ./memory
memsearch index ./memory/
```

3. Search memories:

```bash
memsearch search "your query" --top-k 5
```

4. Compact summaries (use exact `source` from search results):

```bash
memsearch search "keyword" --json-output
memsearch compact --source "<source path>" --llm-provider anthropic --llm-model qwen.qwen3.5-plus
```

## Troubleshooting

- If `compact` returns "No chunks to compact":
  - Run `memsearch search --json-output` and use the exact `source` path from results.
  - Ensure you are using the same Milvus URI/collection across commands.
- If index/search fails, verify the embedding base URL and model are reachable from the configured endpoints.
