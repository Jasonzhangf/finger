# Finger 提示词优化设计文档

> 基于 claude-code 提示词架构对比分析
> 生成时间：2026-04-01
> 状态：待评审

---

## 一、对比分析总结

### 1.1 Claude Code 提示词架构（参考基准）

Claude Code 的提示词系统是一个**高度模块化、动态组合**的工程体系：

| 维度 | Claude Code 做法 | Finger 现状 |
|------|-----------------|------------|
| **结构** | `systemPromptSection()` 函数式组合，每个 section 独立计算、缓存、可选注入 | Markdown 文件静态拼接，角色文件硬编码 |
| **缓存策略** | `systemPromptSection` 支持缓存直到 `/clear` 或 `/compact`；`DANGEROUS_uncachedSystemPromptSection` 标记易变部分 | 无提示词缓存机制，每次全量注入 |
| **条件注入** | 根据 feature flag、工具可用性、session 类型动态决定是否注入某些 section | 所有 section 无条件注入，无法按场景裁剪 |
| **Compaction** | 完整的 compaction prompt 体系（`prompt.ts`），支持 base/partial 两种模式，有结构化摘要模板 | 无专门的 compaction prompt，依赖通用指令 |
| **子 Agent 提示词** | `BuiltInAgentDefinition` 类型安全，每个 agent 有明确的 `whenToUse`、`disallowedTools`、`getSystemPrompt()` | `agents-prompts-md/*.md` 纯文本，无类型约束，无工具权限管理 |
| **Subagent 模型** | Explore（只读搜索）、Plan（只读规划）、General Purpose（全工具）、Verification（对抗验证）— 每个 agent 有精确的工具白/黑名单 | router/planner/reviewer/coder/executor/orchestrator — 角色描述模糊，工具边界不清 |
| **权限模式** | approval mode（never/on-failure/on-request/untrusted）影响 agent 行为指令 | 无 approval mode 概念，所有 agent 统一行为 |
| **Function Result Clearing** | 自动清除旧 tool result，提示 agent 在响应中记录重要信息 | 无此机制 |
| **Output Style** | 可配置的输出风格注入（OutputStyleConfig） | 无输出风格配置 |
| **Proactive/Autonomous** | 有完整的 autonomous work prompt（tick/sleep 机制） | 心跳机制存在但提示词不精细 |
| **验证闭环** | Verification Agent 对抗式验证，PASS/FAIL/PARTIAL 状态机 | Reviewer 仅做一般性 review，无对抗验证机制 |

### 1.2 关键差距

1. **提示词不是代码**：Finger 的提示词是 Markdown 文件，缺乏类型安全、条件逻辑和运行时组合能力
2. **无 Compaction 策略**：长对话时无结构化的上下文压缩指导
3. **子 Agent 边界模糊**：`agents-prompts-md/` 中的角色定义过于笼统，缺乏具体的 `whenToUse` 和工具约束
4. **无动态裁剪**：每次都注入全部提示词，浪费 token
5. **缺少验证闭环**：无 Verification Agent 的对抗验证设计

---

## 二、优化方案

### Phase 1：提示词工程基础设施（高优先级）

#### P1-1: 提示词 Section 化重构

**目标**：将 Finger 的提示词从"大块 Markdown 拼接"改为"Section 组合注入"。

**参考**：`claude-code/src/constants/systemPromptSections.ts`

**设计**：

```typescript
// src/agents/prompts/sections.ts
type PromptSection = {
  name: string;
  compute: () => string | null | Promise<string | null>;
  cacheBreak: boolean;  // true = 每轮重算（如时间、mailbox 状态）
};

function promptSection(name: string, compute: () => string | null): PromptSection {
  return { name, compute, cacheBreak: false };
}

function volatileSection(name: string, compute: () => string | null, reason: string): PromptSection {
  return { name, compute, cacheBreak: true };
}
```

**交付物**：
- `src/agents/prompts/sections.ts` — Section 类型定义和组合工具
- 各 agent 的 section 注册器

**验收标准**：
- AC-1: 每个 agent 的 system prompt 由多个 named section 组合而成
- AC-2: 支持 cached section（不变）和 volatile section（每轮变）
- AC-3: section 可根据 feature flag 或配置条件性跳过

#### P1-2: Compaction Prompt 体系

**目标**：为 Finger 的上下文压缩提供结构化的 compaction prompt。

**参考**：`claude-code/src/services/compact/prompt.ts`

**设计**：

compaction prompt 需要支持两种模式：
1. **Full compaction**：压缩整个对话历史
2. **Partial compaction**：只压缩最近 N 轮，保留早期上下文

摘要模板必须包含：
- Primary Request and Intent
- Key Technical Concepts
- Files and Code Sections（含完整代码片段）
- Errors and fixes
- Problem Solving
- All user messages
- Pending Tasks
- Current Work
- Optional Next Step

**交付物**：
- `src/agents/prompts/compaction-prompts.ts`
- Full/Partial compaction prompt 模板
- `<analysis>` + `<summary>` 结构化输出指导

**验收标准**：
- AC-1: compaction prompt 生成结构化摘要，包含上述 9 个 section
- AC-2: 支持 full 和 partial 两种模式
- AC-3: 包含 `<analysis>` 思考过程 + `<summary>` 最终输出

#### P1-3: 子 Agent 提示词类型化

**目标**：为每个子 Agent 建立类型安全的提示词定义，包含 `whenToUse`、工具约束、角色边界。

**参考**：`claude-code/src/tools/AgentTool/built-in/*.ts`

**设计**：

```typescript
interface AgentPromptDefinition {
  agentType: string;
  whenToUse: string;          // 精确描述何时使用此 agent
  disallowedTools?: string[];  // 禁止使用的工具列表
  requiredTools?: string[];    // 必须具备的工具列表
  getSystemPrompt: () => string;
  maxTurns?: number;           // 最大轮次限制
}
```

**需要重新定义的 Agent**：

| Agent | 角色定位 | 核心约束 |
|-------|---------|---------|
| Explorer | 只读代码搜索 | 禁止写操作，禁止创建文件 |
| Planner | 只读架构规划 | 禁止修改文件，输出 Critical Files 列表 |
| Executor | 代码实现 | 全工具权限，必须验证 |
| Reviewer | 代码审查 | 只读，输出 PASS/FAIL/PARTIAL |
| Orchestrator | 任务编排 | 可 dispatch 但默认不直接编码 |

**交付物**：
- `src/agents/prompts/agent-definitions.ts` — 类型定义
- 每个 agent 的 `BuiltInAgentDefinition` 实现
- 更新 `agents-prompts-md/*.md` 与代码定义同步

**验收标准**：
- AC-1: 每个 agent 有明确的 `whenToUse` 描述
- AC-2: Explorer/Planner 有 `disallowedTools` 禁止写操作
- AC-3: Reviewer 输出结构化 PASS/FAIL/PARTIAL 判定

### Phase 2：动态提示词优化（中优先级）

#### P2-1: 条件性 Section 注入

**目标**：根据运行时状态动态决定注入哪些 prompt section。

**设计**：
- 工具可用性检查：如果某个工具不可用，不注入相关指令
- Feature flag 控制：实验性功能通过 flag 开关
- Session 类型适配：interactive vs non-interactive session 不同指令

**交付物**：
- `src/agents/prompts/conditional-injector.ts`
- 条件注入规则配置

**验收标准**：
- AC-1: 不可用工具的指令不被注入
- AC-2: feature flag 为 false 时相关 section 不注入

#### P2-2: Function Result Clearing 指导

**目标**：当旧 tool result 被清除时，指导 agent 在响应中记录重要信息。

**参考**：`SUMMARIZE_TOOL_RESULTS_SECTION`

**设计**：
在 system prompt 中注入：
> "When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later."

**交付物**：
- 在 section 注册中添加 function result clearing section
- 与 context ledger 的 compact 机制联动

**验收标准**：
- AC-1: agent 在处理 tool result 时主动记录关键信息到响应中

#### P2-3: Autonomous Work Prompt 精细化

**目标**：为心跳/定时任务场景提供精细的 autonomous work 指导。

**参考**：`getProactiveSection()` — tick/sleep/pacing 机制

**设计**：
- Tick 处理规则：多个 tick 批处理，只处理最新
- Pacing 规则：sleep 长短根据等待类型调整
- 首次唤醒规则：问候 + 等待指令
- 空闲规则：无事可做必须 sleep，不输出 "still waiting"

**交付物**：
- 更新 `HEARTBEAT.md` 和心跳相关 prompt section
- 添加 pacing/sleep 指导

**验收标准**：
- AC-1: 心跳 agent 在无事可做时调用 sleep 而非输出状态消息
- AC-2: 多个 tick 合并处理

### Phase 3：验证与输出优化（低优先级）

#### P3-1: Verification Agent（对抗验证）

**目标**：引入独立的 Verification Agent，对非平凡实现进行对抗式验证。

**参考**：`VERIFICATION_AGENT_TYPE` in `prompts.ts`

**设计**：
- 触发条件：3+ 文件编辑、后端/API 变更、基础设施变更
- 验证者与实现者独立：不能自审自
- 输出：PASS / FAIL / PARTIAL
- 流程：FAIL → 修复 → 重新验证直到 PASS → 抽查确认

**交付物**：
- `agents-prompts-md/verifier.md`
- `src/agents/prompts/verifier-prompts.ts`
- 验证触发规则配置

**验收标准**：
- AC-1: 非平凡变更自动触发验证
- AC-2: 验证者与实现者 session 隔离
- AC-3: PASS 结果可被抽查（spot-check 2-3 个命令）

#### P3-2: Output Style 配置化

**目标**：支持用户自定义输出风格（简洁/详细/技术）。

**参考**：`getOutputStyleSection()`

**设计**：
- 配置文件：`~/.finger/config/user-settings.json` 中 `outputStyle` 字段
- 内置风格：concise（默认）、detailed、technical
- 风格 prompt 注入到 system prompt 顶部

**交付物**：
- 输出风格配置读取
- 风格 prompt section

**验收标准**：
- AC-1: 用户可切换输出风格
- AC-2: 风格 prompt 正确注入

#### P3-3: Subagent 输出契约

**目标**：规范子 Agent 的输出格式，确保调用者能可靠解析。

**设计**：
- General Purpose Agent：简洁报告（what was done + key findings）
- Explorer：结构化搜索结果（file path + relevant snippet + summary）
- Planner：步骤列表 + Critical Files 列表

**交付物**：
- 每个 agent 的输出契约定义
- 输出格式验证

**验收标准**：
- AC-1: 子 Agent 输出格式可被调用者解析
- AC-2: 输出包含必要字段（文件路径、摘要等）

---

## 三、实施计划

### 任务分解与依赖

```
P1-1 Section 化 ─┬─→ P1-2 Compaction Prompt
                 └─→ P1-3 Agent 类型化 ─→ P2-1 条件注入
                                       ─→ P2-2 FRC 指导
P1-1 Section 化 ─→ P2-3 Autonomous 精细化
P1-3 Agent 类型化 ─→ P3-1 Verification Agent
P1-1 Section 化 ─→ P3-2 Output Style
P1-3 Agent 类型化 ─→ P3-3 Subagent 输出契约
```

### 派发顺序

1. **Task 1**: P1-1 提示词 Section 化基础设施（`src/agents/prompts/sections.ts`）
2. **Task 2**: P1-3 子 Agent 提示词类型化（依赖 Task 1）
3. **Task 3**: P1-2 Compaction Prompt 体系（依赖 Task 1）
4. **Task 4**: P2-1 条件性 Section 注入（依赖 Task 1, 2）
5. **Task 5**: P2-2 Function Result Clearing 指导（依赖 Task 1）
6. **Task 6**: P2-3 Autonomous Work Prompt 精细化（依赖 Task 1）
7. **Task 7**: P3-1 Verification Agent（依赖 Task 2）
8. **Task 8**: P3-2 Output Style 配置化（依赖 Task 1）
9. **Task 9**: P3-3 Subagent 输出契约（依赖 Task 2）

### 关键文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/agents/prompts/sections.ts` | 新建 | Section 类型定义和组合工具 |
| `src/agents/prompts/compaction-prompts.ts` | 新建 | Compaction prompt 模板 |
| `src/agents/prompts/agent-definitions.ts` | 新建 | Agent 类型安全定义 |
| `src/agents/prompts/conditional-injector.ts` | 新建 | 条件注入逻辑 |
| `src/agents/prompts/index.ts` | 修改 | 导出新模块 |
| `src/agents/prompts/understanding-prompts.ts` | 修改 | Section 化重构 |
| `src/agents/prompts/router-prompts.ts` | 修改 | Section 化重构 |
| `src/agents/prompts/planner-prompts.ts` | 修改 | Section 化重构 |
| `src/agents/prompts/reviewer-prompts.ts` | 修改 | Section 化重构 |
| `src/agents/prompts/executor-prompts.ts` | 修改 | Section 化重构 |
| `src/agents/prompts/orchestrator-prompts.ts` | 修改 | Section 化重构 |
| `agents-prompts-md/*.md` | 修改 | 与代码定义同步 |
| `docs/reference/templates/system-agent/roles/*.md` | 修改 | System agent 角色提示词更新 |

---

## 四、风险与注意事项

1. **向后兼容**：Section 化重构不能破坏现有 agent 的行为，需要逐步迁移
2. **Token 预算**：每个 section 需要评估 token 成本，避免总 prompt 超限
3. **测试覆盖**：每个 phase 需要有对应的 prompt 输出测试
4. **配置热更新**：Section 缓存需要支持 `/clear` 或 `/compact` 时清除
5. **多语言**：Finger 有中英文混合的 prompt，需要统一语言策略

---

## 五、Claude Code 值得借鉴的具体设计模式

### 5.1 NO_TOOLS_PREAMBLE
Compaction 时明确禁止工具调用，避免浪费唯一轮次：
```
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Tool calls will be REJECTED and will waste your only turn.
```

### 5.2 Structured Summary Template
Compaction 输出使用 `<analysis>` + `<summary>` 双层结构，analysis 是草稿，summary 是最终输出。

### 5.3 Verification Contract
非平凡变更自动触发独立验证者，验证者与实现者隔离，PASS/FAIL/PARTIAL 状态机。

### 5.4 Sleep/Pacing 机制
Autonomous 模式下，无事可做必须 sleep，避免浪费 API 调用和 token。

### 5.5 Disallowed Tools per Agent
每个子 Agent 有明确的工具黑名单，从工具层面防止越权操作。

### 5.6 Function Result Clearing Warning
提醒 agent 主动在响应中记录关键信息，因为 tool result 可能被自动清除。
