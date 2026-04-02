# Historical Rationale (Non-Canonical)

> This document is historical rationale only.
> The only authoritative lifecycle and context policy contract is:
> `docs/design/project-task-lifecycle-state-machine.md`

# Context History Digest + Rebuild Guard 设计（Draft）

## 索引概要
- L1-L12 `scope`：目标、背景、术语。
- L14-L42 `hard-invariants`：强约束（必须保持）。
- L44-L92 `trigger-matrix`：何时允许/禁止 history 变化。
- L94-L156 `digest-model`：task 压缩历史的数据模型与注入方式。
- L158-L198 `expand-tool`：按 task 展开全文工具设计。
- L200-L260 `timeout-tracing`：超时错误检查与追踪（含 `chat-codex timed out after 600000ms`）。
- L262-L314 `rollout`：实施阶段与回滚策略。
- L316-L366 `acceptance`：验收标准与测试矩阵。
- L368-L396 `risks`：风险与缓解方案。

---

## 1. 目标与背景

### 1.1 目标
在不改变系统提示词/skills/mailbox 稳定注入机制的前提下，重构 history 区：
1. **禁止隐式重建**：仅在两种场景允许 history 变化：
   - bootstrap 且历史完全空；
   - 模型显式调用 `context_builder.rebuild`（BU）。
2. **history 压缩展示**：默认以 task digest（开头+结尾+slot范围）注入，而非整 task 明文。
3. **可回溯全文**：提供工具将某条 digest 展开为全量原文。
4. **加强错误追踪**：针对超时错误（例如 `[18:26] 处理失败：chat-codex timed out after 600000ms`）建立可观测链路。

### 1.2 非目标
- 不改变 skills/mailbox/flow/system prompt 的注入策略与优先级。
- 不改变 ledger 作为唯一真源的原则。
- 不引入“自动话题切换即自动重建”策略。

### 1.3 FLOW 加载分层（全局 + 本地）
- 采用双层 FLOW 注入，避免多任务并行时互相覆盖：
  1. **Global FLOW**（全局约束）  
     - 路径：`~/.finger/FLOW.md`（可配置覆盖）  
     - 用途：跨项目/跨 agent 的统一流程原则、全局守则。
  2. **Local FLOW**（任务状态）  
     - `system agent`：加载其工作路径下 `FLOW.md`（通常 `~/.finger/system/FLOW.md`）  
     - `project agent`：加载项目路径下 `FLOW.md`（`<projectPath>/FLOW.md`）
     - 用途：当前 agent 当前任务的状态机与执行进度。

### 1.4 FLOW 注入顺序（必须明确）
1. 先注入 **Global FLOW**（规则基线）；  
2. 再注入 **Local FLOW**（当前任务状态）；  
3. 如内容冲突，**Local FLOW 优先**。  

> 说明：历史重建（context builder）仅作用于 history 区，不影响 FLOW 双层注入。

---

## 2. 强约束（Hard Invariants）

### 2.1 上下文分区硬边界（必须）
运行时上下文必须按固定分区理解，避免“重建历史误伤稳定层”：

| 分区 | 名称 | 作用 | 是否允许被 `context_builder.rebuild` 改写 |
|---|---|---|---|
| P0 | `core_instructions` | system/developer 指令层 | ❌ |
| P1 | `runtime_capabilities` | skills/mailbox/FLOW 注入层 | ❌ |
| P2 | `current_turn` | 当前用户输入 + 当前轮附件 | ❌ |
| P3 | `continuity_anchors` | 连续性锚点（最近 task + 最近用户输入） | ❌（需保留） |
| P4 | `dynamic_history` | `working_set` + `historical_memory` 历史视图 | ✅（唯一允许） |
| P5 | `canonical_storage` | ledger 原文 + MEMORY.md 真源 | ❌（查询，不改写） |

> 结论：重建只改 P4；P0/P1/P2 稳定注入，P3 必须保留，P5 只能查询。

1. **非 history 上下文稳定注入**
   - skills prompt block、mailbox baseline、flow prompt block、system/developer prompt 均为稳定注入层。
   - context builder 只作用于 `history_items` 构造，不得影响上述注入层。

2. **history 变化触发条件唯一化**
   - Allowed:
     - `bootstrap && history_is_empty == true`
     - `explicit_rebuild == true`（`context_builder.rebuild`）
   - Disallowed:
     - 未完成任务内部续跑
     - 普通用户续写“继续/接着/重复”
     - 心跳/定时任务自然轮询
     - provider latency/timeout 造成的重入

3. **任务最小颗粒保持为 Task**
   - Task 定义：从用户请求开始到该请求 `finish reason=stop`（或明确结束）为止。
   - task 内消息不做结构性编辑；压缩只发生在注入视图层。

4. **ledger 唯一真源**
   - 压缩视图可重建、可丢弃；原始 ledger 不可破坏。

### 2.2 查询流程硬约束（必须）
复杂任务的前置判定（新增）：
- 当用户提出复杂任务（尤其 coding/debugging/长链路任务）时，默认先做 ledger 检索，不允许“先重建再说”。
- 必须先完成：
  1) `context_ledger.memory(action="search")` 定位相关 task/slot；
  2) `context_ledger.memory(action="query", detail=true, slot_start, slot_end)` 抽样核对原始证据；
- 再根据检索结果判断是否需要 `context_builder.rebuild`（仅在当前可见历史不足或连续性明显缺失时触发）。

当可见上下文不足时，统一按以下顺序查询：
1. `MEMORY.md`：先取长期稳定事实（ground truth）。
2. `context_ledger.memory(action="search")`：定位相关 task / slot。
3. `context_ledger.memory(action="query", detail=true, slot_start, slot_end)`：读取原始证据。
4. `context_ledger.expand_task(task_id|slot_start+slot_end)`：将压缩 task 展开为完整任务记录。

---

## 3. Rebuild 触发矩阵

| 场景 | 默认行为 | 是否重建 history | 说明 |
|---|---|---|---|
| daemon 重启后首轮，历史空 | bootstrap | ✅ 允许 | 仅一次，生成初始 history 视图 |
| daemon 重启后首轮，历史非空 | 复用已有 history/index | ❌ 禁止 | 不得“自作主张”重建 |
| 新 session（无历史） | bootstrap | ✅ 允许 | 与首轮空历史一致 |
| 同一未完成任务内部续跑 | 继续推进 | ❌ 禁止 | 必须复用锁定 history |
| 普通用户继续对话 | 常规追加 | ❌ 禁止 | 仅滑窗，不重建 |
| 显式 `context_builder.rebuild` | on-demand | ✅ 允许 | 唯一运行态重建入口 |
| 上下文超限（阈值触发） | 走 rebuild 流程 | ✅ 允许（受控） | 必须留下明确触发证据 |

### 3.1 证据字段（用于审计）
每次 history 变化需可追踪：
- `contextHistorySource`
- `contextBuilderRebuilt`
- `contextBuilderBypassReason`
- `triggerType`（bootstrap/manual_rebuild/overflow_rebuild）
- `triggerBy`（user/model/system）

---

## 4. History Digest 模型（新）

### 4.1 注入目标
将历史区从“完整 task 明文堆叠”改为“时间顺序 digest 列表”，默认预算 20k。

### 4.2 单条 digest 结构
```json
{
  "task_id": "task-1774777936150",
  "time_start": "2026-03-29T09:52:16.150Z",
  "time_end": "2026-03-29T09:53:11.114Z",
  "slot_start": 1244,
  "slot_end": 1298,
  "request_raw": "用户原始请求（首条 user）",
  "finish_summary": "任务完成时 assistant summary（若无则 fallback）",
  "tags": ["context", "mailbox"],
  "topic": "context builder",
  "token_estimate": 820,
  "expand_hint": {
    "action": "query",
    "detail": true,
    "slot_start": 1244,
    "slot_end": 1298
  }
}
```

### 4.3 压缩策略
- 时间顺序 + 滑动窗口；默认不消失（除非预算超限时在“注入窗口”中滑出，但 ledger 仍可检索）。
- `request_raw` 使用首条 user 原文（可做长度上限防爆）。
- `finish_summary` 优先使用任务结束摘要；无摘要时回退为末条 assistant 的压缩预览。
- 不在 digest 中注入大段工具 stdout/stderr 原文。

### 4.5 专用排序模型不可用时的运行时降级（新增）
- 触发条件：`context_builder` 处于 active ranking，但排序 provider 不可用（`provider_not_found/http_* / exception / parse_failed`）。
- 降级动作：
  1. 历史区直接转为 task digest blocks（请求 + 结果 + 关键工具）；
  2. 当前任务（working set）保持完整链路，不做 task 内裁剪；
  3. 本轮继续执行，不中断；
  4. metadata 记录 `rankingReason=digest_fallback:<reason>`。
- 目标：避免“因排序模型不可用导致 context build 失败”，同时保持关键可追踪信息。

### 4.4 与现有 context builder 的关系
- context builder 仍做：任务分组、相关性排序、预算控制。
- 在“最终注入前”增加 digest 视图转换层。
- review/rebuild 完成后 history 始终回归 digest 视图。

---

## 5. 展开全文工具（新增）

### 5.1 目标
用户或模型可将某条 digest 还原为完整 task 原文用于深查。

### 5.2 建议工具
`context_ledger.expand_task`

输入：
- `task_id`（首选）或 `slot_start/slot_end`
- `detail=true`

输出：
- 对应 slot 范围内的全量 ledger 条目
- 保持与 `context_ledger.memory(action=query, detail=true)` 对齐

### 5.3 实现策略（建议）
- 优先做薄封装（wrapper），复用已有 `context_ledger.memory` 能力。
- 不复制检索逻辑，避免双真源。

---

## 6. 错误检查与追踪（新增重点）

需要纳入专门链路追踪：
`[18:26] 处理失败：chat-codex timed out after 600000ms`

### 6.1 必须记录的超时字段
- `error.type = provider_timeout`
- `error.message`（完整保留）
- `provider = chat-codex` / `model`
- `timeout_ms = 600000`
- `elapsed_ms`
- `session_id`
- `agent_id`
- `thread_key`
- `turn_id` / `dispatch_id` / `flow_id` / `seq`
- `history_source`（raw/indexed/on_demand/bootstrap）
- `history_items_count`
- `estimated_tokens_in_context_window`

### 6.2 追踪链路要求
同一超时事件必须能串起来：
1. provider 调用开始（start）
2. 过程进度（progress，可选）
3. 超时触发（timeout）
4. 错误上报给 channel（user-facing）
5. 重试/回退决策（如果有）

### 6.3 用户可见性要求
- 返回用户消息中必须带：
  - 本次失败原因（明确 timeout）
  - 是否自动重试、下次重试时间（若有）
  - 当前任务状态（未完成/已暂停）
- 禁止吞错或只显示“处理失败”无上下文。

### 6.4 观测与告警（建议）
- 统计指标：
  - `provider_timeout_total{provider,model,agent}`
  - `provider_timeout_retry_success_total`
  - `provider_timeout_recovery_latency_ms`
- 超时事件写入 canonical event store，并可在 monitor UI 过滤查看。

---

## 7. Rollout 计划（仅设计）

### Phase A：行为收口（无结构升级）
- 收紧重建触发：关闭隐式重建路径（非空 history 不 bootstrap，非显式 BU 不重建）。
- 保留现有 history 注入，先保证触发正确。

### Phase B：digest 注入
- 增加 task digest 生成器。
- history 注入改为 digest 列表。
- 保留现有 task full message 构造供回退。

### Phase C：expand 工具
- 增加 `context_ledger.expand_task` 封装。
- monitor 与 prompt 中加入调用指引。

### Phase D：timeout 全链路追踪
- 统一超时事件 schema。
- 在 progress / channel / ledger 三端打通一致字段。

---

## 8. 验收标准

1. **稳定注入**
   - skills/mailbox/flow/system/developer prompt 在有无 rebuild 下内容一致。

2. **触发正确**
   - 未显式 BU 且历史非空时，history source 不变化。
   - 未完成任务内部续跑，history items 不突变。

3. **digest 生效**
   - history 默认注入 digest 条目，不再注入完整 task 文本。

4. **可展开全文**
   - 任一 digest 可通过工具展开为完整 slot 范围原文。

5. **timeout 可追踪**
   - 出现 `chat-codex timed out after 600000ms` 时，日志、事件、用户可见消息均含统一追踪字段。

---

## 9. 风险与缓解

1. **风险：摘要失真导致模型误判上下文**
   - 缓解：保留 `request_raw` + `finish_summary` + `slot_range` 三要素；支持一键展开全文。

2. **风险：digest 过短影响代码任务连续性**
   - 缓解：对 coding 任务默认建议先尝试 `rebuild_budget=50000`；必要时展开关键 task 全文。

3. **风险：timeout 增多导致误判为上下文问题**
   - 缓解：分离 provider timeout 与 history rebuild 事件，避免归因混淆。

4. **风险：多 agent 并发下 trace 断链**
   - 缓解：强制 `flow_id + seq + turn_id + dispatch_id` 组合键贯穿。

---

## 10. 结论

本方案保持“ledger 唯一真源 + 非 history 稳定注入 + 显式重建控制”，并通过 digest + expand 兼顾上下文预算与可追溯性；同时将 timeout 错误纳入可观测闭环。
