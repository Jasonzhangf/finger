import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrchestratorRole, AgentConfig } from '../../../src/agents/roles/orchestrator.js';

describe('OrchestratorRole', () => {
  let config: AgentConfig;

  beforeEach(() => {
    config = {
      id: 'test-orchestrator',
      systemPrompt: 'You are an orchestrator.',
      provider: {
        baseUrl: 'http://localhost:5520',
        apiKey: 'test-key',
        defaultModel: 'test-model',
      },
    };
  });

  it('creates task message with correct structure', async () => {
    const orchestrator = new OrchestratorRole(config);
    const task = {
      taskId: 't1',
      description: 'Test task',
      tools: ['file', 'code'],
      priority: 1,
    };

    const msg = orchestrator.createTaskMessage('executor-1', task);

    expect(msg.sender).toBe('test-orchestrator');
    expect(msg.receiver).toBe('executor-1');
    expect(msg.mode).toBe('execute');
    expect(msg.payload.task).toEqual(task);
    expect(msg.status).toBe('pending');
  });

  it('returns orchestrator role', () => {
    const orchestrator = new OrchestratorRole(config);
    expect(orchestrator.getRole()).toBe('orchestrator');
  });

  it('decomposes task using AI provider', async () => {
    const orchestrator = new OrchestratorRole(config);

    // Mock fetch for the provider
    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify([
              {
                taskId: 'subtask-1',
                description: 'Write tests',
                tools: ['file', 'code'],
                priority: 1,
                thought: 'Need to test first',
                action: 'Create test files',
              },
            ]),
          },
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const result = await orchestrator.decomposeTask(
      'Build a feature',
      ['executor', 'reviewer'],
      ['file', 'code', 'test']
    );

    expect(result.success).toBe(true);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks?.[0].taskId).toBe('subtask-1');
  });

  it('handles provider error gracefully', async () => {
    const orchestrator = new OrchestratorRole(config);

    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await orchestrator.decomposeTask(
      'Build a feature',
      ['executor'],
      ['file']
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });

  it('replans based on execution feedback', async () => {
    const orchestrator = new OrchestratorRole(config);

    const mockResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify([
              {
                taskId: 'retry-task',
                description: 'Retry failed task',
                tools: ['file'],
                priority: 1,
              },
            ]),
          },
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const completedTasks = [
      { taskId: 't1', description: 'Done', tools: [] as string[], priority: 1 },
    ];
    const failedTasks = [
      { taskId: 't2', description: 'Failed', tools: [] as string[], priority: 2 },
    ];
    const remainingTasks = [
      { taskId: 't3', description: 'Remaining', tools: [] as string[], priority: 3 },
    ];

    const result = await orchestrator.replan(
      completedTasks,
      failedTasks,
      remainingTasks,
      'Fix the failure and continue'
    );

    expect(result.success).toBe(true);
    expect(result.tasks).toHaveLength(1);
  });
});
