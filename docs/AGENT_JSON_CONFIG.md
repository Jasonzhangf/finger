# Agent JSON 配置

每个 agent 使用独立的 `agent.json`（或 `<id>.agent.json`）配置文件。

默认目录：

- `~/.finger/runtime/agents/<agent-id>/agent.json`
- 或 `~/.finger/runtime/agents/<agent-id>.agent.json`

## 示例：Reviewer 只读

```json
{
  "id": "reviewer-1",
  "name": "Code Reviewer",
  "role": "reviewer",
  "provider": {
    "type": "iflow",
    "model": "gpt-5.3-codex"
  },
  "session": {
    "bindingScope": "finger+agent",
    "resume": true,
    "provider": "iflow",
    "agentId": "reviewer-1",
    "mapPath": "~/.finger/config/session-control-plane.json"
  },
  "governance": {
    "iflow": {
      "allowedTools": ["read_file", "write_file"],
      "disallowedTools": ["network"],
      "approvalMode": "default",
      "injectCapabilities": true,
      "capabilityIds": ["bd"],
      "commandNamespace": "cap_"
    }
  },
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

## 字段说明（v2）

- `provider.type`: Agent 后端类型（如 `iflow` / `kernel`）。
- `provider.model`: 默认模型 ID（可选）。
- `session.bindingScope`: 会话绑定粒度：
  - `finger`: 主会话维度共享
  - `finger+agent`: 主会话 + agent 维度隔离（推荐）
- `session.resume`: 是否优先复用历史 provider session。
- `session.provider`: provider 名称（可选，默认从 provider.type 推断）。
- `session.agentId`: 会话映射作用域使用的 agentId（可选，默认使用配置的 id）。
- `session.mapPath`: 会话映射文件路径（可选）。
- `governance.iflow.*`: iFlow 工具治理与 capability 注入策略。

## Daemon API

- `GET /api/v1/agents/configs/schema` 查看 JSON Schema
- `GET /api/v1/agents/configs` 查看当前已加载配置
- `POST /api/v1/agents/configs/reload` 重新加载配置（可带 `{"dir":"..."}`）
