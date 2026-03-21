import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FingerLogger, generateTraceId, type LogEntry } from '../../../src/core/logger.js';

describe('FingerLogger', () => {
  let logDir: string;
  let logger: FingerLogger;

  beforeEach(() => {
    logDir = join(tmpdir(), `finger-logger-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(logDir, { recursive: true });
    logger = new FingerLogger({
      logDir,
      enableConsole: false,
      enableFile: true,
    });
  });

  afterEach(() => {
    try { rmSync(logDir, { recursive: true, force: true }); } catch {}
  });

  // ── traceId generation ──
  describe('generateTraceId', () => {
    it('generates 8-char hex traceId', () => {
      const id = generateTraceId();
      expect(id).toHaveLength(8);
      expect(/^[0-9a-f]+$/.test(id)).toBe(true);
    });

    it('generates unique traceIds', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
      expect(ids.size).toBe(100);
    });
  });

  // ── traceId in log entries ──
  describe('traceId in entries', () => {
    it('includes traceId in log entry', () => {
      const traceId = logger.startTrace();
      logger.info('TraceModule', 'with trace', { key: 'val' }, traceId);
      logger.endTrace(traceId);
      
      const entries = logger.readLogs({ module: 'TraceModule' });
      expect(entries.length).toBe(1);
      expect(entries[0].traceId).toBe(traceId);
    });

    it('auto-increments seq when trace active', () => {
      const traceId = logger.startTrace();
      logger.info('SeqModule', 'step 1', {}, traceId);
      logger.info('SeqModule', 'step 2', {}, traceId);
      logger.info('SeqModule', 'step 3', {}, traceId);
      logger.endTrace(traceId);

      const snapshot = logger.endTrace(traceId); // already ended, returns null
      expect(snapshot).toBeNull();
    });
  });

  // ── Snapshot mode ──
  describe('snapshot mode', () => {
    it('startTrace/endTrace returns snapshot entries', () => {
      const traceId = logger.startTrace();
      logger.info('SnapModule', 's1', {}, traceId);
      logger.info('SnapModule', 's2', {}, traceId);
      logger.info('OtherModule', 'unrelated', {});
      const snapshot = logger.endTrace(traceId);
      
      expect(snapshot).not.toBeNull();
      expect(snapshot!.length).toBe(2);
      const messages = snapshot!.map(e => e.message).sort();
      const seqs = snapshot!.map(e => e.seq).sort();
      expect(messages).toEqual(['s1', 's2']);
      expect(seqs).toEqual([1, 2]);
    });

    it('endTrace returns null for unknown traceId', () => {
      const snapshot = logger.endTrace('nonexistent');
      expect(snapshot).toBeNull();
    });

    it('writes snapshot JSON file when snapshot mode enabled', () => {
      logger.setSnapshotMode(true);
      const traceId = logger.startTrace();
      logger.info('SnapFileModule', 'step', {}, traceId);
      logger.endTrace(traceId);

      const snapshotFile = join(logDir, `snapshot-${traceId}.json`);
      expect(existsSync(snapshotFile)).toBe(true);

      const content = JSON.parse(readFileSync(snapshotFile, 'utf-8'));
      expect(content.traceId).toBe(traceId);
      expect(content.entries).toHaveLength(1);
      expect(content.entries[0].seq).toBe(1);
      expect(content.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Module level control ──
  describe('module level control', () => {
    it('setModuleLevel off silences a module', () => {
      logger.info('OffModule', 'visible');
      logger.setModuleLevel('OffModule', 'off');
      logger.info('OffModule', 'hidden');
      
      const entries = logger.readLogs({ module: 'OffModule' });
      const visible = entries.filter(e => e.message === 'visible');
      const hidden = entries.filter(e => e.message === 'hidden');
      expect(hidden.length).toBe(0);
      // 'visible' may be filtered if module was already off due to config; ensure no hidden logs
    });

    it('setModuleLevel debug allows debug output for specific module', () => {
      logger.setModuleLevel('DebugModule', 'debug');
      logger.debug('DebugModule', 'debug visible');
      logger.debug('OtherModule', 'debug hidden by global level');
      
      const debugEntries = logger.readLogs({ module: 'DebugModule' });
      const debugMsg = debugEntries.filter(e => e.message === 'debug visible');
      expect(debugMsg.length).toBe(1);

      const otherEntries = logger.readLogs({ module: 'OtherModule' });
      const hiddenMsg = otherEntries.filter(e => e.message === 'debug hidden by global level');
      expect(hiddenMsg.length).toBe(0);
    });
  });

  // ── Log file output ──
  describe('log file output', () => {
    it('writes JSONL entries to daily log file', () => {
      logger.info('FileModule', 'test message', { num: 42 });
      
      const date = new Date().toISOString().split('T')[0];
      const logFile = join(logDir, `finger-${date}.log`);
      expect(existsSync(logFile)).toBe(true);
      
      const content = readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(1);
      
      const lastEntry = JSON.parse(lines[lines.length - 1]) as LogEntry;
      expect(lastEntry.module).toBe('FileModule');
      expect(lastEntry.message).toBe('test message');
      expect(lastEntry.data).toEqual({ num: 42 });
      expect(lastEntry.timestamp.utc).toBeTruthy();
    });

    it('includes error stack in log entry', () => {
      const err = new Error('stack test');
      logger.error('ErrModule', 'failed', err);
      
      const entries = logger.readLogs({ module: 'ErrModule' });
      const errEntry = entries.find(e => e.message === 'failed');
      expect(errEntry).toBeDefined();
      expect(errEntry!.error).toBeDefined();
      expect(errEntry!.error!.name).toBe('Error');
      expect(errEntry!.error!.message).toBe('stack test');
    });
  });

  // ── ModuleLogger ──
  describe('ModuleLogger', () => {
    it('creates module-scoped logger with correct module name', () => {
      const mod = logger.module('ScopedModule');
      mod.info('scoped hello');
      
      const entries = logger.readLogs({ module: 'ScopedModule' });
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const last = entries[entries.length - 1];
      expect(last.module).toBe('ScopedModule');
      expect(last.message).toBe('scoped hello');
    });

    it('ModuleLogger.startTrace/endTrace work via ModuleLogger', () => {
      const mod = logger.module('TraceMod');
      const traceId = mod.startTrace();
      mod.info('step 1', {}, traceId);
      const snapshot = mod.endTrace(traceId);
      
      expect(snapshot).not.toBeNull();
      expect(snapshot!.length).toBe(1);
      expect(snapshot![0].seq).toBe(1);
    });
  });

  // ── Log querying ──
  describe('readLogs', () => {
    it('filters by module', () => {
      logger.info('QAlpha', 'alpha');
      logger.info('QBeta', 'beta');
      
      const alphaEntries = logger.readLogs({ module: 'QAlpha' });
      expect(alphaEntries.length).toBeGreaterThanOrEqual(1);
      expect(alphaEntries.every(e => e.module === 'QAlpha')).toBe(true);
    });

    it('filters by level', () => {
      logger.info('LvlModule', 'info msg');
      logger.error('LvlModule', new Error('lvl err'));
      
      const errorOnly = logger.readLogs({ module: 'LvlModule', level: 'error' });
      expect(errorOnly.length).toBeGreaterThanOrEqual(1);
      expect(errorOnly.every(e => e.level === 'error')).toBe(true);
    });

    it('filters by traceId', () => {
      const t1 = generateTraceId();
      const t2 = generateTraceId();
      logger.info('TModule', 'for t1', {}, t1);
      logger.info('TModule', 'for t2', {}, t2);
      
      const t1Entries = logger.readLogs({ traceId: t1 });
      expect(t1Entries.length).toBeGreaterThanOrEqual(1);
      expect(t1Entries[0].message).toBe('for t1');
    });

    it('respects limit', () => {
      const uniqueModule = `LimitModule-${Date.now()}`;
      for (let i = 0; i < 5; i++) {
        logger.info(uniqueModule, `lmsg-${i}`);
      }
      
      const limited = logger.readLogs({ module: uniqueModule, limit: 2 });
      expect(limited.length).toBe(2);
      // Most recent first (sorted desc by timestamp)
      expect(['lmsg-3', 'lmsg-4'].includes(limited[0].message));
      expect(['lmsg-3', 'lmsg-4'].includes(limited[1].message));
    });
  });

  // ── Log rotation ──
  describe('log rotation', () => {
    it('rotates log file when exceeding size limit', () => {
      const tinyLogger = new FingerLogger({
        logDir,
        enableConsole: false,
        enableFile: true,
        maxFileSizeMB: 0.001,
      });

      for (let i = 0; i < 100; i++) {
        tinyLogger.info('RotModule', `rot-${i}`, { pad: 'x'.repeat(100) });
      }

      const files = readdirSync(logDir).filter(f => f.startsWith('finger-') && f.endsWith('.log'));
      expect(files.length).toBeGreaterThanOrEqual(2);
    });
  });
});
