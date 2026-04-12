/**
 * Insights Scheduler - Scheduled insights generation via clock/cron
 * Integrates with InsightsEngine to produce periodic analysis reports
 */

import path from 'path';
import { logger } from '../../core/logger.js';
import { FINGER_PATHS, ensureDir } from '../../core/finger-paths.js';
import { InsightsEngine } from './engine.js';
import { formatInsightsReport } from './report.js';
import { syncLearningsBatch, isMempalaceAvailable } from './mempalace-bridge.js';
import type { UsageInsights, LearningEntry } from './types.js';

const log = logger.module('InsightsScheduler');

export interface InsightsSchedulerConfig {
  enabled: boolean;
  dailyCron: string;       // Daily insights generation cron (default: 0 6 * * *)
  weeklyCron: string;      // Weekly deep analysis cron (default: 0 2 * * 0)
  monthlyCron: string;     // Monthly MEMORY.md pruning (default: 0 3 1 * *)
  lookbackDays: number;
  minPatternCount: number;
  similarityThreshold: number;
  mempalaceWing: string;
  mempalaceRoom: string;
  outputDir: string;
}

const DEFAULT_CONFIG: InsightsSchedulerConfig = {
  enabled: true,
  dailyCron: '0 6 * * *',
  weeklyCron: '0 2 * * 0',
  monthlyCron: '0 3 1 * *',
  lookbackDays: 7,
  minPatternCount: 3,
  similarityThreshold: 0.8,
  mempalaceWing: 'finger-evolution',
  mempalaceRoom: 'learnings',
  outputDir: path.join(FINGER_PATHS.home, 'data', 'insights'),
};

export interface InsightsGenerationResult {
  generatedAt: string;
  insightsPath: string;
  failurePatterns: number;
  successPatterns: number;
  recommendations: number;
  mempalaceSynced?: number;
  mempalaceFailed?: number;
}

export class InsightsScheduler {
  private config: InsightsSchedulerConfig;
  private engine: InsightsEngine;
  private lastDailyRun?: Date;
  private lastWeeklyRun?: Date;

  constructor(config?: Partial<InsightsSchedulerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.engine = new InsightsEngine({
      ledgerPath: '', // Will be resolved at runtime
      lookbackDays: this.config.lookbackDays,
      minPatternCount: this.config.minPatternCount,
      similarityThreshold: this.config.similarityThreshold,
    });
    ensureDir(this.config.outputDir);
  }

  /**
   * Generate daily insights report
   * Called by clock/cron scheduler at dailyCron time
   */
  async generateDailyInsights(
    ledgerPath: string,
    days?: number
  ): Promise<InsightsGenerationResult> {
    log.info('[InsightsScheduler] Starting daily insights generation');

    // Update engine config with resolved ledger path
    this.engine = new InsightsEngine({
      ledgerPath,
      lookbackDays: days ?? this.config.lookbackDays,
      minPatternCount: this.config.minPatternCount,
      similarityThreshold: this.config.similarityThreshold,
    });

    const insights = await this.engine.analyze(days);
    const dateStr = new Date().toISOString().split('T')[0];
    const insightsPath = path.join(this.config.outputDir, 'daily-' + dateStr + '.md');

    // Format and save report
    const report = formatInsightsReport(insights);
    const fs = await import('node:fs/promises');
    await fs.writeFile(insightsPath, report, 'utf-8');

    // Sync learnings to mempalace (if available)
    let mempalaceSynced = 0;
    let mempalaceFailed = 0;
    if (isMempalaceAvailable()) {
      // Extract learnings from recent reasoning.stop events
      const cutoff = new Date(Date.now() - (days ?? this.config.lookbackDays) * 24 * 60 * 60 * 1000);
      const events = await this.engine.readLedgerEvents(cutoff);
      const learnings = this.engine.extractLearnings(events, cutoff);
      
      if (learnings.length > 0) {
        const syncResult = await syncLearningsBatch(
          learnings.slice(0, 50), // Limit to recent 50 learnings per day
          this.config.mempalaceWing,
          this.config.mempalaceRoom
        );
        mempalaceSynced = syncResult.synced;
        mempalaceFailed = syncResult.failed;
      }
    }

    this.lastDailyRun = new Date();

    log.info('[InsightsScheduler] Daily insights generated: ' + insightsPath);

    return {
      generatedAt: new Date().toISOString(),
      insightsPath,
      failurePatterns: insights.failurePatterns.length,
      successPatterns: insights.successPatterns.length,
      recommendations: insights.recommendations.length,
      mempalaceSynced,
      mempalaceFailed,
    };
  }

  /**
   * Generate weekly deep insights with extended analysis
   */
  async generateWeeklyInsights(
    ledgerPath: string
  ): Promise<InsightsGenerationResult> {
    log.info('[InsightsScheduler] Starting weekly deep insights generation');

    const result = await this.generateDailyInsights(ledgerPath, 30); // 30-day lookback

    // Rename to weekly report
    const dateStr = new Date().toISOString().split('T')[0];
    const weeklyPath = path.join(this.config.outputDir, 'weekly-' + dateStr + '.md');

    const fs = await import('node:fs/promises');
    await fs.rename(result.insightsPath, weeklyPath);

    this.lastWeeklyRun = new Date();

    log.info('[InsightsScheduler] Weekly insights generated: ' + weeklyPath);

    return {
      ...result,
      insightsPath: weeklyPath,
    };
  }

  /**
   * Get last run timestamps
   */
  getLastRuns(): { daily?: Date; weekly?: Date } {
    return {
      daily: this.lastDailyRun,
      weekly: this.lastWeeklyRun,
    };
  }

  /**
   * Check if should run daily (based on cron schedule)
   */
  shouldRunDaily(): boolean {
    if (!this.config.enabled) return false;
    if (!this.lastDailyRun) return true;
    
    const now = new Date();
    const hoursSinceLast = (now.getTime() - this.lastDailyRun.getTime()) / (1000 * 60 * 60);
    return hoursSinceLast >= 24;
  }

  /**
   * Get scheduler cron expressions for clock registration
   */
  getCronExpressions(): { daily: string; weekly: string; monthly: string } {
    return {
      daily: this.config.dailyCron,
      weekly: this.config.weeklyCron,
      monthly: this.config.monthlyCron,
    };
  }
}

/**
 * Create InsightsScheduler from environment config
 */
export function createInsightsSchedulerFromEnv(
  overrides?: Partial<InsightsSchedulerConfig>
): InsightsScheduler {
  const enabled = process.env.FINGER_INSIGHTS_ENABLED !== 'false';
  const dailyCron = process.env.FINGER_INSIGHTS_DAILY_CRON || DEFAULT_CONFIG.dailyCron;
  const weeklyCron = process.env.FINGER_INSIGHTS_WEEKLY_CRON || DEFAULT_CONFIG.weeklyCron;
  const lookbackDays = parseInt(process.env.FINGER_INSIGHTS_LOOKBACK_DAYS || '7', 10);

  return new InsightsScheduler({
    enabled,
    dailyCron,
    weeklyCron,
    lookbackDays,
    ...overrides,
  });
}
