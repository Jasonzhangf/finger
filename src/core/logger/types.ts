export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'off';

export interface LogEntry {
  timestamp: {
    utc: string;
    local: string;
    tz: string;
    nowMs: number;
    ntpOffsetMs: number;
  };
  level: Exclude<LogLevel, 'off'>;
  module: string;
  message: string;
  data?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  traceId?: string;
  seq?: number;
}

export interface LoggerConfig {
  logDir: string;
  maxFileSizeMB: number;
  maxFiles: number;
  level: Exclude<LogLevel, 'off'>;
  enableConsole: boolean;
  enableFile: boolean;
}

export interface ModuleLoggingConfig {
  globalLevel: Exclude<LogLevel, 'off'>;
  moduleLevels: Record<string, LogLevel>;
  snapshotMode: boolean;
  snapshotModules: string[];
}

export interface RequestContext {
  traceId: string;
  seq: number;
  startTime: number;
  entries: LogEntry[];
}
