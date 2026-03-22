/**
 * Logger tests
 *
 * The shared logger is backed by FingerLogger via createConsoleLikeLogger.
 * All levels (debug/info/warn/error) emit through console.log (unified sink),
 * so we spy on console.log for all assertions.
 *
 * Note: Default log level is 'info', so debug messages are filtered out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import logger from '../../../../src/agents/shared/logger.js';

describe('Logger', () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLog.mockRestore();
  });

  it('should log info message via console.log', () => {
    logger.info('test info message');
    expect(consoleLog).toHaveBeenCalled();
    const call = consoleLog.mock.calls[0];
    expect(call[0]).toContain('[INFO]');
    expect(call[0]).toContain('[AgentsShared]');
    expect(call[0]).toContain('test info message');
  });

  it('should log info with args', () => {
    logger.info('test', { key: 'value' }, 123);
    expect(consoleLog).toHaveBeenCalled();
  });

  it('should log warn message via console.log (unified sink)', () => {
    logger.warn('test warn message');
    expect(consoleLog).toHaveBeenCalled();
    const call = consoleLog.mock.calls[0];
    expect(call[0]).toContain('[WARN]');
    expect(call[0]).toContain('[AgentsShared]');
  });

  it('should log error message via console.log (unified sink)', () => {
    logger.error('test error message');
    expect(consoleLog).toHaveBeenCalled();
    const call = consoleLog.mock.calls[0];
    expect(call[0]).toContain('[ERROR]');
    expect(call[0]).toContain('[AgentsShared]');
  });

  it('should include ISO timestamp', () => {
    logger.info('timestamp test');
    const call = consoleLog.mock.calls[0];
    expect(call[0]).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });
});
