import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutorRole, ExecutorRoleConfig, ExecutorState, ExecutionResult } from '../../../src/agents/roles/executor.js';

// Mock child_process for BdTools
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _options: any, callback: any) => {
    callback(null, { stdout: '' });
  }),
}));

// Mock Agent
vi.mock('../../../src/agents/agent.js', () => ({
  Agent: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue({
      id: 'executor-1',
      name: 'Executor-1',
      mode: 'auto',
      connected: true,
      sessionId: 'test-session',
      capabilities: [],
      running: false,
    }),
    execute: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({
      id: 'executor-1',
      name: 'Executor-1',
      mode: 'auto',
      connected: true,
      sessionId: 'test-session',
      capabilities: [],
      running: false,
    }),
  })),
  createAgent: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue({}),
    execute: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn(),
  })),
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

  it('executes task successfully', async () => {
    const { Agent } = await import('../../../src/agents/agent.js');
    const executor = new ExecutorRole(config);

    const mockExecute = vi.fn().mockResolvedValue({
      success: true,
      output: 'Task completed',
      stopReason: 'task_finish',
    });
    (Agent as any).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue({}),
      execute: mockExecute,
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ running: false }),
    }));

    await executor.initialize();
    const result: ExecutionResult = await executor.execute({
      taskId: 't1',
      description: 'Test task',
      tools: ['file.read'],
      priority: 1,
      role: 'executor',
      order: 1,
      blockedBy: [],
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Task completed');
    expect(executor.getState()).toBe('idle');
  });

  it('handles execution failure', async () => {
    const { Agent } = await import('../../../src/agents/agent.js');
    const executor = new ExecutorRole(config);

    const mockExecute = vi.fn().mockResolvedValue({
      success: false,
      output: '',
      error: 'Execution failed',
    });
    (Agent as any).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue({}),
      execute: mockExecute,
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ running: false }),
    }));

    await executor.initialize();
    const result = await executor.execute({
      taskId: 't2',
      description: 'Failing task',
      tools: [],
      priority: 1,
      role: 'executor',
      order: 1,
      blockedBy: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Execution failed');
    expect(executor.getState()).toBe('idle');
  });

  it('tracks state transitions during execution', async () => {
    const { Agent } = await import('../../../src/agents/agent.js');
    const executor = new ExecutorRole(config);

    const states: ExecutorState[] = [];
    executor['state'] = 'idle';

    const mockExecute = vi.fn().mockImplementation(async () => {
      states.push(executor.getState());
      return { success: true, output: 'done' };
    });
    (Agent as any).mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue({}),
      execute: mockExecute,
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ running: false }),
    }));

    await executor.initialize();
    await executor.execute({
      taskId: 't3',
      description: 'State test',
      tools: [],
      priority: 1,
      role: 'executor',
      order: 1,
      blockedBy: [],
    });

    expect(states.length).toBeGreaterThan(0);
  });
});
