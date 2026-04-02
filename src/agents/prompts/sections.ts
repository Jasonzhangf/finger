/**
 * Prompt Section infrastructure
 *
 * Composable prompt building with caching for static sections
 * and recomputation for volatile (per-turn) sections.
 *
 * Design reference: claude-code/src/constants/systemPromptSections.ts
 */

type ComputeFn = () => string | null | Promise<string | null>

export interface PromptSection {
  name: string
  compute: ComputeFn
  cacheBreak: boolean
}

const sectionCache = new Map<string, string | null>()

/**
 * Create a cached prompt section.
 * Computed once, cached until `clearPromptCache()` is called.
 */
export function promptSection(
  name: string,
  compute: ComputeFn,
): PromptSection {
  return { name, compute, cacheBreak: false }
}

/**
 * Create a volatile prompt section that recomputes every turn.
 * Use for content that changes per invocation (timestamps, dynamic state, etc.).
 * The `reason` parameter documents why this section must break cache.
 */
export function volatileSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): PromptSection {
  return { name, compute, cacheBreak: true }
}

/**
 * Resolve all prompt sections into a combined prompt string.
 *
 * - Cached sections (cacheBreak=false) compute once and reuse cached values.
 * - Volatile sections (cacheBreak=true) recompute every call.
 * - Sections returning null are skipped.
 * - Non-null values are joined with double newlines.
 */
export async function resolvePromptSections(
  sections: PromptSection[],
): Promise<string> {
  const results: string[] = []

  for (const section of sections) {
    if (!section.cacheBreak && sectionCache.has(section.name)) {
      const cached = sectionCache.get(section.name)
      if (cached != null) {
        results.push(cached)
      }
      continue
    }

    const value = await section.compute()
    sectionCache.set(section.name, value)

    if (value != null) {
      results.push(value)
    }
  }

  return results.join('\n\n')
}

/**
 * Clear all section cache entries.
 * Typically called on session reset or compaction.
 */
export function clearPromptCache(): void {
  sectionCache.clear()
}
