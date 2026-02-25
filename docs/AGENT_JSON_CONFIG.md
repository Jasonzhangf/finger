# Agent JSON 配置

每个 agent 使用独立的 `agent.json`（或 `<id>.agent.json`）配置文件。

默认目录：

- `~/.finger/agents/<agent-id>/agent.json`
- 或 `~/.finger/agents/<agent-id>.agent.json`

## 示例：Reviewer 只读

```json
{
  "id": "reviewer-1",
  "name": "Code Reviewer",
  "role": "reviewer",
  "tools": {
    "whitelist": ["file.read", "file.list", "bd.query"],
    "blacklist": ["file.write", "shell.exec", "apply_patch"],
    "authorizationRequired": ["shell.exec"]
  },
  "model": {
    "provider": "crsb",
    "model": "gpt-5.3-codex"
  },
  "runtime": {
    "maxTurns": 12
  },
  "metadata": {
    "owner": "team-review"
  }
}
```

## Daemon API

- `GET /api/v1/agents/configs/schema` 查看 JSON Schema
- `GET /api/v1/agents/configs` 查看当前已加载配置
- `POST /api/v1/agents/configs/reload` 重新加载配置（可带 `{"dir":"..."}`）
