/**
 * Conditional Section Injector
 *
 * Dynamically decides which prompt sections to inject based on runtime state:
 * - Tool availability checks
 * - Feature flag control
 * - Session type adaptation
 *
 * Design reference: claude-code/src/constants/systemPromptSections.ts
 * AC-1: Instructions for unavailable tools are not injected
 * AC-2: Feature flag = false → related section not injected
 */

import type { PromptSection } from './sections.js'

// ---------------------------------------------------------------------------
// Runtime context for conditional injection
// ---------------------------------------------------------------------------

export interface InjectionContext {
  /** Available tool names in the current session */
  availableTools: Set<string>
  /** Feature flags (key → enabled) */
  featureFlags: Record<string, boolean>
  /** Session type (e.g., 'main', 'review', 'heartbeat', 'explorer') */
  sessionType: string
  /** Agent type requesting injection (e.g., 'executor', 'planner') */
  agentType: string
  /** Output style preference */
  outputStyle?: 'concise' | 'detailed' | 'technical'
}

// ---------------------------------------------------------------------------
// Section guard types
// ---------------------------------------------------------------------------

/**
 * A guarded section wraps a PromptSection with injection conditions.
 * All guards must pass for the section to be included.
 */
export interface GuardedSection {
  section: PromptSection
  /** Tools that must be available for this section to be relevant */
  requiredTools?: string[]
  /** Feature flags that must be enabled (true) for this section */
  requiredFeatureFlags?: string[]
  /** Session types where this section is applicable (empty = all types) */
  applicableSessionTypes?: string[]
  /** Agent types where this section is applicable (empty = all agents) */
  applicableAgentTypes?: string[]
}

// ---------------------------------------------------------------------------
// Injection logic
// ---------------------------------------------------------------------------

/**
 * Check if a single guarded section should be injected.
 */
function shouldInject(section: GuardedSection, ctx: InjectionContext): boolean {
  // Check tool availability
  if (section.requiredTools) {
    for (const tool of section.requiredTools) {
      if (!ctx.availableTools.has(tool)) {
        return false
      }
    }
  }

  // Check feature flags
  if (section.requiredFeatureFlags) {
    for (const flag of section.requiredFeatureFlags) {
      if (!ctx.featureFlags[flag]) {
        return false
      }
    }
  }

  // Check session type applicability
  if (section.applicableSessionTypes && section.applicableSessionTypes.length > 0) {
    if (!section.applicableSessionTypes.includes(ctx.sessionType)) {
      return false
    }
  }

  // Check agent type applicability
  if (section.applicableAgentTypes && section.applicableAgentTypes.length > 0) {
    if (!section.applicableAgentTypes.includes(ctx.agentType)) {
      return false
    }
  }

  return true
}

/**
 * Filter and resolve guarded sections based on runtime context.
 * Returns only the sections whose guards pass, then resolves them.
 */
export function filterSections(
  guarded: GuardedSection[],
  ctx: InjectionContext,
): PromptSection[] {
  return guarded
    .filter((g) => shouldInject(g, ctx))
    .map((g) => g.section)
}

/**
 * Filter and resolve guarded sections into a combined prompt string.
 */
export async function resolveGuardedSections(
  guarded: GuardedSection[],
  ctx: InjectionContext,
): Promise<string> {
  const { resolvePromptSections } = await import('./sections.js')
  const filtered = filterSections(guarded, ctx)
  return resolvePromptSections(filtered)
}

// ---------------------------------------------------------------------------
// Built-in guard factories
// ---------------------------------------------------------------------------

/**
 * Create a section that requires specific tools to be available.
 */
export function toolGuardedSection(
  section: PromptSection,
  tools: string[],
): GuardedSection {
  return { section, requiredTools: tools }
}

/**
 * Create a section that requires specific feature flags.
 */
export function featureGuardedSection(
  section: PromptSection,
  flags: string[],
): GuardedSection {
  return { section, requiredFeatureFlags: flags }
}

/**
 * Create a section scoped to specific session types.
 */
export function sessionScopedSection(
  section: PromptSection,
  sessionTypes: string[],
): GuardedSection {
  return { section, applicableSessionTypes: sessionTypes }
}

/**
 * Create a section scoped to specific agent types.
 */
export function agentScopedSection(
  section: PromptSection,
  agentTypes: string[],
): GuardedSection {
  return { section, applicableAgentTypes: agentTypes }
}
