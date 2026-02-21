/**
 * Logger tests
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
 import logger from '../../../../src/agents/shared/logger.js';

describe('Logger', () => {
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    consoleSpy.log.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.error.mockRestore();
  });

  it('should log debug message', () => {
    logger.debug('test debug message');
    expect(consoleSpy.log).toHaveBeenCalled();
    const call = consoleSpy.log.mock.calls[0];
    expect(call[0]).toContain('[DEBUG]');
    expect(call[0]).toContain('test debug message');
  });

  it('should log debug with args', () => {
    logger.debug('test', { key: 'value' }, 123);
    expect(consoleSpy.log).toHaveBeenCalled();
  });

  it('should log info message', () => {
    logger.info('test info message');
    expect(consoleSpy.log).toHaveBeenCalled();
    const call = consoleSpy.log.mock.calls[0];
    expect(call[0]).toContain('[INFO]');
  });

  it('should log warn message', () => {
    logger.warn('test warn message');
    expect(consoleSpy.warn).toHaveBeenCalled();
    const call = consoleSpy.warn.mock.calls[0];
    expect(call[0]).toContain('[WARN]');
  });

  it('should log error message', () => {
    logger.error('test error message');
    expect(consoleSpy.error).toHaveBeenCalled();
    const call = consoleSpy.error.mock.calls[0];
    expect(call[0]).toContain('[ERROR]');
  });

  it('should include timestamp', () => {
    logger.info('timestamp test');
    const call = consoleSpy.log.mock.calls[0];
    // ISO format: 2024-01-01T12:00:00.000Z
    expect(call[0]).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
  });
});
