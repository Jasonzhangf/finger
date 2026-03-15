import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CacheMemoryInterceptor } from '../../../src/agents/base/cache-memory-interceptor.js';

describe('CacheMemoryInterceptor messageHub integration', () => {
  let mockMessageHub: any;

  beforeEach(() => {
    mockMessageHub = {
      routeToOutput: vi.fn().mockResolvedValue({ ok: true }),
    };
  });

  it('should call messageHub routeToOutput for user request', async () => {
    const interceptor = new CacheMemoryInterceptor({
      agentId: 'test-agent',
      projectPath: '/tmp/test-project',
      messageHub: mockMessageHub,
    });

    await interceptor.interceptRequest({
      text: 'test user request',
      sessionId: 'session-1',
      metadata: { taskId: 'task-1' },
    });

    expect(mockMessageHub.routeToOutput).toHaveBeenCalledTimes(1);
    expect(mockMessageHub.routeToOutput).toHaveBeenCalledWith(
      'memory',
      expect.objectContaining({
        action: 'insert',
        target: 'cache',
        title: 'user: request',
      })
    );
  });

  it('should call messageHub routeToOutput for assistant response with finish_reason=stop', async () => {
    const interceptor = new CacheMemoryInterceptor({
      agentId: 'test-agent',
      projectPath: '/tmp/test-project',
      messageHub: mockMessageHub,
    });

    await interceptor.interceptResponse(
      {
        success: true,
        response: 'test response',
        sessionId: 'session-1',
        metadata: {
          round_trace: [
            { finish_reason: 'stop' },
          ],
        },
      },
      {
        text: 'test request',
        sessionId: 'session-1',
      }
    );

    expect(mockMessageHub.routeToOutput).toHaveBeenCalledTimes(1);
    expect(mockMessageHub.routeToOutput).toHaveBeenCalledWith(
      'memory',
      expect.objectContaining({
        action: 'insert',
        target: 'cache',
        title: 'assistant: response',
      })
    );
  });

  it('should not call messageHub when finish_reason is not stop', async () => {
    const interceptor = new CacheMemoryInterceptor({
      agentId: 'test-agent',
      projectPath: '/tmp/test-project',
      messageHub: mockMessageHub,
    });

    await interceptor.interceptResponse(
      {
        success: true,
        response: 'test response',
        sessionId: 'session-1',
        metadata: {
          round_trace: [
            { finish_reason: 'length' },
          ],
        },
      },
      {
        text: 'test request',
        sessionId: 'session-1',
      }
    );

    expect(mockMessageHub.routeToOutput).not.toHaveBeenCalled();
  });

  it('should not call messageHub when disabled', async () => {
    const interceptor = new CacheMemoryInterceptor({
      agentId: 'test-agent',
      projectPath: '/tmp/test-project',
      messageHub: mockMessageHub,
      enabled: false,
    });

    await interceptor.interceptRequest({
      text: 'test request',
      sessionId: 'session-1',
    });

    expect(mockMessageHub.routeToOutput).not.toHaveBeenCalled();
  });
});
