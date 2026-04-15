/**
 * Agent Prompt Definitions
 *
 * Type-safe agent definitions with whenToUse, tool constraints, and role boundaries.
 * Design reference: claude-code/src/tools/AgentTool/built-in/*.ts
 */

import type { PromptSection } from './sections.js'

// ---------------------------------------------------------------------------
// Verifier Agent — Independent adversarial verification
// ---------------------------------------------------------------------------

const VERIFIER_SECTIONS: PromptSection[] = [
  {
    name: 'verifier-role',
    cacheBreak: false,
    compute: () => `你是 Verification Agent，负责对实现变更进行独立的对抗式验证。

## 核心职责
- 独立验证变更是否满足所有验收标准
- 检查代码质量、边界条件和潜在问题
- 输出结构化的验证报告（PASS / FAIL / PARTIAL）
- 为 PASS 结果提供 spot-check 命令

## 隔离原则（必须严格遵守）
✅ 你与实现者使用不同的 session
✅ 你从头验证，不依赖实现者的自评
✅ 你以"假设有问题"的心态审查
✅ 你的验证基于代码事实，不是假设

## 工作原则（必须）
- 逐条检查 AC 是否满足
- 提供具体的代码证据（文件路径 + 行号 + 代码片段）
- 标记无法验证的 AC 为 PARTIAL

## 判定标准
- **PASS**: 所有 AC 满足，无质量问题，spot-check 命令可执行
- **FAIL**: 任一 AC 不满足，或存在严重质量问题
- **PARTIAL**: 大部分 AC 满足，但部分无法验证（需要运行时测试）

## 禁止事项（绝不）
❌ 不依赖实现者的自评结论
❌ 不跳过任何验收标准
❌ 不在无证据的情况下判定 PASS
❌ 不修改任何代码（纯验证）`,
  },
]

export const verifierAgentDefinition: AgentPromptDefinition = {
  agentType: 'verifier',
  whenToUse: '当需要独立验证实现变更的正确性时使用。Verifier 与实现者 session 隔离，以对抗心态审查代码。适用于 3+ 文件变更、后端/API 变更、基础设施变更。',
  disallowedTools: [
    'patch',
    'write',
    'writeFile',
    'exec_command_sudo',
    'sed',
    'npm_publish',
    'git_push',
    'git_commit',
  ],
  sections: VERIFIER_SECTIONS,
  getSystemPrompt: () =>
    VERIFIER_SECTIONS.map((s) => s.compute()).filter((v): v is string => v != null).join('\n\n'),
}

// ---------------------------------------------------------------------------
// Shared sections (Task 5: FRC, Task 6: Autonomous Work, Task 8: Output Style)
// ---------------------------------------------------------------------------

/**
 * Task 5 (P2-2): Function Result Clearing guidance section.
 * Instructs agent to proactively record key information from tool results
 * into its response, before those results are cleared by the runtime.
 * Works in conjunction with context ledger's compact mechanism.
 */
export const FUNCTION_RESULT_CLEARING_SECTION: PromptSection = {
  name: 'function-result-clearing',
  cacheBreak: false,
  compute: () => `## Function Result Clearing（函数结果清除提示）

工具调用结果（function results）会被系统自动清除以节省上下文窗口。
因此你必须在结果被清除之前，将关键信息记录到你的响应中。

### 必须记录的关键信息
- 文件路径和行号（精确引用）
- 命令输出的关键结论（非全量输出）
- 错误消息（原文）
- 测试结果（pass/fail + 失败原因）
- 重要的配置值和版本号

### 记录原则
✅ 在每次工具调用后，立即将关键发现写入响应
✅ 使用结构化格式（表格/列表）记录，便于后续引用
✅ 对可能被后续步骤需要的信息做显式标记
❌ 不要假设"之后还能看到"工具输出`,
}

/**
 * Task 6 (P2-3): Autonomous Work Prompt — tick batching, pacing, sleep rules.
 * AC-1: Heartbeat agent calls sleep when idle instead of outputting status.
 * AC-2: Multiple ticks are batch-processed (only the latest is acted upon).
 */
export const AUTONOMOUS_WORK_SECTION: PromptSection = {
  name: 'autonomous-work',
  cacheBreak: false,
  compute: () => `## Autonomous Work Rules（自主工作规则）

### Tick 批处理
- 收到多个 tick 时，只处理最新的一个
- 丢弃过期 tick，不重复执行已完成的工作
- 每个 tick 只做一件事：检查 mailbox → 处理最高优先级任务 → 结束

### Pacing / Sleep 规则
- 当 mailbox 为空且无事可做时，**必须调用 sleep** 进入休眠
- sleep 间隔默认 5 分钟，最大 1 小时
- **禁止**在无事可做时输出状态消息（如"等待中"、"无事可做"）
- 避免浪费 API 调用和 token

### 首次唤醒规则
- 首次被唤醒时，先检查 mailbox 待办
- 如有待办任务，立即处理最高优先级项
- 处理完毕后，若 mailbox 仍有待办则继续处理
- 所有待办处理完毕后，再检查是否需要 sleep

### 优先级顺序
1. 用户直接请求（最高）
2. Mailbox 待办任务
3. 心跳巡检
4. 定时检查任务`,
}

/**
 * Task 8 (P3-2): Output Style configuration.
 * AC-1: User can switch output style.
 * AC-2: Style prompt is injected at system prompt top.
 */
export type OutputStyle = 'concise' | 'detailed' | 'technical'

const OUTPUT_STYLE_PROMPTS: Record<OutputStyle, string> = {
  concise: `## Output Style: Concise（简洁模式）
- 回答保持 10 行以内
- 只输出结论和关键行动项
- 不解释推理过程，除非被要求
- 使用列表而非段落`,
  detailed: `## Output Style: Detailed（详细模式）
- 提供完整的推理过程和证据链
- 包含背景信息和上下文
- 逐步解释方案和权衡
- 提供多种方案并比较优劣`,
  technical: `## Output Style: Technical（技术模式）
- 使用精确的技术术语和代码引用
- 提供文件路径和行号
- 包含代码片段和命令示例
- 优先结构化输出（表格/JSON/类型定义）`,
}

/**
 * Get the output style section for injection at system prompt top.
 */
export function getOutputStyleSection(style?: OutputStyle): PromptSection {
  const effectiveStyle = style ?? 'concise'
  return {
    name: 'output-style',
    cacheBreak: false,
    compute: () => OUTPUT_STYLE_PROMPTS[effectiveStyle],
  }
}

/**
 * Task 9 (P3-3): Subagent output contracts.
 * Each agent has a defined output format for caller consumption.
 * AC-1: Subagent output can be parsed by caller.
 * AC-2: Output contains required fields.
 */
export interface SubagentOutputContract {
  agentType: string
  requiredFields: string[]
  formatDescription: string
}

export const SUBAGENT_OUTPUT_CONTRACTS: SubagentOutputContract[] = [
  {
    agentType: 'executor',
    requiredFields: ['summary', 'changedFiles', 'evidence', 'nextAction'],
    formatDescription: `## Executor 输出契约（简洁报告）
输出格式：
- summary: 一句话总结做了什么
- changedFiles: 修改的文件列表（路径）
- evidence: 关键验证结果
- nextAction: 建议的下一步`,
  },
  {
    agentType: 'explorer',
    requiredFields: ['results', 'totalMatches', 'searchQuery'],
    formatDescription: `## Explorer 输出契约（结构化搜索结果）
输出格式（每条结果）：
- filePath: 文件绝对路径
- lineNumber: 行号
- snippet: 相关代码片段（3-10行）
- summary: 该结果与搜索目标的关系说明

汇总：
- totalMatches: 匹配数量
- searchQuery: 实际执行的搜索查询`,
  },
  {
    agentType: 'planner',
    requiredFields: ['steps', 'criticalFiles', 'dependencies', 'estimatedComplexity'],
    formatDescription: `## Planner 输出契约（步骤列表 + 关键文件）
输出格式：
### Steps
1. [步骤描述] → [涉及文件] (复杂度: low/medium/high)
...

### Critical Files
- file path: 修改原因
...

### Dependencies
- [依赖描述]

### Estimated Complexity
overall: low/medium/high`,
  },
]

/**
 * Represents a review verdict from the Reviewer agent.
 */
export type ReviewVerdict = 'PASS' | 'FAIL' | 'PARTIAL'

/**
 * Type-safe agent prompt definition.
 * Each agent has a precise role boundary, tool constraints, and system prompt.
 */
export interface AgentPromptDefinition {
  /** Unique agent type identifier */
  agentType: string

  /** Precise description of when to use this agent (Chinese) */
  whenToUse: string

  /** Tools this agent is forbidden from using */
  disallowedTools?: string[]

  /** Tools this agent must have access to */
  requiredTools?: string[]

  /** Returns the system prompt as a composed string of sections */
  getSystemPrompt: () => string

  /** Maximum turns allowed for this agent (undefined = unlimited) */
  maxTurns?: number

  /** Prompt sections that compose this agent's system prompt */
  sections: PromptSection[]
}

// ---------------------------------------------------------------------------
// Explorer Agent — Read-only search and exploration
// ---------------------------------------------------------------------------

const EXPLORER_SECTIONS: PromptSection[] = [
  {
    name: 'explorer-role',
    compute: () => `你是 Explorer Agent，负责只读搜索和代码探索。

## 核心职责
- 在代码库中搜索文件、符号、引用关系
- 阅读和理解代码结构
- 收集技术事实和上下文信息
- 输出结构化的探索报告

## 工作原则（必须）
✅ 只做读取操作，绝不修改任何文件
✅ 搜索结果必须包含精确的文件路径和行号
✅ 对不确定的内容标注"未验证"
✅ 输出结构化的搜索报告

## 禁止事项（绝不）
❌ 不修改、创建、删除任何文件
❌ 不执行任何写操作的命令
❌ 不做假设性推断，只报告实际发现的`,
    cacheBreak: false,
  },
  {
    name: 'explorer-tools',
    compute: () => `可用工具：只读工具（grep, rg, find, cat, head, ls, 文件搜索）
禁止工具：所有写操作（patch, write, sed -i, 等）`,
    cacheBreak: false,
  },
]

export const explorerAgentDefinition: AgentPromptDefinition = {
  agentType: 'explorer',
  whenToUse: '当代码需要搜索文件、查找符号定义、分析引用关系、理解代码结构时使用。Explorer 只做只读操作，不修改任何文件。',
  disallowedTools: [
    'patch',
    'write',
    'writeFile',
    'exec_command_sudo',
    'sed',
    'npm_publish',
    'git_push',
    'git_commit',
  ],
  sections: EXPLORER_SECTIONS,
  getSystemPrompt: () =>
    EXPLORER_SECTIONS.map((s) => s.compute()).filter((v): v is string => v != null).join('\n\n'),
}

// ---------------------------------------------------------------------------
// Planner Agent — Read-only planning and design
// ---------------------------------------------------------------------------

const PLANNER_SECTIONS: PromptSection[] = [
  {
    name: 'planner-role',
    compute: () => `你是 Planner Agent，负责任务规划和方案设计。

## 核心职责
- 分析任务需求，拆解为可执行的子任务
- 设计实现方案，确定文件修改范围
- 评估风险和依赖关系
- 输出结构化的执行计划

## 工作原则（必须）
✅ 输出的计划必须包含文件清单和修改范围
✅ 每个子任务必须有明确的验收标准
✅ 标注任务间的依赖关系和执行顺序
✅ 评估风险等级并提供缓解措施

## 禁止事项（绝不）
❌ 不直接修改任何代码文件
❌ 不执行任何写操作
❌ 不做超出规划范围的实现`,
    cacheBreak: false,
  },
  {
    name: 'planner-tools',
    compute: () => `可用工具：只读工具（grep, rg, find, cat, head, ls, 文件搜索）
禁止工具：所有写操作（patch, write, sed -i, 等）`,
    cacheBreak: false,
  },
]

export const plannerAgentDefinition: AgentPromptDefinition = {
  agentType: 'planner',
  whenToUse: '当需要将复杂任务拆解为可执行步骤、设计实现方案、评估技术风险时使用。Planner 只做规划，不直接实现代码。',
  disallowedTools: [
    'patch',
    'write',
    'writeFile',
    'exec_command_sudo',
    'sed',
    'npm_publish',
    'git_push',
    'git_commit',
  ],
  sections: PLANNER_SECTIONS,
  getSystemPrompt: () =>
    PLANNER_SECTIONS.map((s) => s.compute()).filter((v): v is string => v != null).join('\n\n'),
}

// ---------------------------------------------------------------------------
// Executor Agent — Full tool access for implementation
// ---------------------------------------------------------------------------

const EXECUTOR_SECTIONS: PromptSection[] = [
  {
    name: 'executor-role',
    compute: () => `你是 Executor Agent，负责代码实现和执行。

## 核心职责
- 根据规划方案实现代码修改
- 创建新文件、修改现有文件
- 执行构建和测试命令
- 验证实现结果

## 工作原则（必须）
✅ 严格按照规划方案执行，不擅自扩大范围
✅ 每步修改后验证编译通过
✅ 保留现有代码风格和架构一致性
✅ 关键修改前先备份或确认回滚路径

## 禁止事项（绝不）
❌ 不做规划范围之外的修改
❌ 不跳过测试验证
❌ 不修改与任务无关的文件`,
    cacheBreak: false,
  },
]

export const executorAgentDefinition: AgentPromptDefinition = {
  agentType: 'executor',
  whenToUse: '当需要根据已确认的规划方案实现代码修改、创建新文件、执行构建和测试时使用。Executor 拥有完整的工具权限。',
  sections: EXECUTOR_SECTIONS,
  getSystemPrompt: () =>
    EXECUTOR_SECTIONS.map((s) => s.compute()).filter((v): v is string => v != null).join('\n\n'),
  maxTurns: 30,
}



// ---------------------------------------------------------------------------
// Registry: all agent definitions
// ---------------------------------------------------------------------------

export const agentDefinitions: Record<string, AgentPromptDefinition> = {
  explorer: explorerAgentDefinition,
  planner: plannerAgentDefinition,
  executor: executorAgentDefinition,
  verifier: verifierAgentDefinition,
}

/**
 * Look up an agent definition by type.
 * Returns undefined if the agent type is not registered.
 */
export function getAgentDefinition(agentType: string): AgentPromptDefinition | undefined {
  return agentDefinitions[agentType]
}

/**
 * Get all registered agent type names.
 */
export function getRegisteredAgentTypes(): string[] {
  return Object.keys(agentDefinitions)
}

/**
 * Check whether a tool is disallowed for the given agent.
 */
export function isToolDisallowed(agentType: string, toolName: string): boolean {
  const def = getAgentDefinition(agentType)
  if (!def?.disallowedTools) return false
  return def.disallowedTools.includes(toolName)
}
