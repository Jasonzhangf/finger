import { promises as fs } from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { logger } from '../../core/logger.js';
import type { ProgressMonitorConfig } from './progress-monitor-types.js';

const log = logger.module('ProgressMonitor');

const CONFIG_PATH = path.join(FINGER_PATHS.config.dir, 'progress-monitor.json');

export const DEFAULT_PROGRESS_MONITOR_CONFIG: Required<ProgressMonitorConfig> = {
  intervalMs: 60_000,
  enabled: true,
  progressUpdates: true,
};

export async function loadProgressMonitorConfig(): Promise<Required<ProgressMonitorConfig>> {
  try {
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    const exists = await fs.access(CONFIG_PATH).then(() => true).catch(() => false);
    if (!exists) {
      await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_PROGRESS_MONITOR_CONFIG, null, 2), 'utf-8');
      return { ...DEFAULT_PROGRESS_MONITOR_CONFIG };
    }
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as ProgressMonitorConfig;
    return {
      intervalMs: parsed.intervalMs ?? DEFAULT_PROGRESS_MONITOR_CONFIG.intervalMs,
      enabled: parsed.enabled ?? DEFAULT_PROGRESS_MONITOR_CONFIG.enabled,
      progressUpdates: parsed.progressUpdates ?? DEFAULT_PROGRESS_MONITOR_CONFIG.progressUpdates,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('[ProgressMonitor] Failed to load config, using default', { message });
    return { ...DEFAULT_PROGRESS_MONITOR_CONFIG };
  }
}
