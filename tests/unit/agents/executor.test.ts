import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutorRole, ExecutorRoleConfig } from '../../../src/agents/roles/executor.js';

// Mock Agent to avoid real iFlow connection
vi.mock('../../../src/agents/agent.js', () => {
  return {
    Agent: vi.fn().mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue({
        connected: true,
        sessionId: 'test-session',
        capabilities: ['test'],
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: 'Task completed successfully',
        stopReason: 'task_finish',
      }),
      getStatus: vi.fn().mockReturnValue({
        connected: true,
        running: false,
      }),
    })),
  };
});

// Mock child_process for BdTools
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _options: unknown, callback: (err: null, result: { stdout: string }) => void) => {
    callback(null, { stdout: '' });
  }),
}));

describe('ExecutorRole', () => {
  let config: ExecutorRoleConfig;

  beforeEach(() => {
    config = {
      id: 'executor-1',
      name: 'Executor-1',
      mode: 'auto',
      systemPrompt: 'Test prompt',
    };
  });

  it('initializes with correct config', () => {
    const executor = new ExecutorRole(config);
    expect(executor.getState()).toBe('idle');
    expect(executor.getConfig().id).toBe('executor-1');
    expect(executor.getConfig().name).toBe('Executor-1');
  });

  it('tracks state transitions correctly', async () => {
    const executor = new ExecutorRole(config);
    
    expect(executor.getState()).toBe('idle');
    
    await executor.initialize();
    expect(executor.getState()).toBe('idle');
  });

  it('provides correct role name', () => {
    const executor = new ExecutorRole(config);
    expect(executor.getConfig().name).toBe('Executor-1');
  });
});
