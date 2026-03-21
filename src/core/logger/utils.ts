import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { LogEntry, LogLevel } from './types.js';

export const LEVEL_PRIORITY: Record<Exclude<LogLevel, 'off'>, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

export const LEVEL_EMOJI: Record<Exclude<LogLevel, 'off'>, string> = {
  debug: '🔍',
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
  fatal: '💥',
};

export function generateTraceId(): string {
  const chars = '0123456789abcdef';
  const arr = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, b => chars[b % 16]).join('');
}

export function colorize(text: string, level: Exclude<LogLevel, 'off'>): string {
  const colors: Record<Exclude<LogLevel, 'off'>, string> = {
    debug: '\x1b[90m',
    info: '\x1b[32m',
    warn: '\x1b[33m',
    error: '\x1b[31m',
    fatal: '\x1b[35m',
  };
  const reset = '\x1b[0m';
  return `${colors[level]}${text}${reset}`;
}

export function getLogFiles(logDir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(logDir);
    for (const entry of entries) {
      if (entry.startsWith('finger-') && entry.endsWith('.log')) {
        files.push(join(logDir, entry));
      }
    }
  } catch {
    // ignore read errors
  }
  return files.sort();
}

export function readLogFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

export function parseLogEntries(content: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = content.split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as LogEntry;
      entries.push(entry);
    } catch {
      // ignore invalid lines
    }
  }
  return entries;
}
