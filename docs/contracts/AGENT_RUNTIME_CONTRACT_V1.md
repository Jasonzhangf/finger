# Agent Runtime Contract V1 - Phase 0.1: 核心模型字段清单

> 状态：Gate-0 通过（Phase 0.1 完成）
> 版本：1.0.0-g0-passed
> 日期：2026-02-26
> 任务：finger-221.1.1

## 1. 目标

冻结四类核心模型字段，作为后续 UI、Canvas、调度三端的共同基础。遵循：
- 字段命名与现有代码库保持一致
- 新增字段提供向后兼容说明
- 采用 append-only 策略��避免破坏性变更

## 2. 现有字段盘点（来源）

| 文件 | 已有模型 | 关键字段 |
|------|----------|----------|
| `src/agents/roles/orchestrator.ts:11` | AgentConfig | id, systemPrompt, provider{baseUrl, apiKey, defaultModel} |
| `src/agents/agent.ts:8` | AgentConfig | id, name, mode, provider, model?, systemPrompt?, allowedTools?, disallowedTools?, permissionMode?, maxTurns?, resumeSession?, cwd?, addDirs? |
| `src/orchestration/runtime.ts:36` | AgentConfig | id, name, port, command, args?, autoStart?, autoRestart?, maxRestarts?, restartBackoffMs?, healthCheckIntervalMs?, healthCheckTimeoutMs?, heartbeatTimeoutMs? |
| `src/runtime/session-control-plane.ts:5` | SessionBindingRecord | fingerSessionId, agentId, provider, providerSessionId, updatedAt, metadata? |
| `src/orchestration/resource-pool.ts:108-112` | orchestrator-default | id=orchestrator-default, type=orchestrator |

## 3. 统一模型定义（V1）

### 3.1 AgentConfig（静态配置模板）

> 统一入口，合并三处现有 AgentConfig，按职责分层。

```ts
/**
 * Agent 静态配置模板
 * 来源：src/agents/agent.ts:8, src/orchestration/runtime.ts:36, src/agents/roles/orchestrator.ts:11
 * 用途：UI 左抽屉配置 / 资源池初始化 / 调度器选型
 */
interface AgentConfigV1 {
  // === 必填 ===
  agentType: string;        // 唯一标识，如 'task-orchestrator', 'finger-executor', 'chat-agent'
  displayName: string;      // UI 显示名
  role: AgentRole;          // 'orchestrator' | 'executor' | 'reviewer' | 'specialist'
  enabled: boolean;         // 是否启用

  // === 能力 ===
  capabilities: string[];   // 能力标签，如 ['planning', 'code-generation']

  // === 配额 ===
  defaultQuota: number;     // 默认并发上限（>=1）
  quotaPolicy?: QuotaPolicyV1; // 可选：project/workflow 双层覆盖

  // === 模型 ===
  modelConfig: {
    provider: 'iflow' | 'anthropic' | 'openai';
    model?: string;         // 如不填则用系统默认
    systemPrompt?: string;
  };

  // === 工具约束 ===
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: 'default' | 'autoEdit' | 'yolo' | 'plan';

  // === 生命周期（可选） ===
  maxTurns?: number;
  autoRestart?: boolean;
  maxRestarts?: number;
  restartBackoffMs?: number;

  // === 扩展元数据（向后兼容区） ===
  metadata?: Record<string, unknown>;
}

type AgentRole = 'orchestrator' | 'executor' | 'reviewer' | 'specialist';
```

**与现有代码的兼容说明：**
- `agentType`：统一替代现有 `id` 字段，避免与 runtimeId 混淆。
- `role`：对齐 `src/core/types.ts:48` 已有 `AgentRole`。
- `capabilities`：对齐 router-agent 和 finger-orchestrator 中已有能力标签机制。
- `defaultQuota`：新增，用于资源池配额上限；若不存在则默认 1。
- `quotaPolicy`：新增，实现 project/workflow 双层覆盖，见 3.2。
- `modelConfig`：统一三处分散的 provider/model/systemPrompt。
- `metadata`：扩展字段，避免后续频繁改接口。

---

### 3.2 QuotaPolicy（双层配额）

```ts
/**
 * 双层配额策略
 * 用途：UI 左抽屉按 project/workflow 配置覆盖
 * 优先级：workflowQuota > projectQuota > defaultQuota
 */
interface QuotaPolicyV1 {
  projectQuota?: number;                      // 项目级上限
  workflowQuota?: Record<string, number>;     // workflowId -> quota
}
```

**有效配额计算：**
```ts
function resolveEffectiveQuota(
  config: AgentConfigV1,
  workflowId?: string
): number {
  if (workflowId && config.quotaPolicy?.workflowQuota?.[workflowId] !== undefined) {
    return config.quotaPolicy.workflowQuota[workflowId];
  }
  if (config.quotaPolicy?.projectQuota !== undefined) {
    return config.quotaPolicy.projectQuota;
  }
  return config.defaultQuota ?? 1;
}
```

**向后兼容：**
- 若现有代码未传 quotaPolicy，则直接使用 defaultQuota，不破坏现有行为。
- workflowQuota 的 key 为 workflowId，未来可扩展为 taskId 级粒度。

---

### 3.3 RuntimeInstance（动态实例）

```ts
/**
 * 动态运行时实例
 * 用途：UI 底部面板显示 / Canvas 节点 / 调度器状态管理
 */
interface RuntimeInstanceV1 {
  // === 必填 ===
  runtimeId: string;        // 全局唯一实例 ID
  agentType: string;        // 关联到 AgentConfigV1.agentType
  sessionId: string;        // 与右侧会话绑定的 session ID
  status: RuntimeStatus;    // 生命周期状态
  startedAt: number;        // 启动时间戳（ms）

  // === 上下文 ===
  workflowId?: string;      // 所属 workflow
  taskId?: string;          // 关联任务（若有）

  // === 队列 ===
  queuePosition?: number;   // 排队位置（queued 时有效）
  queuedCount?: number;     // 该 agentType 当前排队总数

  // === 摘要 ===
  summary?: string;         // 最近一条可读摘要（如 "调用 tool:grep 成功"）

  // === 结束信息 ===
  endedAt?: number;
  finalStatus?: 'completed' | 'failed' | 'interrupted';
  errorReason?: string;
}

type RuntimeStatus =
  | 'queued'           // 排队等待
  | 'running'          // 执行中
  | 'waiting_input'    // 等待用户输入
  | 'completed'        // 成功结束
  | 'failed'           // 失败
  | 'interrupted';     // 被中断
```

**与现有代码的兼容说明：**
- `runtimeId`：新增，统一动态实例标识，不与 agentType 混淆。
- `sessionId`：对齐 `src/runtime/session-control-plane.ts:5` 的 providerSessionId。
- `status`：对齐 docs/AGENT_RUNTIME_AND_SESSION_LIFECYCLE.md:93 已有状态集。
- `workflowId/taskId`：与现有 workflow-fsm / finger-orchestrator 一致。
- `queuePosition/queuedCount`：新增，用于队列可视化。
- `summary`：新增，用于 Canvas 节点摘要显示。

---

### 3.4 SessionBinding（会话绑定）

```ts
/**
 * 会话绑定关系
 * 用途：右侧会话上下文切换 / runtime 结束后自动回退
 */
interface SessionBindingV1 {
  // === 必填 ===
  selectedContext: 'orchestrator' | string;  // 当前右侧上下文（orchestrator 或 runtimeId）
  orchestratorSessionId: string;             // 编排者主会话 ID

  // === 映射表 ===
  runtimeSessionMap: Record<string, string>; // runtimeId -> sessionId

  // === 元数据 ===
  updatedAt: number;
}
```

**与现有代码的兼容说明：**
- `selectedContext`：新增，控制右侧会话默认显示 orchestrator 或某 runtime。
- `orchestratorSessionId`：对齐现有主会话概念。
- `runtimeSessionMap`：对齐 `src/runtime/session-control-plane.ts:5` 的绑定结构，但改为内存状态，持久化仍由 SessionControlPlaneStore 负责。

---

## 4. 字段对照表（新旧映射）

| 新字段 | 现有字段 | 变更类型 |
|--------|----------|----------|
| AgentConfigV1.agentType | AgentConfig.id / AgentConfig.id | 重命名统一 |
| AgentConfigV1.role | AgentRole | 新增 |
| AgentConfigV1.defaultQuota | — | 新增 |
| AgentConfigV1.quotaPolicy | — | 新增 |
| AgentConfigV1.modelConfig.provider | AgentConfig.provider | 合并 |
| RuntimeInstanceV1.runtimeId | — | 新增 |
| RuntimeInstanceV1.sessionId | SessionBindingRecord.providerSessionId | 映射 |
| RuntimeInstanceV1.queuePosition | — | 新增 |
| RuntimeInstanceV1.summary | — | 新增 |
| SessionBindingV1.selectedContext | — | 新增 |
| SessionBindingV1.runtimeSessionMap | SessionBindingRecord 绑定逻辑 | 统一 |

---

## 5. 向后兼容策略

1. **渐进迁移**：新接口新增，旧接口保留至少一个版本周期，内部统一映射到新模型。
2. **默认值兜底**：
   - `defaultQuota` 未配置时默认 1。
   - `quotaPolicy` 未配置时直接使用 defaultQuota。
   - `selectedContext` 未配置时默认 'orchestrator'。
3. **字段扩展**：所有 `metadata?: Record<string, unknown>` 字段用于未来扩展，不破坏接口签名。
4. **事件 append-only**：新增事件字段只能加，不能改语义或删。

---

## 6. 评审检查清单（Gate-0）

- [x] 三处 AgentConfig 统一为 AgentConfigV1 且无字段丢失
- [x] RuntimeStatus 与现有状态机（queued/running/completed/failed）一致
- [x] SessionBindingV1 能表达 orchestrator 默认上下文
- [x] quotaPolicy 优先级规则明确（workflow > project > default）
- [x] 所有新增字段均有默认值或标记为可选
- [x] 字段命名与现有代码库风格一致（camelCase, 语义清晰）

---

## 7. 下一步

- **Phase 0.2**：基于本模型定义事件字段表（runtime_spawned / runtime_status_changed 等）。
- **Phase 0.3**：评审 Gate-0 通过后冻结 V1，后续仅增量。

