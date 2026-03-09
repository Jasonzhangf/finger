
## 2026-03-06 Collaboration Preferences
- 当用户要求“提交所有代码”时，提交仓库内代码/文档/测试/脚本变更，但排除构建物、日志、临时文件、生成物、隐私文件与本地工具状态目录。
- 与 agent prompt 相关的覆盖链路采用：默认读取仓库系统 prompt，用户保存后写入 `~/.finger/runtime/agents/<agent-id>/prompts/...`，并以下次任务开始时优先加载该覆盖。

## 2026-03-07 Dispatch Handoff
- Structured output 返回需要容错：先本地修 JSON，再按 schema 校验；失败时按可配置重试次数发起字段路径级重试提示，错误必须明确到 JSON path。
- 子 agent 派发返回必须只回灌轻量 `summary/status/keyFiles/evidence/childSessionId`，不能把 `metadata.api_history`、原始 transcript 或完整工具历史直接送回主编排器下一轮输入。
- `agent.dispatch` 的任务下发应带明确 goal / acceptance / response contract，优先启用 structured output schema，保证 executor 输出 JSON handoff。

## 2026-03-07 Agent Prompt Editing UI
- Agent 配置抽屉中的提示词编辑支持两层入口：抽屉内快速 textarea 编辑，以及全屏模态框编辑/预览 Markdown。
- 提示词默认读取系统 prompt；用户保存后写入 `~/.finger/runtime/agents/<agent-id>/prompts/...` 覆盖文件，并在下一次任务开始时生效。
- 全屏提示词模态框需要展示读取路径、写入路径、role/source 元信息；Markdown 预览至少支持标题、段落、引用、列表、代码块、行内 code、粗体、斜体。

## 2026-03-07 Bottom Panel Agent Source
- 下方 Agent 配置面板中的静态 agent 列表必须是动态聚合结果，不能只显示默认固定 agent。
- 真正来源是三者合并：`runtime-view.agents`、`catalog.agents`、`runtime-view.configs`；即使某个 agent 还未部署、只存在于 `agent.json`，也要在面板里出现并可配置。
- orchestration profile 的 `visible` 不应裁掉配置面板里的 agent 候选；它只影响编排展示，不应影响配置真源。

## 2026-03-07 Agent Enable Truth Source
- agent 的启用状态要持久化到 `agent.json` 顶层 `enabled`，不能只停留在 runtime patch，否则 drawer 重开或 reload 后会被重新覆盖成 `true`。
- Drawer 中的 `enabled` 编辑是配置编辑，不应因为同一个 agent 的刷新而被 `pickDefaultDraft()` 重置。
- 下方 Agent 卡片需要有直接 `启用/禁用` 操作，且该操作应走 `GET /api/v1/agents/configs/:agentId` + `PUT /api/v1/agents/configs/:agentId` 持久化，再刷新面板。
- `Workflow Quota` 文案对用户不直观，应该改成“按工作流覆盖配额”，并解释格式 `workflowId=配额`。

## 2026-03-07 Agent Config Save Semantics
- 底部 agent 卡片的启用态展示必须把“当前状态”和“可执行动作”分开：状态徽标显示 `已启用/已禁用`，动作按钮显示 `禁用/启用`，避免绿色按钮文字与当前状态混淆。
- Agent 配置抽屉里的运行配置区域本质是配置编辑，不是 runtime deploy；UI 文案必须使用“应用并保存/保存中”，并明确说明“保存到 agent.json，下一次任务开始生效，不会立即部署实例”。
- 抽屉保存运行配置时必须直接写入 `/api/v1/agents/configs/:agentId`，不能再走 `/api/v1/agents/deploy`，否则禁用态下会出现“还能部署”的错误语义和错误行为。

## 2026-03-07 Agent Enabled Runtime Truth Source
- `runtime-view.agents[].enabled` 与 `runtime-view.configs[].enabled` 必须最终反映 `agent.json` 顶层 `enabled`，不能只读取 `runtime.enabled`。
- `AgentRuntimeBlock` 里的 `runtimeConfigByAgent` 不能缓存“从 loaded config 推导出的完整 profile”，否则 agent.json reload 后旧缓存会把新配置盖回去。
- 正确策略是：每次读取时先重新计算 loaded-config base profile，再叠加仅用于运行期 patch 的 override profile。
## 2026-03-09 - Agent 总结显示与子会话切换修复

### 问题描述
1. 编排者在结束时并没有总结，需要每个 agent 在完成时总结工作
2. 在执行结束以后，无法切换到别的 agent 检查执行结果
3. 提示词需要全部改为英文

### 修复方案
1. 更新了所有 agent 的提示词文件，加入了 "Must Summarize on Completion" 的要求
2. 增强了 `extractResultTextForSession` 函数，能够从结构化 JSON 输出中提取 summary 字段
3. 使用 `tryParseStructuredJson` 来解析可能的 JSON 字符串
4. 修复了 import 路径错误

### 修改的文件
- src/agents/prompts/executor-prompts.ts
- src/agents/prompts/orchestrator-prompts.ts
- src/agents/prompts/planner-prompts.ts
- src/agents/prompts/reviewer-prompts.ts
- src/agents/prompts/router-prompts.ts
- src/agents/prompts/understanding-prompts.ts
- src/server/modules/message-session.ts

## 2026-03-09 13:14 - Agent 会话角色显示重构

### 全局真源分析

已确定的真源位置：

| 数据项 | 真源位置 | 说明 |
|--------|----------|------|
| 会话类型 | `SessionInfo.sessionTier` | 主会话/子会话 |
| 会话归属 | `SessionInfo.ownerAgentId` | 会话属于哪个 agent |
| 会话层级 | `SessionInfo.parentSessionId` | 父会话关系链 |
| 事件角色 | `RuntimeEvent.role` | user/agent/system |
| Agent 标识 | `RuntimeEvent.agentId/agentName` | 哪个 agent 产生 |

### 需要继续调研

- Agent 实例信息来源（多实例区分）
- 分配者信息（assigner）存储位置
- Runtime 层的数据生产逻辑

### 下一步

1. 查看 blocks/runtime 层代码
2. 确定实例信息的全局真源
3. 修改前端只消费真源数据

## 2026-03-09 13:19 - 全局唯一真源确定

### 已找到的真源位置

| 数据项 | 真源位置 | 类型 | 说明 |
|--------|----------|------|------|
| 会话类型 | `SessionInfo.sessionTier` | blocks/session | `main`/`child` |
| 会话所有者 | `SessionInfo.ownerAgentId` | blocks/session | 该会话属于哪个 agent |
| 父会话关系 | `SessionInfo.parentSessionId` | blocks/session | 谁分配的 |
| Agent 角色 | `AgentRoleType` | agent-runtime-block | `orchestrator`/`executor`/`reviewer`/`searcher` |
| Agent 实例 | `AgentRuntimeViewInstance` | agent-runtime-block | 每个部署实例有独立 ID |
| 分配者信息 | `AgentAssignmentLifecycle.assignerAgentId` | agent-runtime-block | 谁分派的任务 |

### 下一步

1. 修改 MessageItem 组件，只消费上述全局真源
2. 不再硬编码显示逻辑，从真源动态获取
3. 移除前端重复计算的逻辑，确保一致性

## 2026-03-09 13:20 - Agent 会话角色显示修改计划

### 目标
解决会话角色显示不清晰的问题，确保：
1. 主会话清晰显示：You / Orchestrator / Agent
2. 子会话显示分配链：Assigner → AgentInstance
3. 多实例有区分：AgentName-1, AgentName-2

### 全局真源确认

| 数据项 | 真源位置 | 消费方式 |
|--------|----------|----------|
| 会话类型 | `SessionInfo.sessionTier` | 从 session 对象读取 |
| 会话归属 | `SessionInfo.ownerAgentId` | 确定会话属于哪个 agent |
| 父会话 | `SessionInfo.parentSessionId` | 确定分配关系 |
| Agent 角色 | `AgentDefinition.role` | 确定角色类型 |
| 实例信息 | `AgentRuntimeViewInstance` | 确定具体实例名 |
| 分配者 | `AgentAssignmentLifecycle.assignerAgentId` | 确定谁分配的任务 |

### 修改步骤

1. **扩展 RuntimeEvent 类型** (`ui/src/api/types.ts`)
   - 添加 `roleType`: 'orchestrator' | 'executor' | 'reviewer' | ...
   - 添加 `assignerId` / `assignerName`: 分配者信息
   - 添加 `instanceName`: 实例具体名称
   - 添加 `sessionType`: 'main' | 'child'

2. **修改 MessageItem 组件** (`ui/src/components/ChatInterface/MessageItem.tsx`)
   - 移除硬编码的 "You" / "Agent" / "System"
   - 实现新的显示逻辑：
     - 用户: "You"
     - 主会话 Agent: 显示角色名 (Orchestrator / Executor / ...)
     - 子会话 Agent: "{Assigner} → {InstanceName}"

3. **后端数据填充** (如需)
   - 确保 RuntimeEvent 包含所有需要的字段
   - 从全局真源读取数据填充事件

### 验证标准

- [ ] 主会话显示: You / Orchestrator / Executor / ...
- [ ] 子会话显示: Orchestrator → finger-executor-1
- [ ] 多实例显示: finger-executor-1, finger-executor-2
- [ ] 所有显示数据来源可追溯到全局真源

## 2026-03-09 13:47 - Compact with Ledger Integration (基于 Codex 实现)

### Codex 的 Compact 关键点 (compact.rs)

1. **SUMMARIZATION_PROMPT**: 用于生成压缩摘要的提示词
2. **历史替换机制**: 用压缩摘要替换旧历史
3. **保留用户消息**: 收集并保留用户消息，有 token 限制
4. **Ghost snapshots**: 保留 ghost snapshot 项
5. **Initial context injection**: 根据时机注入初始上下文
6. **CompactedItem**: 包含压缩消息和替换历史
7. **replace_compacted_history**: 替换压缩后的历史
8. **recompute_token_usage**: 重新计算 token 使用量

### 两级记忆设计

#### 一级记忆：压缩记忆
- 用于常规提示，控制 token 用量
- 包含压缩摘要和保留的关键用户消息
- 保持较小的上下文窗口

#### 二级记忆：长历史记忆
- 用于详细查询和搜索
- 包含压缩前的完整历史
- 用于 ledger 精确搜索和时间对齐

### Slot 对齐与时间对齐

压缩前的 slot 时间戳需要与压缩后的摘要对齐，确保：
- Ledger 搜索能找到压缩的对应项
- 两级记忆可以互查

### Ledger 更新

压缩后需要更新 ledger index，使其能搜索到：
- 压缩摘要
- 原始历史
- slot 对齐关系

## 2026-03-09 14:32 - 自动 Compact 与 Ledger 集成架构设计完成

### 已完成工作

1. **自动 Compact 架构设计**（基于 codex 实现）
   - 触发条件：85% 上下文窗口阈值
   - 两级记忆：压缩摘要（一级）+ 完整 ledger（二级）
   - 时间对齐与 slot 对齐机制
   - Memsearch 兼容的 JSONL 索引

2. **RuntimeEvent 类型扩展**
   - 添加 `roleType`, `assignerId`, `assignerName`, `instanceName`, `sessionType`
   - 遵循全局唯一真源原则

3. **MessageItem 组件更新**
   - 基于真源数据的显示逻辑
   - 主会话 vs 子会话的角色链显示

4. **全局唯一真源原则**
   - 添加到 ~/.codex/AGENTS.md
   - 强调数据生产消费的一致性

5. **提交代码**
   - 提交到 main 分支并推送

### 后续任务（bd 追踪）

- webauto-hz8q: 迁移 browser-service 核心
- webauto-btzg: logging/heartbeat 最小替代
- webauto-mtrg: action 兼容层与缺失动作补齐
- webauto-aoik: 文档/CLI/API 列表更新

### 下一步

使用 `bd` 工具创建任务并执行。
