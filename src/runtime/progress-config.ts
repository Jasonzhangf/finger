import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { FINGER_HOME } from '../core/finger-paths.js';
import type { ProgressConfig, ProgressDisplayConfig } from './progress-types.js';

const DEFAULT_CONFIG: ProgressConfig = {
  updateIntervalMinutes: 1,
  display: { contextUsage: true, toolCalls: true, teamStatus: true, mailboxStatus: true, recentRounds: true, internalState: true, externalState: true, stuckWarning: true },
  truncation: { maxToolCallChars: 60, maxRecentRounds: 5, maxTurnSummaryChars: 100 },
  stuckThresholdMinutes: 8,
};

const CONFIG_PATH = join(FINGER_HOME, 'config', 'progress-config.json');

export function getProgressConfig(): ProgressConfig {
  try {
    if (!existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(content) as Partial<ProgressConfig>;
    return { ...DEFAULT_CONFIG, ...config, display: { ...DEFAULT_CONFIG.display, ...config.display }, truncation: { ...DEFAULT_CONFIG.truncation, ...config.truncation } };
  } catch { return DEFAULT_CONFIG; }
}

export function shouldDisplay(config: ProgressConfig, item: keyof ProgressDisplayConfig): boolean {
  return config.display[item] ?? true;
}
