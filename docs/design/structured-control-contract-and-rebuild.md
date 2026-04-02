# Structured Control Contract + Dynamic Rebuild 规则（唯一真源）

## 索引概要
- L1-L8 `scope`: 文档定位、目标、非目标。
- L10-L34 `runtime-split`: 双 Runtime / 双 Session 隔离规则。
- L36-L128 `response-contract`: 每轮结构化返回契约（必填字段 + 语义）。
- L130-L226 `schema`: 前向兼容 Schema 定义（v1.1）。
- L228-L320 `digest-policy`: 负分立即 digest、正分延后 digest 重组规则。
- L322-L398 `rebuild-policy`: context review/rebuild 动态检索与排序规则。
- L400-L490 `hook-map`: 字段 → Hook 触发表（刚性执行）。
- L492-L560 `validation`: 解析失败、字段缺失、冲突字段的处理规则。
- L562-L620 `rollout`: 分阶段上线与验收标准。

---

## 1) Scope / 目标

本规则用于统一 Finger 的：
1. 每轮模型结构化控制信号（control block）。
2. 基于控制信号的 Hook 触发。
3. 动态 context rebuild 的输入选择策略。
4. 记忆摘要策略（负分立即 digest、正分延后 digest）。

### 非目标
- 不在本规则中定义具体 UI 展示样式。
- 不在本规则中限制 tags 的词表（tags 不做枚举）。

---

## 2) Runtime / Session 隔离（刚性）

1. **用户会话 Runtime（User Runtime）**
   - 只承载用户输入与任务执行。
   - 产出用户可见正文与 control block。

2. **控制会话 Runtime（Control Runtime）**
   - 承载 heartbeat / cron / watchdog / auto-review / daily-review。
   - 不接收用户输入。
   - 不污染用户主会话上下文。

3. 二者可并行，但不得混写同一 session。
4. 调度与唤醒允许跨 Runtime，但必须通过显式 Hook / Dispatch 事件桥接。

---

## 3) 每轮响应契约（Response Contract）

每轮模型输出由两部分组成：
1. `human_response`：给用户看的自然语言正文。
2. `control_block`：给系统判定的结构化控制块（必带）。

> 约束：本机制的“汇报主通道”是 `control_block`（面向模型/运行时），`human_response` 只做必要的人类可读补充。

### 3.1 输出格式

推荐使用固定 fenced block：

```text
<normal user-facing response>

```finger-control
{ ...control_block_json... }
```
```

### 3.2 控制块核心原则

1. `control_block` **每轮必带**。
2. 字段允许“默认值”，但不可缺失最小必填集合。
3. `tags` 不做枚举，不限制表达方式。
4. 字段语义优先于正文语义；运行时依据 control block 判定。

### 3.3 最小必填集合（v1.1）

- `schema_version`
- `task_completed`
- `evidence_ready`
- `needs_user_input`
- `has_blocker`
- `dispatch_required`
- `review_required`
- `wait.enabled`
- `wait.seconds`
- `user_signal.negative_score`
- `user_signal.profile_update_required`
- `tags`（可空数组）
- `self_eval.score`
- `self_eval.confidence`
- `self_eval.goal_gap`
- `anti_patterns`（可空数组）
- `learning`（可空对象，但字段结构必须存在）

### 3.4 关键字段语义（严格）

- `task_completed=true`：仅表示“当前轮目标已闭环”。
- `evidence_ready=true`：表示可提供证据链（日志/测试/命令输出/运行结果）。
- `needs_user_input=true`：当前流程缺关键输入，无法安全继续。
- `wait.enabled=true`：请求系统定时续跑；`wait.seconds > 0`。
- `user_signal.negative_score`：0~100 的用户负向强度。
- `anti_patterns`：本轮提炼出的“不要做什么”（短句），用于用户画像/规则收敛。
- `self_eval.score`：-100~100；负分代表结果偏离目标或不可接受。
- `self_eval.goal_gap`：若未闭环，必须说明差距；闭环可空。
- `learning.did_right`：本轮“做对了什么”的要点。
- `learning.did_wrong`：本轮“做错了什么”的要点。
- `learning.repeated_wrong`：重复错误（用于 Flow/MEMORY 防复发）。
- `learning.flow_patch.required=true`：要求更新项目 FLOW（局部流程规则）。
- `learning.memory_patch.required=true`：要求更新项目 MEMORY（长期记忆）。
- `learning.user_profile_patch.required=true`：要求更新 USER 画像（系统级）。

---

## 4) Schema 定义（v1.1，前向兼容）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "finger://schemas/control-block/v1.1",
  "title": "Finger Control Block",
  "type": "object",
  "required": [
    "schema_version",
    "task_completed",
    "evidence_ready",
    "needs_user_input",
    "has_blocker",
    "dispatch_required",
    "review_required",
    "wait",
    "user_signal",
    "tags",
    "self_eval",
    "anti_patterns",
    "learning"
  ],
  "properties": {
    "schema_version": { "type": "string", "pattern": "^1\\.[0-9]+$" },
    "task_completed": { "type": "boolean" },
    "evidence_ready": { "type": "boolean" },
    "needs_user_input": { "type": "boolean" },
    "has_blocker": { "type": "boolean" },
    "dispatch_required": { "type": "boolean" },
    "review_required": { "type": "boolean" },
    "context_review_hint": {
      "type": "string",
      "enum": ["none", "light", "aggressive"]
    },
    "wait": {
      "type": "object",
      "required": ["enabled", "seconds", "reason"],
      "properties": {
        "enabled": { "type": "boolean" },
        "seconds": { "type": "integer", "minimum": 0, "maximum": 86400 },
        "reason": { "type": "string", "maxLength": 280 }
      },
      "additionalProperties": true
    },
    "user_signal": {
      "type": "object",
      "required": ["negative_score", "profile_update_required", "why"],
      "properties": {
        "negative_score": { "type": "integer", "minimum": 0, "maximum": 100 },
        "friction_score": { "type": "integer", "minimum": 0, "maximum": 100 },
        "strong_negative": { "type": "boolean" },
        "profile_update_required": { "type": "boolean" },
        "why": { "type": "string", "maxLength": 500 }
      },
      "additionalProperties": true
    },
    "tags": {
      "type": "array",
      "items": { "type": "string", "maxLength": 64 },
      "maxItems": 128
    },
    "anti_patterns": {
      "type": "array",
      "items": { "type": "string", "maxLength": 200 },
      "maxItems": 32
    },
    "self_eval": {
      "type": "object",
      "required": ["score", "confidence", "goal_gap", "why"],
      "properties": {
        "score": { "type": "integer", "minimum": -100, "maximum": 100 },
        "confidence": { "type": "integer", "minimum": 0, "maximum": 100 },
        "goal_score": { "type": "integer", "minimum": 0, "maximum": 100 },
        "result_score": { "type": "integer", "minimum": 0, "maximum": 100 },
        "evidence_score": { "type": "integer", "minimum": 0, "maximum": 100 },
        "risk_score": { "type": "integer", "minimum": 0, "maximum": 100 },
        "goal_gap": { "type": "string", "maxLength": 600 },
        "why": { "type": "string", "maxLength": 600 }
      },
      "additionalProperties": true
    },
    "learning": {
      "type": "object",
      "required": ["did_right", "did_wrong", "repeated_wrong", "flow_patch", "memory_patch", "user_profile_patch"],
      "properties": {
        "did_right": {
          "type": "array",
          "items": { "type": "string", "maxLength": 300 },
          "maxItems": 32
        },
        "did_wrong": {
          "type": "array",
          "items": { "type": "string", "maxLength": 300 },
          "maxItems": 32
        },
        "repeated_wrong": {
          "type": "array",
          "items": { "type": "string", "maxLength": 300 },
          "maxItems": 32
        },
        "flow_patch": {
          "type": "object",
          "required": ["required", "project_scope", "changes"],
          "properties": {
            "required": { "type": "boolean" },
            "project_scope": { "type": "string", "maxLength": 260 },
            "changes": {
              "type": "array",
              "items": { "type": "string", "maxLength": 400 },
              "maxItems": 32
            }
          },
          "additionalProperties": true
        },
        "memory_patch": {
          "type": "object",
          "required": ["required", "project_scope", "long_term_items", "short_term_items"],
          "properties": {
            "required": { "type": "boolean" },
            "project_scope": { "type": "string", "maxLength": 260 },
            "long_term_items": {
              "type": "array",
              "items": { "type": "string", "maxLength": 400 },
              "maxItems": 64
            },
            "short_term_items": {
              "type": "array",
              "items": { "type": "string", "maxLength": 400 },
              "maxItems": 64
            }
          },
          "additionalProperties": true
        },
        "user_profile_patch": {
          "type": "object",
          "required": ["required", "items", "sensitivity"],
          "properties": {
            "required": { "type": "boolean" },
            "items": {
              "type": "array",
              "items": { "type": "string", "maxLength": 400 },
              "maxItems": 64
            },
            "sensitivity": {
              "type": "string",
              "enum": ["normal", "sensitive"]
            }
          },
          "additionalProperties": true
        }
      },
      "additionalProperties": true
    },
    "extensions": {
      "type": "object",
      "additionalProperties": true
    }
  },
  "additionalProperties": true
}
```

### 4.1 前向兼容规则

1. 未识别字段：保留并透传，不报错。
2. 仅校验最小必填字段；可选字段缺失用默认值补齐。
3. `schema_version=1.x` 视为兼容；`2.x` 需要显式升级开关。

---

## 5) Digest 策略（核心）

### 5.1 负分立即 digest（刚性）

触发条件（任一满足）：
- `self_eval.score < 0`
- `user_signal.negative_score >= 70`
- `task_completed=false` 且 `self_eval.goal_gap` 非空

执行动作：
1. 立刻生成 `negative_digest`。
2. 仅保留高信号：
   - 本轮目标偏差（goal gap）
   - anti-pattern（不要做什么）
   - 失败工具调用参数与错误摘要
   - 最小证据指针（slot/task_id/session_id）
3. 写入 `historical_memory`，标记 lane=`negative`。

### 5.2 正分延后 digest（压缩阶段）

触发条件：
- `self_eval.score >= 0`

执行动作：
1. 先保留 raw turn（正文 + 工具轨迹 + tags）。
2. 到 context compaction/rebuild 阶段再生成 `positive_digest`。
3. 正分 digest 重组时按阈值和时间处理：
   - 若 `self_eval.score >= POSITIVE_REORDER_THRESHOLD`（默认 70），按时间优先重排。
   - 若低于阈值，按语义相关优先。

---

## 6) Dynamic Rebuild / Context Review 规则

### 6.1 输入来源

1. 当前会话最近 raw turns。
2. negative lane digests（优先）。
3. positive digests（压缩产物）。
4. 向量索引召回结果（tags + text + tools + task lineage）。

### 6.2 默认策略

每轮都允许做轻量动态 review（无需大模型排序）。

排序建议：

`rank = semantic + lineage + recency + lane_boost`

- `lane_boost`：negative lane > positive lane。
- positive lane 且高分条目可加时间重排权重。

### 6.3 上下文预算建议

- `historical_memory` 预算上限 20K token。
- negative lane 先占位（强保留）。
- 剩余预算填充 positive lane 与近邻 raw。

---

## 7) Hook 触发表（字段 → 动作）

| 字段条件 | Hook | 动作 |
|---|---|---|
| `task_completed=true && evidence_ready=true` | `hook.task.complete` | 允许收口与交付 |
| `task_completed=true && evidence_ready=false` | `hook.task.continue` | 禁止收口，继续执行 |
| `needs_user_input=true` | `hook.waiting_user` | 发 waiting-for-user 事件 |
| `wait.enabled=true && wait.seconds>0` | `hook.scheduler.wait` | 注册定时续跑 |
| `dispatch_required=true` | `hook.dispatch` | 触发任务派发 |
| `review_required=true` | `hook.reviewer` | 唤醒 reviewer 流程 |
| `context_review_hint=light/aggressive` | `hook.context.review` | 触发轻/重 rebuild |
| `self_eval.score<0` | `hook.digest.negative` | 立即 negative digest |
| `self_eval.score>=0` | `hook.digest.defer_positive` | 正分先保留 raw，后续压缩 digest |
| `user_signal.negative_score>=70` | `hook.user.profile.update` | 触发用户画像增量更新 |
| `anti_patterns.length>0` | `hook.user.guardrails.candidate` | 记录“不要做什么”候选约束 |
| `learning.flow_patch.required=true` | `hook.project.flow.update` | 更新项目 FLOW（append-only） |
| `learning.memory_patch.required=true` | `hook.project.memory.update` | 更新项目 MEMORY（append-only） |
| `learning.user_profile_patch.required=true` | `hook.user.profile.update` | 更新 USER 画像（append-only） |

### 7.2 运行时执行约束（已落地）

1. `hook.scheduler.wait`：运行时直接创建 clock delay timer（含 inject payload），到点自动唤醒原 session 继续执行。
2. `hook.context.review`：运行时直接调用 `context_builder.rebuild`（仅重写 P4.dynamic_history）。
3. `hook.project.flow.update` / `hook.project.memory.update` / `hook.user.profile.update`：
   - 运行时执行 append-only 写入；
   - 写入内容必须带 `idempotency_key` 与 `updated_at`；
   - 同 `session+turn+hook` 只执行一次（幂等去重）。
4. 任一 hook 执行失败：
   - 不阻塞 turn 完成路径；
   - 记录 `system_notice(source=control_hook_action, action=failed)` 供审计与续跑。

### 7.1 负向信号阈值建议

- `>=70`：本轮触发 profile 增量。
- `>=85`：升级 P0 质量告警。

---

## 8) 冲突与错误处理

### 8.1 解析失败

- 无 control block 或 JSON 解析失败：
  - 标记 `control_block_invalid`
  - 禁止收口
  - 自动触发 continuation 要求“仅补 control block”

### 8.2 字段冲突

- `task_completed=true` 且 `needs_user_input=true`：
  - 视为冲突，降级为未完成。
- `wait.enabled=true` 且 `needs_user_input=true`：
  - 优先 waiting_user；wait 作为后备。

### 8.3 反作弊校正（运行时）

若模型高分但缺证据：
- 运行时可下调有效评分，不允许进入“高质量正分”路径。

### 8.4 记忆与流程更新保护（刚性）

1. **禁止覆盖/删除历史**：
   - USER.md / FLOW.md / MEMORY.md 默认 append-only；
   - 任何“替换整段/删除旧条目”都必须拒绝。
2. 所有 patch 必须有 `evidence_ref`（turn_id/slot/task_id 之一）。
3. 同轮 patch 以 idempotency key 去重，避免重复写入。

### 8.5 每日更新（Daily Review）同规则

1. 每日更新执行与在线更新同一套 append-only 规则。
2. Daily 不得删除或覆盖旧画像/旧流程/旧记忆，只能新增条目或追加版本段。
3. Daily 必须写入审计：`updated_by`, `trigger`, `evidence_ref`, `date`。
4. Daily 结束必须产出备份（见 8.6）。

### 8.6 Obsidian 备份（可配置）

1. 支持将 Daily 更新后的 USER/FLOW/MEMORY 快照备份到 Obsidian 目录。
2. 备份目录由配置指定（例如：`dailySystemReview.backup.obsidianDir`）。
3. 备份命名建议：`YYYY-MM-DD/<type>/<name>.md`。
4. 若备份配置启用但目录不可写：
   - 不阻断主流程；
   - 必须记录告警并保留本地备份。

### 8.7 每日更新配置示例

```json
{
  "dailySystemReview": {
    "enabled": true,
    "windowStartHour": 0,
    "windowEndHour": 7,
    "maxQueueWaitMs": 30000,
    "appendOnly": true,
    "backup": {
      "enabled": true,
      "localDir": "~/.finger/system/backup/daily-review",
      "obsidianDir": "~/Documents/Obsidian/finger日志/backups/daily-review"
    }
  }
}
```

---

## 9) 实施阶段与验收

### Phase 1
- 接入 control block 解析与最小字段校验。
- 接入基础 hooks（complete/continue/wait/dispatch/review）。

### Phase 2
- 接入负分立即 digest、正分延后 digest。
- 接入向量索引后台任务。

### Phase 3
- 接入动态 rebuild 检索排序。
- 接入 profile 自动增量更新（基于 negative_score + anti_patterns）。

### 验收标准
1. 每轮均能解析 control block（成功率 > 99%）。
2. 负分轮次 100% 生成 negative digest。
3. 正分轮次在压缩阶段完成 digest 重组。
4. 重建中 negative digest 召回优先级正确。
5. Hook 触发路径可审计（日志/ledger 可追溯）。
