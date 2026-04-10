import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type {
  InsightsEngineConfig,
  LedgerEvent,
  LearningEntry,
  UsageInsights,
  ToolUsageStats,
  CostEstimation,
} from './types.js';
import {
  clusterFailures,
  clusterSuccesses,
  extractUserPreferences,
  extractToolUsageFromEvents,
} from './patterns.js';

const DEFAULT_CONFIG: InsightsEngineConfig = {
  ledgerPath: '',
  lookbackDays: 7,
  minPatternCount: 3,
  similarityThreshold: 0.8,
};

export class InsightsEngine {
  private config: InsightsEngineConfig;

  constructor(config?: Partial<InsightsEngineConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Main analysis entry point. Reads ledger JSONL, extracts learnings,
   * clusters patterns, and produces a full UsageInsights report.
   */
  async analyze(days?: number): Promise<UsageInsights> {
    const lookback = days ?? this.config.lookbackDays;
    const cutoff = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000);

    const events = await this.readLedgerEvents(cutoff);
    const learnings = this.extractLearnings(events, cutoff);
    const toolUsageMap = extractToolUsageFromEvents(events);

    const clusterOpts = {
      similarityThreshold: this.config.similarityThreshold,
      minPatternCount: this.config.minPatternCount,
    };

    const failurePatterns = clusterFailures(learnings, clusterOpts);
    const successPatterns = clusterSuccesses(learnings, clusterOpts);
    const userPrefs = extractUserPreferences(learnings);
    const toolStats = this.buildToolStats(toolUsageMap);
    const costEst = this.estimateCost(events);
    const recommendations = this.generateRecommendations(
      failurePatterns,
      successPatterns,
      costEst,
    );

    return {
      generatedAt: new Date(),
      periodDays: lookback,
      failurePatterns,
      successPatterns,
      toolUsageStats: toolStats,
      userPreferences: userPrefs,
      costEstimation: costEst,
      recommendations,
    };
  }

  /**
   * Read ledger JSONL events from files, filtering by cutoff date.
   * Supports multiple JSONL files or a single file at ledgerPath.
   */
  async readLedgerEvents(cutoff: Date): Promise<LedgerEvent[]> {
    if (!this.config.ledgerPath) return [];
    const events: LedgerEvent[] = [];
    try {
      const content = await readFile(this.config.ledgerPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as LedgerEvent;
          if (new Date(event.timestamp) >= cutoff) {
            events.push(event);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File not found or unreadable; return empty
    }
    return events;
  }

  /**
   * Extract structured LearningEntry objects from ledger events.
   * Looks for reasoning_stop / reasoning.stop events with learning data.
   */
  extractLearnings(events: LedgerEvent[], cutoff: Date): LearningEntry[] {
    const entries: LearningEntry[] = [];
    for (const event of events) {
      if (event.type !== 'reasoning_stop' && event.type !== 'reasoning.stop') continue;
      const data = event.data;
      if (!data) continue;

      const successes = Array.isArray(data.successes)
        ? (data.successes as string[])
        : [];
      const failures = Array.isArray(data.failures)
        ? (data.failures as string[])
        : [];
      const tags = Array.isArray(data.tags)
        ? (data.tags as string[])
        : [];

      if (successes.length === 0 && failures.length === 0) continue;

      const toolUsage = Array.isArray(data.toolsUsed)
        ? (data.toolsUsed as Array<{ tool: string; args?: string; status?: string }>).map((t) => ({
            tool: t.tool,
            args: t.args ?? '',
            status: (t.status === 'success' ? 'success' : t.status === 'failure' ? 'failure' : 'unknown') as 'success' | 'failure' | 'unknown',
          }))
        : [];

      entries.push({
        timestamp: new Date(event.timestamp),
        successes,
        failures,
        tags,
        toolUsage,
        sessionId: event.sessionId,
      });
    }
    return entries;
  }

  private buildToolStats(
    usageMap: Map<string, { total: number; success: number; fail: number }>,
  ): ToolUsageStats[] {
    const stats: ToolUsageStats[] = [];
    for (const [tool, counts] of usageMap) {
      stats.push({
        tool,
        totalCalls: counts.total,
        successRate: counts.total > 0 ? counts.success / counts.total : 0,
      });
    }
    return stats.sort((a, b) => b.totalCalls - a.totalCalls);
  }

  private estimateCost(events: LedgerEvent[]): CostEstimation {
    let totalTokens = 0;
    const breakdown: Record<string, number> = {};

    for (const event of events) {
      const tokens = (event.data?.tokens as number) ?? 0;
      if (tokens > 0) {
        totalTokens += tokens;
        const model = ((event.data?.model as string) ?? 'unknown');
        breakdown[model] = (breakdown[model] ?? 0) + tokens;
      }
    }

    // Simple anomaly detection: flag if tokens > 100k in the period
    const anomaly = totalTokens > 100_000;

    return { totalTokens, anomaly, breakdown };
  }

  private generateRecommendations(
    failurePatterns: Array<{ count: number; recommendation: string }>,
    successPatterns: Array<{ count: number; reusablePattern: string }>,
    cost: CostEstimation,
  ): string[] {
    const recs: string[] = [];

    for (const fp of failurePatterns) {
      recs.push(`[Failure x${fp.count}] ${fp.recommendation}`);
    }

    if (cost.anomaly) {
      recs.push(
        `[Cost Warning] Total tokens (${cost.totalTokens.toLocaleString()}) exceeds 100k threshold — review usage patterns`,
      );
    }

    for (const sp of successPatterns.slice(0, 3)) {
      recs.push(`[Success x${sp.count}] Consider codifying: ${sp.reusablePattern.slice(0, 80)}`);
    }

    return recs;
  }
}

/**
 * Streaming reader for large JSONL files. Yields parsed events one at a time.
 */
export async function* streamLedgerEvents(
  filePath: string,
  cutoff: Date,
): AsyncGenerator<LedgerEvent> {
  const rl = createInterface({
    input: createReadStream(filePath, 'utf-8'),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as LedgerEvent;
      if (new Date(event.timestamp) >= cutoff) {
        yield event;
      }
    } catch {
      // Skip malformed
    }
  }
}
