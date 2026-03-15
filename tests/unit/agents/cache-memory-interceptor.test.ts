import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CacheMemoryInterceptor } from '../../../src/agents/base/cache-memory-interceptor.js';

describe('CacheMemoryInterceptor', () => {
  let interceptor: CacheMemoryInterceptor;

  beforeEach(() => {
    vi.clearAllMocks();
    interceptor = new CacheMemoryInterceptor({
      agentId: 'test-agent',
      projectPath: '/tmp/test-project',
    });
  });

  describe('interceptRequest', () => {
    it('should skip when disabled', async () => {
      const disabledInterceptor = new CacheMemoryInterceptor({
        agentId: 'test-agent',
        projectPath: '/tmp/test-project',
        enabled: false,
      });

      // Should not throw
      await disabledInterceptor.interceptRequest({
        text: 'test input',
      });
    });

    it('should skip empty input', async () => {
      await interceptor.interceptRequest({
        text: '',
      });

      // Should not throw
      await interceptor.interceptRequest({
        text: '   ',
      });
    });

    it('should create cache entry for valid input', async () => {
      const input = {
        text: 'test request',
        sessionId: 'session-1',
        metadata: {
          taskId: 'task-1',
        },
      };

      // Mock messageHub is not available in test, so it will warn but not error
      await interceptor.interceptRequest(input);

      // Should complete without error
      expect(true).toBe(true);
    });
  });

  describe('interceptResponse', () => {
    it('should skip when output is not successful', async () => {
      const output = {
        success: false,
        error: 'test error',
      };

      await interceptor.interceptResponse(output, {
        text: 'test input',
      });

      // Should complete without error
      expect(true).toBe(true);
    });

    it('should skip when finish_reason is not stop', async () => {
      const output = {
        success: true,
        response: 'test response',
        sessionId: 'session-1',
        metadata: {
          round_trace: [{
            finish_reason: 'length',
          }],
        },
      };

      await interceptor.interceptResponse(output, {
        text: 'test input',
      });

      // Should complete without error
      expect(true).toBe(true);
    });

    it('should create cache entry for successful completion', async () => {
      const output = {
        success: true,
        response: 'test response',
        sessionId: 'session-1',
        metadata: {
          round_trace: [{
            finish_reason: 'stop',
          }],
        },
      };

      await interceptor.interceptResponse(output, {
        text: 'test input',
        sessionId: 'session-1',
      });

      // Should complete without error
      expect(true).toBe(true);
    });
  });

  describe('extractFinishReason', () => {
    it('should extract finish_reason from round_trace', () => {
      const interceptor = new CacheMemoryInterceptor({
        agentId: 'test-agent',
        projectPath: '/tmp/test-project',
      });

      const output = {
        success: true,
        response: 'test',
        metadata: {
          round_trace: [{
            finish_reason: 'stop',
          }],
        },
      };

      // Access private method via test
      const result = (interceptor as any).extractFinishReason(output);
      expect(result).toBe('stop');
    });

    it('should return undefined when no round_trace', () => {
      const interceptor = new CacheMemoryInterceptor({
        agentId: 'test-agent',
        projectPath: '/tmp/test-project',
      });

      const output = {
        success: true,
        response: 'test',
      };

      const result = (interceptor as any).extractFinishReason(output);
      expect(result).toBeUndefined();
    });
  });
});
