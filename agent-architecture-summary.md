# Finger Agent 架构 - 唯一真源设计

## 数据来源架构

本项目采用 **AgentRuntimeBlock** 作为 Agent 信息的唯一真源（Single Source of Truth）。

## 数据流动

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         UI Layer (React)                              │
│  useAgentRuntimePanel Hook → /api/v1/agents/runtime-view │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Server Layer (Express)                        │
│  registerRuntimeViewRoutes → AgentRuntimeBlock                     │
└─────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Blocks Layer (AgentRuntimeBlock)                      │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ runtime_view / catalog 命令                                │  │
│  │ - buildDefinitions() 构建 Agent 定义                     │  │
│  │ - getRuntimeView() 生成运行时视图                         │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
           │                           │                          │
           ▼                           ▼                          ▼
┌──────────────────┐      ┌─────────────────┐    ┌─────────────────┐
│ agent.json 配置   │      │  ModuleRegistry │    │ Orchestration │
│ ~/.finger/runtime/agents/   │      │  (运行时模块)   │    │ 配置            │
└──────────────────┘      └─────────────────┘    └─────────────────┘
```

## 数据源优先级

AgentRuntimeBlock 从以下三个数据源合并数据（按优先级）：

1. **agent.json 文件（最高优先级）
   - 位置：`~/.finger/runtime/agents/{agent-id}/agent.json
   - 或：`~/.finger/runtime/agents/*.agent.json`
   - 来源标记：`source: 'agent-json'`

2. **ModuleRegistry 运行时模块
   - 来源标记：`source: 'module'`

3. **Orchestration 配置**
   - 来源标记：`source: 'runtime-config'`

4. **Deployments（部署记录）
   - 来源标记：`source: 'deployment'`

## agent.json 文件格式

```json
{
  "id": "finger-orchestrator",
  "name": "Orchestrator",
  "role": "orchestrator",
  "implementations": [
    {
      "id": "native:finger-orchestrator",
      "kind": "native",
      "moduleId": "finger-orchestrator"
    }
  ],
  "tools": {
    "whitelist": ["tool1", "tool2"],
    "blacklist": []
  }
}
```

## API 端点

| 端点 | 说明 |
|------|------|
| `/api/v1/agents/runtime-view | 获取运行时视图 |
| `/api/v1/agents/catalog` | 获取 Agent 目录（支持 layer=full/summary/execution/governance |
| `/api/v1/agents/configs` | 获取配置列表 |
| `/api/v1/agents/deploy` | 部署 Agent |
| `/api/v1/agents/control` | 控制 Agent |

## 统一数据结构

所有 UI 使用 `useAgentRuntimePanel` Hook 作为统一数据来源，不直接访问不同 API，统一通过 `AgentRuntimePanelAgent` 类型保证一致性。
