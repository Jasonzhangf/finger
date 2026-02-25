import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FingerLogger } from '../../../src/core/logger.js';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

describe('FingerLogger', () => {
  const testLogDir = join(process.cwd(), '.test-logs');
  let logger: FingerLogger;

  beforeEach(() => {
    // 清理并创建测试目录
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true });
    }
    mkdirSync(testLogDir, { recursive: true });
    
    logger = new FingerLogger({
      logDir: testLogDir,
      enableConsole: false,
      enableFile: true,
      level: 'debug',
    });
  });

  afterEach(() => {
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true });
    }
  });

  describe('timestamp', () => {
    it('should include UTC and local time with NTP offset', () => {
      logger.info('TestModule', 'Test message');
      
      const logs = logger.readLogs();
      expect(logs.length).toBeGreaterThan(0);
      
      const entry = logs[0];
      expect(entry.timestamp).toHaveProperty('utc');
      expect(entry.timestamp).toHaveProperty('local');
      expect(entry.timestamp).toHaveProperty('tz');
      expect(entry.timestamp).toHaveProperty('nowMs');
      expect(entry.timestamp).toHaveProperty('ntpOffsetMs');
      
      // UTC should be ISO format
      expect(entry.timestamp.utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('log levels', () => {
    it('should log all levels when level is debug', () => {
      logger.debug('Test', 'debug message');
      logger.info('Test', 'info message');
      logger.warn('Test', 'warn message');
      logger.error('Test', 'error message');
      
      const logs = logger.readLogs();
      expect(logs.filter(l => l.level === 'debug')).toHaveLength(1);
      expect(logs.filter(l => l.level === 'info')).toHaveLength(1);
      expect(logs.filter(l => l.level === 'warn')).toHaveLength(1);
      expect(logs.filter(l => l.level === 'error')).toHaveLength(1);
    });

    it('should filter logs by level', () => {
      logger = new FingerLogger({
        logDir: testLogDir,
        enableConsole: false,
        enableFile: true,
        level: 'warn',
      });

      logger.debug('Test', 'should be filtered');
      logger.info('Test', 'should be filtered');
      logger.warn('Test', 'should appear');
      logger.error('Test', 'should appear');

      const logs = logger.readLogs();
      expect(logs).toHaveLength(2);
      // Logs are sorted by nowMs descending (newest first), so order may vary
      expect(logs.map(l => l.level).sort()).toEqual(['error', 'warn']);
    });
  });

  describe('structured logging', () => {
    it('should log with data', () => {
      logger.info('TestModule', 'Message with data', { key: 'value', count: 42 });
      
      const logs = logger.readLogs();
      expect(logs[0].data).toEqual({ key: 'value', count: 42 });
    });

    it('should log with error', () => {
      const error = new Error('Test error');
      error.stack = 'Error: Test error\n  at Test.js:1:1';
      
      logger.error('TestModule', 'Error occurred', error);
      
      const logs = logger.readLogs();
      expect(logs[0].error).toBeDefined();
      expect(logs[0].error?.name).toBe('Error');
      expect(logs[0].error?.message).toBe('Test error');
    });
  });

  describe('module logger', () => {
    it('should create module logger with fixed module name', () => {
      const moduleLog = logger.module('FeishuAgent');
      
      moduleLog.info('Module message');
      moduleLog.warn('Module warning');
      
      const logs = logger.readLogs();
      expect(logs[0].module).toBe('FeishuAgent');
      expect(logs[1].module).toBe('FeishuAgent');
    });
  });

  describe('log reading', () => {
    it('should filter by module', () => {
      logger.info('ModuleA', 'message a');
      logger.info('ModuleB', 'message b');
      logger.info('ModuleA', 'message a2');
      
      const logs = logger.readLogs({ module: 'ModuleA' });
      expect(logs).toHaveLength(2);
    });

    it('should limit results', () => {
      for (let i = 0; i < 10; i++) {
        logger.info('Test', `message ${i}`);
      }
      
      const logs = logger.readLogs({ limit: 3 });
      expect(logs).toHaveLength(3);
    });
  });
});
