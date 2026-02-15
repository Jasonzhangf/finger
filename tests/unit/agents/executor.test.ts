import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutorRole, ExecutorRoleConfig, ExecutorState } from '../../../src/agents/roles/executor.js';

// Mock child_process for BdTools
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _options: any, callback: any) => {
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
    expect(executor.getState()).toBe(ExecutorState.Idle);
    expect(executor.getConfig().id).toBe('executor-1');
    expect(executor.getConfig().name).toBe('Executor-1');
  });

  it('tracks state transitions correctly', async () => {
    const executor = new ExecutorRole(config);
    
    expect(executor.getState()).toBe(ExecutorState.Idle);
    
    await executor.initialize();
    expect(executor.getState()).toBe(ExecutorState.Idle);
  });

  it('provides correct role name', () => {
    const executor = new ExecutorRole(config);
    expect(executor.getConfig().name).toBe('Executor-1');
  });
});
