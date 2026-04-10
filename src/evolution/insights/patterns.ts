import type {
  LedgerEvent,
  FailurePattern,
  SuccessPattern,
  UserPreferencePattern,
  LearningEntry,
} from './types.js';

/**
 * Cluster similar strings using simple token-based Jaccard similarity.
 * For production use, replace with embedding-based semantic similarity.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(s.toLowerCase().split(/\s+/).filter(Boolean));
  const setA = tokenize(a);
  const setB = tokenize(b);
  const intersection = [...setA].filter((t) => setB.has(t));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.length / union.size;
}

export interface ClusterOptions {
  similarityThreshold: number;
  minPatternCount: number;
}

/**
 * Cluster failures using single-linkage agglomerative clustering
 * based on token Jaccard similarity. Returns only clusters with
 * count >= minPatternCount.
 */
export function clusterFailures(
  entries: LearningEntry[],
  options: ClusterOptions,
): FailurePattern[] {
  const failures = entries.flatMap((e) =>
    e.failures.map((f) => ({ text: f, timestamp: e.timestamp })),
  );

  // Build clusters via union-find
  const parent = failures.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < failures.length; i++) {
    for (let j = i + 1; j < failures.length; j++) {
      if (jaccardSimilarity(failures[i].text, failures[j].text) >= options.similarityThreshold) {
        union(i, j);
      }
    }
  }

  // Group by root
  const groups = new Map<number, number[]>();
  for (let i = 0; i < failures.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const patterns: FailurePattern[] = [];
  let patternId = 0;
  for (const [, indices] of groups) {
    const count = indices.length;
    if (count < options.minPatternCount) continue;
    const examples = indices.slice(0, 5).map((i) => failures[i].text);
    const representative = examples[0];
    patterns.push({
      id: `failure-pattern-${++patternId}`,
      count,
      examples,
      recommendation: generateFailureRecommendation(representative),
      rootCauseHypothesis: extractRootCause(representative),
    });
  }

  return patterns.sort((a, b) => b.count - a.count);
}

/**
 * Cluster successes into reusable patterns.
 */
export function clusterSuccesses(
  entries: LearningEntry[],
  options: ClusterOptions,
): SuccessPattern[] {
  const successes = entries.flatMap((e) =>
    e.successes.map((s) => ({ text: s, timestamp: e.timestamp })),
  );

  const parent = successes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < successes.length; i++) {
    for (let j = i + 1; j < successes.length; j++) {
      if (jaccardSimilarity(successes[i].text, successes[j].text) >= options.similarityThreshold) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < successes.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const patterns: SuccessPattern[] = [];
  let patternId = 0;
  for (const [, indices] of groups) {
    const count = indices.length;
    if (count < options.minPatternCount) continue;
    const examples = indices.slice(0, 5).map((i) => successes[i].text);
    patterns.push({
      id: `success-pattern-${++patternId}`,
      count,
      examples,
      reusablePattern: examples[0],
    });
  }

  return patterns.sort((a, b) => b.count - a.count);
}

/**
 * Extract user intent patterns from tags.
 */
export function extractUserPreferences(
  entries: LearningEntry[],
): UserPreferencePattern[] {
  const tagCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const total = entries.length || 1;
  return Array.from(tagCounts.entries())
    .map(([pattern, frequency]) => ({
       pattern,
       frequency,
       confidence: frequency / total,
     }))
    .filter((p) => p.frequency >= 2)
    .sort((a, b) => b.frequency - a.frequency);
}

/**
 * Parse tool call events from ledger events.
 */
export function extractToolUsageFromEvents(
  events: LedgerEvent[],
): Map<string, { total: number; success: number; fail: number }> {
  const stats = new Map<string, { total: number; success: number; fail: number }>();
  for (const event of events) {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') continue;
    const toolName =
      (event.data?.tool as string) ??
      (event.data?.name as string) ??
      'unknown';
    const existing = stats.get(toolName) ?? { total: 0, success: 0, fail: 0 };
    existing.total++;
    const status = event.data?.status as string | undefined;
    if (status === 'success') existing.success++;
    else if (status === 'failure' || status === 'error') existing.fail++;
    stats.set(toolName, existing);
  }
  return stats;
}

function generateFailureRecommendation(text: string): string {
  if (/EPIPE|stdin.*closed/i.test(text)) {
    return 'Detect EPIPE early and retry with re-opened stdin';
  }
  if (/tool.*not.*exist|tool.*not.*found/i.test(text)) {
    return 'Check allowed_tools list before calling; re-init session if tools missing';
  }
  if (/timeout|timed?\s*out/i.test(text)) {
    return 'Add timeout guards and fallback logic for long-running operations';
  }
  if (/apply_patch|patch.*fail/i.test(text)) {
    return 'Verify file exists and content matches before patching';
  }
  return `Review and add guard for: ${text.slice(0, 80)}`;
}

function extractRootCause(text: string): string {
  const arrowMatch = text.match(/→\s*(.+?)(?:\s*→|$)/);
  if (arrowMatch) return arrowMatch[1].trim();
  return text.slice(0, 100);
}
