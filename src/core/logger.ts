/**
 * Finger Persistent Logger System
 * 
 * 特性：
 * - 文件输出：结构化 JSONL（每行一个 JSON 对象）
 * - 控制台输出：人类可读格式
 * - UTC/Local 双时间戳 + NTP 偏移
 * - 日志轮转（按大小/按天）
 */

import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, readdirSync, unlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { FINGER_PATHS } from './finger-paths.js';
import { ntpTime } from './ntp-time.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEntry {
  timestamp: {
    utc: string;
    local: string;
    tz: string;
    nowMs: number;
    ntpOffsetMs: number;
  };
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  traceId?: string;
}

export interface LoggerConfig {
  logDir: string;
  maxFileSizeMB: number;
  maxFiles: number;
  level: LogLevel;
  enableConsole: boolean;
  enableFile: boolean;
}

const DEFAULT_CONFIG: LoggerConfig = {
  logDir: FINGER_PATHS.logs.dir,
  maxFileSizeMB: 10,
  maxFiles: 30,
  level: 'info',
  enableConsole: true,
  enableFile: true,
};

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

const LEVEL_EMOJI: Record<LogLevel, string> = {
  debug: '🔍',
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
  fatal: '💥',
};

export class FingerLogger {
  private config: LoggerConfig;
  private currentLogFile: string;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    if (!existsSync(this.config.logDir)) {
      try {
        mkdirSync(this.config.logDir, { recursive: true });
      } catch {
        this.config.enableFile = false;
      }
    }
    
    this.currentLogFile = this.getLogFileName();
  }

  log(level: LogLevel, module: string, message: string, data?: Record<string, unknown>, error?: Error, traceId?: string): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.config.level]) {
      return;
    }

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

    // 文件输出：JSONL 格式
    if (this.config.enableFile) {
      this.logToFile(JSON.stringify(entry));
    }

    // 控制台输出：人类可读格式
    if (this.config.enableConsole) {
      this.logToConsole(entry);
    }
  }

  debug(module: string, message: string, data?: Record<string, unknown>): void {
    this.log('debug', module, message, data);
  }

  info(module: string, message: string, data?: Record<string, unknown>): void {
    this.log('info', module, message, data);
  }

  warn(module: string, message: string, data?: Record<string, unknown>): void {
    this.log('warn', module, message, data);
  }

  error(module: string, message: string, error?: Error, data?: Record<string, unknown>): void {
    this.log('error', module, message, data, error);
  }

  fatal(module: string, message: string, error?: Error, data?: Record<string, unknown>): void {
    this.log('fatal', module, message, data, error);
  }

  module(moduleName: string): ModuleLogger {
    return new ModuleLogger(this, moduleName);
  }

  readLogs(options: { 
    level?: LogLevel; 
    module?: string; 
    since?: Date; 
    limit?: number;
  } = {}): LogEntry[] {
    const files = this.getLogFiles();
    const entries: LogEntry[] = [];

    for (const file of files) {
      const content = this.readLogFile(file);
      const lines = content.split('\n').filter(Boolean);
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as LogEntry;
          
          if (options.level && LEVEL_PRIORITY[entry.level] < LEVEL_PRIORITY[options.level]) {
            continue;
          }
          if (options.module && entry.module !== options.module) {
            continue;
          }
          if (options.since && entry.timestamp.nowMs < options.since.getTime()) {
            continue;
          }
          
          entries.push(entry);
        } catch {
          // 跳过无效行
        }
      }
    }

    entries.sort((a, b) => b.timestamp.nowMs - a.timestamp.nowMs);
    
    if (options.limit) {
      return entries.slice(0, options.limit);
    }
    
    return entries;
  }

  cleanup(): void {
    const files = this.getLogFiles();
    
    if (files.length > this.config.maxFiles) {
      const toDelete = files.slice(0, files.length - this.config.maxFiles);
      for (const file of toDelete) {
        try {
          unlinkSync(file);
        } catch {
          // 忽略删除失败
        }
      }
    }
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
        
        if (sizeMB >= this.config.maxFileSizeMB) {
          this.rotateLog();
        }
      }

      appendFileSync(this.currentLogFile, line + '\n', 'utf-8');
    } catch (err) {
      console.error('Failed to write log file:', err);
    }
  }

  private rotateLog(): void {
    if (!existsSync(this.currentLogFile)) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedName = this.currentLogFile.replace('.log', `-${timestamp}.log`);
    
    try {
      renameSync(this.currentLogFile, rotatedName);
    } catch {
      // 忽略轮转失败
    }
  }

  private logToConsole(entry: LogEntry): void {
    const t = entry.timestamp;
    const ts = `[${t.utc} | ${t.local} | ${t.tz} | ${t.nowMs} | ${t.ntpOffsetMs}ms]`;
    const levelStr = `[${entry.level.toUpperCase()}]`;
    const moduleStr = `[${entry.module}]`;
    
    // 格式化：时间戳 级别 Emoji 模块 消息
    const colored = this.colorize(ts, entry.level);
    const emoji = LEVEL_EMOJI[entry.level];
    
    console.log(`${colored} ${emoji} ${levelStr} ${moduleStr} ${entry.message}`);
    
    if (entry.data && Object.keys(entry.data).length > 0) {
      console.log(`  → data: ${JSON.stringify(entry.data)}`);
    }
    
    if (entry.error) {
      console.log(`  → error: ${entry.error.name}: ${entry.error.message}`);
      if (entry.error.stack) {
        const stackLines = entry.error.stack.split('\n').slice(1, 4);
        stackLines.forEach(line => console.log(`    ${line.trim()}`));
      }
    }
  }

  private colorize(text: string, level: LogLevel): string {
    const colors: Record<LogLevel, string> = {
      debug: '\x1b[90m',   // gray
      info: '\x1b[32m',    // green
      warn: '\x1b[33m',    // yellow
      error: '\x1b[31m',   // red
      fatal: '\x1b[35m',   // magenta
    };
    const reset = '\x1b[0m';
    return `${colors[level]}${text}${reset}`;
  }

  private getLogFiles(): string[] {
    const files: string[] = [];
    
    try {
      const entries = readdirSync(this.config.logDir);
      for (const entry of entries) {
        if (entry.startsWith('finger-') && entry.endsWith('.log')) {
          files.push(join(this.config.logDir, entry));
        }
      }
    } catch {
      // 忽略读取失败
    }

    return files.sort();
  }

  private readLogFile(filePath: string): string {
    try {
      // readFileSync is already imported at top of file
      return readFileSync(filePath, 'utf-8');
    } catch {
      return '';
    }
  }
}

export class ModuleLogger {
  constructor(private logger: FingerLogger, private moduleName: string) {}

  debug(message: string, data?: Record<string, unknown>): void {
    this.logger.debug(this.moduleName, message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.logger.info(this.moduleName, message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.logger.warn(this.moduleName, message, data);
  }

  error(message: string, error?: Error, data?: Record<string, unknown>): void {
    this.logger.error(this.moduleName, message, error, data);
  }

  fatal(message: string, error?: Error, data?: Record<string, unknown>): void {
    this.logger.fatal(this.moduleName, message, error, data);
  }
}

export const logger = new FingerLogger();
