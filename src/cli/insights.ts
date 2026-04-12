#!/usr/bin/env node
/**
 * Finger Insights CLI - Insights Engine Command Interface
 * 
 * Usage: myfinger insights [options]
 * 
 * Options:
 *   --days <n>      Lookback days (default: 7)
 *   --output <fmt>  Output format: text|json (default: text)
 *   --ledger <path> Ledger JSONL path (optional)
 *   --save <path>   Save report to file (optional)
 *   --sync          Sync learnings to mempalace (if available)
 */

import { Command } from 'commander';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';
import { FINGER_PATHS } from '../core/finger-paths.js';
import { InsightsEngine, formatInsightsReport, formatInsightsJson } from '../evolution/insights/index.js';
import { syncLearningsBatch, isMempalaceAvailable } from '../evolution/insights/mempalace-bridge.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

const clog = createConsoleLikeLogger('InsightsCLI');

/**
 * Resolve default ledger path from FINGER_PATHS
 */
function resolveDefaultLedgerPath(): string {
  // Default ledger location: ~/.finger/data/ledger/ledger.jsonl
  const ledgerDir = join(FINGER_PATHS.home, 'data', 'ledger');
  const ledgerPath = join(ledgerDir, 'ledger.jsonl');
  if (existsSync(ledgerPath)) {
    return ledgerPath;
  }
  return '';
}

/**
 * Register the insights CLI command
 */
export function registerInsightsCommand(program: Command): void {
  program
    .command('insights')
    .description('Generate insights report from reasoning.stop learning data')
    .option('--days <n>', 'Lookback days', '7')
    .option('--output <fmt>', 'Output format: text|json', 'text')
    .option('--ledger <path>', 'Ledger JSONL path (optional)')
    .option('--save <path>', 'Save report to file (optional)')
    .option('--sync', 'Sync learnings to mempalace (if available)', false)
    .action(async (options) => {
      try {
        const days = parseInt(options.days, 10);
        if (days < 1 || days > 365) {
          clog.error('Invalid --days value: must be 1-365');
          process.exit(1);
        }

        const ledgerPath = options.ledger || resolveDefaultLedgerPath();
        if (!ledgerPath) {
          clog.error('No ledger path provided and default ledger not found');
          clog.log('Tip: specify --ledger <path> or ensure ~/.finger/data/ledger/ledger.jsonl exists');
          process.exit(1);
        }

        clog.log(`Analyzing ledger: ${ledgerPath}`);
        clog.log(`Lookback: ${days} days`);

        const engine = new InsightsEngine({
          ledgerPath,
          lookbackDays: days,
          minPatternCount: 3,
          similarityThreshold: 0.8,
        });

        const insights = await engine.analyze(days);

        // Format output
        let output: string;
        if (options.output === 'json') {
          const reportObj = formatInsightsJson(insights);
          output = JSON.stringify(reportObj, null, 2);
        } else {
          output = formatInsightsReport(insights);
        }

        // Save or print
        if (options.save) {
          await writeFile(options.save, output, 'utf-8');
          clog.log(`Report saved to: ${options.save}`);
        } else {
          clog.log(output);
        }

        // Sync to mempalace (optional)
        if (options.sync && isMempalaceAvailable()) {
          clog.log('Syncing learnings to mempalace...');
          const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
          const events = await engine.readLedgerEvents(cutoff);
          const learnings = engine.extractLearnings(events, cutoff);
          
          if (learnings.length > 0) {
            const result = await syncLearningsBatch(
              learnings.slice(0, 50),
              'finger-evolution',
              'learnings'
            );
            clog.log(`Mempalace sync: ${result.synced} synced, ${result.failed} failed`);
          } else {
            clog.log('No learnings to sync');
          }
        }

        // Summary stats
        clog.log('');
        clog.log(`Summary: ${insights.failurePatterns.length} failure patterns, ${insights.successPatterns.length} success patterns`);
        clog.log(`Recommendations: ${insights.recommendations.length}`);
        if (insights.costEstimation.anomaly) {
          clog.warn('Cost anomaly detected: total tokens exceed threshold');
        }

      } catch (error) {
        clog.error('[Insights CLI Error]', error);
        process.exit(1);
      }
    });
}

export default registerInsightsCommand;
