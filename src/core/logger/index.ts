import { appendFileSync, existsSync, statSync, renameSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ntpTime } from '../ntp-time.js';
import { DEFAULT_CONFIG, DEFAULT_MODULE_CONFIG, getLoggingConfigPath, loadModuleConfig, ensureDir } from './config.js';
import { LEVEL_PRIORITY, LEVEL_EMOJI, generateTraceId, colorize, getLogFiles, readLogFile, parseLogEntries } from './utils.js';
import type { LogLevel, LogEntry, LoggerConfig, ModuleLoggingConfig, RequestContext } from './types.js';

export class FingerLogger {
  private config: LoggerConfig;
  private moduleConfig: ModuleLoggingConfig;
  private currentLogFile: string;
  private activeTraces: Map<string, RequestContext> = new Map();

  constructor(config: Partial<LoggerConfig> = {}, configPath?: string) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    ensureDir(this.config.logDir);

    const effectiveConfigPath = configPath ?? getLoggingConfigPath();
    this.moduleConfig = loadModuleConfig(effectiveConfigPath);

    this.currentLogFile = this.getLogFileName();
  }

  module(moduleName: string): ModuleLogger {
    return new ModuleLogger(this, moduleName);
  }

  startTrace(): string {
    const traceId = generateTraceId();
    this.activeTraces.set(traceId, {
      traceId,
      seq: 0,
      startTime: Date.now(),
      entries: [],
    });
    return traceId;
  }

  endTrace(traceId: string): LogEntry[] | null {
    const ctx = this.activeTraces.get(traceId);
    if (!ctx) return null;
    this.activeTraces.delete(traceId);

    // Use in-memory trace entries directly instead of re-reading from disk.
    // The previous readLogs({ traceId }) was O(total log size) and caused
    // massive IO amplification under high-frequency dispatch retries.
    const entries = ctx.entries.length > 0
      ? [...ctx.entries]
      : [];

    // Snapshot mode: only write when there's meaningful content.
    // Empty snapshots provide zero diagnostic value but consume IO/inodes.
    if (this.moduleConfig.snapshotMode && entries.length > 0) {
      this.writeSnapshot({ ...ctx, entries });
    }

    return entries;
  }

  log(
    level: Exclude<LogLevel, 'off'>,
    module: string,
    message: string,
    data?: Record<string, unknown>,
    error?: Error,
    traceId?: string
  ): void {
    if (this.isModuleOff(module)) return;
    const effectiveLevel = this.getEffectiveLevel(module);
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[effectiveLevel]) return;

    const entry: LogEntry = {
      timestamp: ntpTime.getCorrectedTime(),
      level,
      module,
      message,
      data,
      traceId,
    };

    if (error) {
      entry.error = {
        name: error.name,
        message: error.message,
        stack: error.stack,
      };
    }

    if (traceId) {
      const ctx = this.activeTraces.get(traceId);
      if (ctx) {
        entry.seq = ++ctx.seq;
        ctx.entries.push(entry);
      }
    }

    if (this.config.enableFile) {
      this.logToFile(JSON.stringify(entry));
    }

    if (this.config.enableConsole) {
      this.logToConsole(entry);
    }
  }

  debug(module: string, message: string, data?: Record<string, unknown>, traceId?: string): void {
    this.log('debug', module, message, data, undefined, traceId);
  }

  info(module: string, message: string, data?: Record<string, unknown>, traceId?: string): void {
    this.log('info', module, message, data, undefined, traceId);
  }

  warn(module: string, message: string, data?: Record<string, unknown>, traceId?: string): void {
    this.log('warn', module, message, data, undefined, traceId);
  }

  error(module: string, message: string, error?: Error, data?: Record<string, unknown>, traceId?: string): void {
    this.log('error', module, message, data, error, traceId);
  }

  fatal(module: string, message: string, error?: Error, data?: Record<string, unknown>, traceId?: string): void {
    this.log('fatal', module, message, data, error, traceId);
  }

  setModuleLevel(module: string, level: LogLevel): void {
    this.moduleConfig.moduleLevels[module] = level;
  }

  setSnapshotMode(enabled: boolean, modules: string[] = []): void {
    this.moduleConfig.snapshotMode = enabled;
    this.moduleConfig.snapshotModules = modules;
  }

  readLogs(options: { 
    level?: Exclude<LogLevel, 'off'>; 
    module?: string; 
    since?: Date; 
    traceId?: string;
    limit?: number;
  } = {}): LogEntry[] {
    const files = getLogFiles(this.config.logDir);
    const entries: LogEntry[] = [];

    for (const file of files) {
      const content = readLogFile(file);
      const fileEntries = parseLogEntries(content);
      for (const entry of fileEntries) {
        if (options.level && LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[options.level]) continue;
        if (options.module && entry.module !== options.module) continue;
        if (options.traceId && entry.traceId !== options.traceId) continue;
        if (options.since && entry.timestamp.nowMs < options.since.getTime()) continue;
        entries.push(entry);
      }
    }

    entries.sort((a, b) => b.timestamp.nowMs - a.timestamp.nowMs);
    if (options.limit) return entries.slice(0, options.limit);
    return entries;
  }

  cleanup(): void {
    const files = getLogFiles(this.config.logDir);
    if (files.length > this.config.maxFiles) {
      const toDelete = files.slice(0, files.length - this.config.maxFiles);
      for (const file of toDelete) {
        try {
          unlinkSync(file);
        } catch (err) {
          console.error('[Logger] Failed to delete old log file:', file, err);
        }
      }
    }
  }

  private isModuleOff(module: string): boolean {
    return this.moduleConfig.moduleLevels[module] === 'off';
  }

  private getEffectiveLevel(module: string): Exclude<LogLevel, 'off'> {
    const moduleLevel = this.moduleConfig.moduleLevels[module];
    if (moduleLevel && moduleLevel !== 'off') return moduleLevel;
    return this.moduleConfig.globalLevel;
  }

  private getLogFileName(): string {
    const date = new Date().toISOString().split('T')[0];
    return join(this.config.logDir, `finger-${date}.log`);
  }

  private logToFile(line: string): void {
    try {
      const todayFile = this.getLogFileName();
      if (todayFile !== this.currentLogFile) {
        this.currentLogFile = todayFile;
        this.cleanup();
      }

      if (existsSync(this.currentLogFile)) {
        const stats = statSync(this.currentLogFile);
        const sizeMB = stats.size / (1024 * 1024);
        if (sizeMB >= this.config.maxFileSizeMB) this.rotateLog();
      }

      appendFileSync(this.currentLogFile, line + '\n', 'utf-8');
    } catch (err) {
      console.error('Failed to write log file:', err);
    }
  }

  private writeSnapshot(ctx: RequestContext): void {
    const snapshotFile = join(this.config.logDir, `snapshot-${ctx.traceId}.json`);
    try {
      const snapshot = {
        traceId: ctx.traceId,
        startTime: ctx.startTime,
        endTime: Date.now(),
        durationMs: Date.now() - ctx.startTime,
        entries: ctx.entries,
      };
      writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Logger] Failed to write snapshot file:', snapshotFile, err);
    }
  }

  private rotateLog(): void {
    if (!existsSync(this.currentLogFile)) return;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedName = this.currentLogFile.replace('.log', `-${timestamp}.log`);
    try {
      renameSync(this.currentLogFile, rotatedName);
    } catch (err) {
      console.error('[Logger] Failed to rotate log file:', this.currentLogFile, err);
    }
  }

  private logToConsole(entry: LogEntry): void {
    const t = entry.timestamp;
    const ts = `[${t.utc} | ${t.local} | ${t.tz} | ${t.nowMs}ms]`;
    const levelStr = `[${entry.level.toUpperCase()}]`;
    const moduleStr = `[${entry.module}]`;
    const traceStr = entry.traceId ? `[${entry.traceId}]` : '';
    const seqStr = entry.seq !== undefined ? `#${entry.seq}` : '';
    const colored = colorize(ts, entry.level);
    const emoji = LEVEL_EMOJI[entry.level];

    console.log(`${colored} ${emoji} ${levelStr} ${moduleStr} ${traceStr}${seqStr} ${entry.message}`);
    if (entry.data && Object.keys(entry.data).length > 0) console.log(`  → data: ${JSON.stringify(entry.data)}`);
    if (entry.error) {
      console.log(`  → error: ${entry.error.name}: ${entry.error.message}`);
      if (entry.error.stack) entry.error.stack.split('\n').slice(1, 4).forEach(line => console.log(`    ${line.trim()}`));
    }
  }
}

export class ModuleLogger {
  constructor(private logger: FingerLogger, private moduleName: string) {}
  debug(message: string, data?: Record<string, unknown>, traceId?: string): void {
    this.logger.debug(this.moduleName, message, data, traceId);
  }
  info(message: string, data?: Record<string, unknown>, traceId?: string): void {
    this.logger.info(this.moduleName, message, data, traceId);
  }
  warn(message: string, data?: Record<string, unknown>, traceId?: string): void {
    this.logger.warn(this.moduleName, message, data, traceId);
  }
  error(message: string, error?: Error, data?: Record<string, unknown>, traceId?: string): void {
    this.logger.error(this.moduleName, message, error, data, traceId);
  }
  fatal(message: string, error?: Error, data?: Record<string, unknown>, traceId?: string): void {
    this.logger.fatal(this.moduleName, message, error, data, traceId);
  }
  startTrace(): string { return this.logger.startTrace(); }
  endTrace(traceId: string): LogEntry[] | null { return this.logger.endTrace(traceId); }
}

export const logger = new FingerLogger();
export { generateTraceId } from './utils.js';
export type { LogLevel, LogEntry, LoggerConfig, ModuleLoggingConfig } from './types.js';
