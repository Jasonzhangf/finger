# Commit scope and agent prompt override

- User preference: commit all code changes, but exclude build artifacts, temp files, logs, generated files, private information, and local tool runtime state.
- Durable implementation decision: per-agent prompt overrides live under `~/.finger/runtime/agents/<agent-id>/prompts/...`; API falls back to repo default prompts when override is missing.
