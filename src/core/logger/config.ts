import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { FINGER_PATHS } from '../finger-paths.js';
import type { LoggerConfig, ModuleLoggingConfig } from './types.js';

export const DEFAULT_CONFIG: LoggerConfig = {
  logDir: FINGER_PATHS.logs.dir,
  maxFileSizeMB: 10,
  maxFiles: 30,
  level: 'info',
  enableConsole: true,
  enableFile: true,
};

export const DEFAULT_MODULE_CONFIG: ModuleLoggingConfig = {
  globalLevel: 'info',
  moduleLevels: {},
  snapshotMode: false,
  snapshotModules: [],
};

export function getLoggingConfigPath(configDir: string = FINGER_PATHS.config.dir): string {
  return join(configDir, 'logging.json');
}

export function loadModuleConfig(configPath: string): ModuleLoggingConfig {
  try {
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(content);
      return { ...DEFAULT_MODULE_CONFIG, ...parsed };
    }
  } catch {
    // ignore read errors
  }
  return { ...DEFAULT_MODULE_CONFIG };
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}
