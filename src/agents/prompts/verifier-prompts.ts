/**
 * Verification Agent Prompts
 *
 * Independent adversarial verification for non-trivial changes.
 * Design reference: VERIFICATION_AGENT_TYPE in claude-code
 *
 * AC-1: Non-trivial changes auto-trigger verification (3+ files, API/backend, infra)
 * AC-2: Verifier is session-isolated from implementer
 * AC-3: PASS results can be spot-checked
 */

import type { PromptSection } from './sections.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationVerdict = 'PASS' | 'FAIL' | 'PARTIAL'

export interface VerificationInput {
  /** Files that were changed */
  changedFiles: string[]
  /** Type of change for triggering classification */
  changeCategory: 'backend_api' | 'infrastructure' | 'frontend' | 'config' | 'multi_file'
  /** Summary of what was implemented */
  implementationSummary: string
  /** Acceptance criteria to verify against */
  acceptanceCriteria: string[]
}

export interface VerificationOutput {
  verdict: VerificationVerdict
  evidence: string[]
  issues: string[]
  spotCheckCommands: string[]
}

// ---------------------------------------------------------------------------
// Trigger conditions
// ---------------------------------------------------------------------------

/**
 * Determine if verification should be triggered for a change set.
 * AC-1: 3+ file edits, backend/API changes, infrastructure changes.
 */
export function shouldTriggerVerification(input: VerificationInput): boolean {
  if (input.changedFiles.length >= 3) return true
  if (input.changeCategory === 'backend_api') return true
  if (input.changeCategory === 'infrastructure') return true
  if (
    input.changeCategory === 'config' &&
    input.changedFiles.some((f) => f.includes('config') || f.endsWith('.json') || f.endsWith('.yaml'))
  ) {
    return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Verifier system prompt sections
// ---------------------------------------------------------------------------

const VERIFIER_ROLE_SECTION: PromptSection = {
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

## 输出格式
<verification>
<verdict>PASS | FAIL | PARTIAL</verdict>
<evidence>
- [证据1]
- [证据2]
</evidence>
<issues>
- [问题1（如有）]
- [问题2（如有）]
</issues>
<spot-check>
命令1：[可直接执行的验证命令]
命令2：[可直接执行的验证命令]
</spot-check>
</verification>`,
}

const VERIFIER_RULES_SECTION: PromptSection = {
  name: 'verifier-rules',
  cacheBreak: false,
  compute: () => `## 验证规则

### 对于每个验收标准
1. 逐条检查 AC 是否满足
2. 提供具体的代码证据（文件路径 + 行号 + 代码片段）
3. 标记无法验证的 AC 为 PARTIAL

### 判定标准
- **PASS**: 所有 AC 满足，无质量问题，spot-check 命令可执行
- **FAIL**: 任一 AC 不满足，或存在严重质量问题
- **PARTIAL**: 大部分 AC 满足，但部分无法验证（需要运行时测试）

### Spot-check 要求
- 为 PASS 结果提供 2-3 个可执行的验证命令
- 命令必须是可独立运行的（不需要额外上下文）
- 命令应覆盖核心功能的正确性`,
}

// ---------------------------------------------------------------------------
// Verification prompt builder
// ---------------------------------------------------------------------------

export const VERIFIER_SECTIONS: PromptSection[] = [
  VERIFIER_ROLE_SECTION,
  VERIFIER_RULES_SECTION,
]

/**
 * Build the full verification prompt for a specific verification task.
 */
export function buildVerificationPrompt(input: VerificationInput): string {
  const systemPrompt = VERIFIER_SECTIONS
    .map((s) => s.compute())
    .filter((v): v is string => v != null)
    .join('\n\n')

  const taskPrompt = `## 验证任务

### 变更文件
${input.changedFiles.map((f) => `- \`${f}\``).join('\n')}

### 变更类别
${input.changeCategory}

### 实现摘要
${input.implementationSummary}

### 验收标准
${input.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')}

请逐条验证每个验收标准，输出 <verification> 结构。`

  return `${systemPrompt}\n\n${taskPrompt}`
}

/**
 * Parse verification output from the verifier agent.
 */
export function parseVerificationOutput(raw: string): VerificationOutput {
  const verdictMatch = raw.match(/<verdict>\s*(PASS|FAIL|PARTIAL)\s*<\/verdict>/)
  const evidenceMatch = raw.match(/<evidence>([\s\S]*?)<\/evidence>/)
  const issuesMatch = raw.match(/<issues>([\s\S]*?)<\/issues>/)
  const spotCheckMatch = raw.match(/<spot-check>([\s\S]*?)<\/spot-check>/)

  const parseList = (block: string | undefined): string[] =>
    block
      ?.split('\n')
      .map((l) => l.replace(/^\s*-\s*/, '').trim())
      .filter(Boolean) ?? []

  return {
    verdict: verdictMatch?.[1] as VerificationVerdict ?? 'PARTIAL',
    evidence: parseList(evidenceMatch?.[1]),
    issues: parseList(issuesMatch?.[1]),
    spotCheckCommands: parseList(spotCheckMatch?.[1]),
  }
}
