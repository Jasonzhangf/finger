/**
 * Progress Monitor 配置读取
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { FINGER_HOME } from '../../../core/finger-paths.js';
import type { ProgressConfig } from './progress-types.js';

const DEFAULT_CONFIG: ProgressConfig = {
  updateIntervalMinutes: 1,
  display: {
    contextUsage: true,
    contextBreakdown: 'summary',
    toolCalls: 'summary',
    teamStatus: true,
    mailboxStatus: true,
    sessionInfo: true,
    reasoning: false,
    controlTags: false,
  },
  breakdownMode: 'release',
  truncation: {
    maxToolCallChars: 60,
    maxRecentRounds: 5,
    maxTeamMembers: 10,
  },
};

const CONFIG_PATH = join(FINGER_HOME, 'config', 'progress-config.json');

let cachedConfig: ProgressConfig | null = null;

export function loadProgressConfig(): ProgressConfig {
  if (cachedConfig) {
    return cachedConfig;
  }
  
  if (!existsSync(CONFIG_PATH)) {
    cachedConfig = DEFAULT_CONFIG;
    return DEFAULT_CONFIG;
  }
  
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    
    // 合并默认配置（确保所有字段都有值）
    cachedConfig = {
      updateIntervalMinutes: parsed.updateIntervalMinutes ?? DEFAULT_CONFIG.updateIntervalMinutes,
      display: {
        contextUsage: parsed.display?.contextUsage ?? DEFAULT_CONFIG.display.contextUsage,
        contextBreakdown: parsed.display?.contextBreakdown ?? DEFAULT_CONFIG.display.contextBreakdown,
        toolCalls: parsed.display?.toolCalls ?? DEFAULT_CONFIG.display.toolCalls,
        teamStatus: parsed.display?.teamStatus ?? DEFAULT_CONFIG.display.teamStatus,
        mailboxStatus: parsed.display?.mailboxStatus ?? DEFAULT_CONFIG.display.mailboxStatus,
        sessionInfo: parsed.display?.sessionInfo ?? DEFAULT_CONFIG.display.sessionInfo,
        reasoning: parsed.display?.reasoning ?? DEFAULT_CONFIG.display.reasoning,
        controlTags: parsed.display?.controlTags ?? DEFAULT_CONFIG.display.controlTags,
      },
      breakdownMode: parsed.breakdownMode ?? DEFAULT_CONFIG.breakdownMode,
      truncation: {
        maxToolCallChars: parsed.truncation?.maxToolCallChars ?? DEFAULT_CONFIG.truncation.maxToolCallChars,
        maxRecentRounds: parsed.truncation?.maxRecentRounds ?? DEFAULT_CONFIG.truncation.maxRecentRounds,
        maxTeamMembers: parsed.truncation?.maxTeamMembers ?? DEFAULT_CONFIG.truncation.maxTeamMembers,
      },
    };
    
    return cachedConfig;
  } catch (error) {
    console.warn('[ProgressConfig] Failed to load config, using defaults:', error);
    cachedConfig = DEFAULT_CONFIG;
    return DEFAULT_CONFIG;
  }
}

export function getUpdateIntervalMs(): number {
  const config = loadProgressConfig();
  return config.updateIntervalMinutes * 60 * 1000;
}

export function shouldDisplayContextUsage(): boolean {
  return loadProgressConfig().display.contextUsage;
}

export function shouldDisplayTeamStatus(): boolean {
  return loadProgressConfig().display.teamStatus;
}

export function getBreakdownMode(): 'release' | 'dev' {
  return loadProgressConfig().breakdownMode;
}
