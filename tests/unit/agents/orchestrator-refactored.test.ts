import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorRoleRefactored, OrchestratorAgentConfig, OrchestratorState } from '../../../src/agents/roles/orchestrator-refactored.js';

// Mock child_process for BdTools
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _options: any, callback: any) => {
    callback(null, { stdout: 'finger-200' });
  }),
}));

describe('OrchestratorRoleRefactored', () => {
  let config: OrchestratorAgentConfig;

  beforeEach(() => {
    config = {
      id: 'orchestrator-1',
      name: 'Orchestrator',
      mode: 'auto',
      systemPrompt: 'Test prompt',
    };
  });

  it('initializes with correct config', () => {
    const orchestrator = new OrchestratorRoleRefactored(config);
    expect(orchestrator.getState()).toBe(OrchestratorState.understanding);
  });

  it('starts orchestration and creates epic', async () => {
    const orchestrator = new OrchestratorRoleRefactored(config);
    await orchestrator.initialize();

    const epicId = await orchestrator.startOrchestration('Build a feature');
    expect(epicId).toBeTruthy();
    expect(orchestrator.getContext().originalTask).toBe('Build a feature');
  });

  it('handles task completion feedback', async () => {
    const orchestrator = new OrchestratorRoleRefactored(config);
    await orchestrator.initialize();

    const epicId = await orchestrator.startOrchestration('Test epic');

    // Manually add a pending task
    orchestrator['context'].pendingTasks.push({
      taskId: 't1',
      description: 'Test',
      role: 'executor',
      tools: [],
      priority: 1,
      order: 1,
      blockedBy: [],
      bdTaskId: 'finger-201',
    });

    await orchestrator.onTaskComplete('finger-201', true, 'Done');

    expect(orchestrator.getContext().completedTasks).toHaveLength(1);
    expect(orchestrator.getContext().pendingTasks).toHaveLength(0);
  });

  it('handles task failure and triggers replanning', async () => {
    const orchestrator = new OrchestratorRoleRefactored(config);
    await orchestrator.initialize();

    await orchestrator.startOrchestration('Test epic');

    orchestrator['context'].pendingTasks.push({
      taskId: 't1',
      description: 'Failing task',
      role: 'executor',
      tools: [],
      priority: 1,
      order: 1,
      blockedBy: [],
      bdTaskId: 'finger-202',
    });

    await orchestrator.onTaskComplete('finger-202', false, 'Error occurred');

    expect(orchestrator.getContext().failedTasks).toHaveLength(1);
    expect(orchestrator.getState()).toBe(OrchestratorState.replanning);
  });

  it('dispatches task to executor', async () => {
    const orchestrator = new OrchestratorRoleRefactored(config);
    await orchestrator.initialize();

    await orchestrator.startOrchestration('Test epic');

    const task: any = {
      taskId: 't1',
      description: 'Test task',
      role: 'executor',
      tools: ['file.read'],
      priority: 1,
      order: 1,
      blockedBy: [],
      bdTaskId: 'finger-203',
    };

    await orchestrator.dispatchTask(task, 'executor-1');

    expect(orchestrator.getState()).toBe(OrchestratorState.dispatching);
    expect(orchestrator.getContext().pendingTasks).toHaveLength(1);
  });

  it('tracks state transitions correctly', async () => {
    const orchestrator = new OrchestratorRoleRefactored(config);
    
    expect(orchestrator.getState()).toBe(OrchestratorState.understanding);
    
    await orchestrator.initialize();
    await orchestrator.startOrchestration('Test');
    
    // State should transition based on operations
    expect([OrchestratorState.understanding, OrchestratorState.planning]).toContain(orchestrator.getState());
  });
});
