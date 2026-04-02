/**
 * Compaction Prompt System
 *
 * Structured prompts for context compression with full and partial modes.
 * Design reference: claude-code/src/services/compact/prompt.ts
 *
 * AC-1: 9-section structured summary
 * AC-2: Full and partial compaction modes
 * AC-3: <analysis> + <summary> dual-layer output
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompactionMode = 'full' | 'partial'

export interface CompactionInput {
  /** The conversation messages to compact */
  messages: Array<{ role: string; content: string }>
  /** Optional custom instructions for compaction */
  customInstructions?: string
  /** For partial mode: the number of recent turns to preserve */
  preserveRecentCount?: number
}

export interface CompactionOutput {
  analysis: string
  summary: string
}

// ---------------------------------------------------------------------------
// Summary Sections (ordered)
// ---------------------------------------------------------------------------

export const SUMMARY_SECTIONS = [
  'Primary Request and Intent',
  'Key Technical Concepts',
  'Files and Code Sections',
  'Errors and Fixes',
  'Problem Solving',
  'All User Messages',
  'Pending Tasks',
  'Current Work',
  'Optional Next Step',
] as const

export type SummarySection = (typeof SUMMARY_SECTIONS)[number]

// ---------------------------------------------------------------------------
// Preamble — shared across modes
// ---------------------------------------------------------------------------

const PREAMBLE = `You are a context compaction assistant. Your task is to analyze the conversation so far and produce a structured summary that preserves all critical information while significantly reducing token count.

CRITICAL RULES:
- Respond with TEXT ONLY. Do NOT call any tools.
- Tool calls will be REJECTED and will waste your only turn.
- Preserve ALL important facts, decisions, file paths, code snippets, and user requests.
- Do NOT lose any user-stated requirements or constraints.
- Include exact file paths when code is referenced.
- Include error messages verbatim when they were key to problem-solving.`

// ---------------------------------------------------------------------------
// Output format template
// ---------------------------------------------------------------------------

const OUTPUT_FORMAT = `Your output MUST follow this exact structure:

<analysis>
[Your thinking process — identify key themes, decisions, blockers, and what the user actually cares about. This is your scratchpad for reasoning about what matters.]
</analysis>

<summary>
${SUMMARY_SECTIONS.map(
    (s, i) => `${i + 1}. **${s}**:\n   [Content for this section]`
  ).join('\n\n')}
</summary>`

// ---------------------------------------------------------------------------
// Section descriptions for the prompt
// ---------------------------------------------------------------------------

const SECTION_DESCRIPTIONS = `Section guidelines:

1. **Primary Request and Intent**: What did the user ask for? Capture the core goal, not implementation details.
2. **Key Technical Concepts**: Technologies, libraries, frameworks, patterns discussed. Include version numbers if mentioned.
3. **Files and Code Sections**: Every file that was read, modified, or created. Include the relevant code snippets in full — do NOT summarize code, preserve it exactly.
4. **Errors and Fixes**: Any errors encountered, their root causes, and how they were resolved. Include exact error messages.
5. **Problem Solving**: The reasoning chain — what approaches were tried, what failed, what worked, and why.
6. **All User Messages**: Every distinct user message/request in order. Preserve exact intent of each.
7. **Pending Tasks**: Anything explicitly requested but not yet completed. Include acceptance criteria.
8. **Current Work**: What was actively being worked on when compaction was triggered. Include exact state (which file, which function, what was about to happen next).
9. **Optional Next Step**: Based on current work, what the natural next action would be. This helps the agent resume seamlessly.`

// ---------------------------------------------------------------------------
// Full compaction prompt
// ---------------------------------------------------------------------------

export function getFullCompactionPrompt(input: CompactionInput): string {
  const parts = [
    PREAMBLE,
    '',
    `## Mode: FULL COMPACTION`,
    `You are compressing the ENTIRE conversation history.`,
    `The summary must be self-contained — the original messages will be discarded.`,
    '',
    SECTION_DESCRIPTIONS,
    '',
    OUTPUT_FORMAT,
  ]

  if (input.customInstructions) {
    parts.push('', '## Additional Instructions', input.customInstructions)
  }

  parts.push(
    '',
    '## Conversation to compact:',
    '<conversation>',
    input.messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n'),
    '</conversation>',
  )

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Partial compaction prompt
// ---------------------------------------------------------------------------

export function getPartialCompactionPrompt(input: CompactionInput): string {
  const preserveCount = input.preserveRecentCount ?? 4

  const parts = [
    PREAMBLE,
    '',
    `## Mode: PARTIAL COMPACTION`,
    `You are compressing OLDER messages while preserving the most recent ${preserveCount} message exchanges.`,
    `The summary replaces the compacted portion; recent messages remain in full.`,
    `Focus the summary on context that the recent messages depend on — prior decisions, file states, and established facts.`,
    '',
    SECTION_DESCRIPTIONS,
    '',
    OUTPUT_FORMAT,
  ]

  if (input.customInstructions) {
    parts.push('', '## Additional Instructions', input.customInstructions)
  }

  parts.push(
    '',
    '## Messages to compact (older portion):',
    '<conversation>',
    input.messages.map((m) => `[${m.role}]: ${m.content}`).join('\n\n'),
    '</conversation>',
  )

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Mode selector
// ---------------------------------------------------------------------------

export function getCompactionPrompt(input: CompactionInput): string {
  switch (input.messages.length > 20 ? 'full' : 'partial') {
    case 'full':
      return getFullCompactionPrompt(input)
    default:
      return getPartialCompactionPrompt(input)
  }
}

// ---------------------------------------------------------------------------
// Parse compaction output
// ---------------------------------------------------------------------------

export function parseCompactionOutput(raw: string): CompactionOutput {
  const analysisMatch = raw.match(/<analysis>([\s\S]*?)<\/analysis>/)
  const summaryMatch = raw.match(/<summary>([\s\S]*?)<\/summary>/)

  return {
    analysis: analysisMatch?.[1]?.trim() ?? '',
    summary: summaryMatch?.[1]?.trim() ?? raw,
  }
}

// ---------------------------------------------------------------------------
// Validate summary completeness
// ---------------------------------------------------------------------------

export function validateSummary(summary: string): {
  complete: boolean
  missing: string[]
} {
  const missing: string[] = []

  for (const section of SUMMARY_SECTIONS) {
    if (!summary.includes(section)) {
      missing.push(section)
    }
  }

  return {
    complete: missing.length === 0,
    missing,
  }
}
