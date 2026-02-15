import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutorRole, ExecutorConfig } from '../../../src/agents/roles/executor.js';
import { ToolRegistry } from '../../../src/agents/shared/tool-registry.js';
import { TaskAssignment } from '../../../src/agents/protocol/schema.js';
import { BdTools } from '../../../src/agents/shared/bd-tools.js';

// Mock child_process for BdTools
vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, _options: any, callback: any) => {
    callback(null, { stdout: '' });
  }),
}));

describe('ExecutorRole', () => {
  let config: ExecutorConfig;
  let toolRegistry: ToolRegistry;
  let bdTools: BdTools;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'file.read',
      description: 'Read file',
      params: {},
      handler: vi.fn(async () => ({ content: 'ok' })),
    });

    config = {
      id: 'executor-1',
      systemPrompt: 'You are an executor.',
      provider: {
        baseUrl: 'http://localhost:5520',
        apiKey: 'test-key',
        defaultModel: 'test-model',
      },
      toolRegistry,
    };
    bdTools = new BdTools();
    vi.spyOn(bdTools, 'addComment').mockResolvedValue();
    vi.spyOn(bdTools, 'updateStatus').mockResolvedValue();
    vi.spyOn(bdTools, 'closeTask').mockResolvedValue();
  });

  it('returns executor role', () => {
    const executor = new ExecutorRole(config, bdTools);
    expect(executor.getRole()).toBe('executor');
  });

  it('creates feedback message', () => {
    const executor = new ExecutorRole(config, bdTools);
    const feedback = {
      taskId: 't1',
      success: true,
      result: 'done',
    };

    const msg = executor.createFeedbackMessage('orchestrator-1', feedback);

    expect(msg.sender).toBe('executor-1');
    expect(msg.receiver).toBe('orchestrator-1');
    expect(msg.payload.feedback).toEqual(feedback);
    expect(msg.status).toBe('completed');
  });

  it('executes task with granted tool', async () => {
    const executor = new ExecutorRole(config, bdTools);
    toolRegistry.grant('executor-1', { toolName: 'file.read', action: 'grant' });

    const mockResponse = {
      choices: [{ message: { content: 'AI response' } }],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const task: TaskAssignment = {
      taskId: 't1',
      description: 'Read config file',
      tools: ['file.read'],
      priority: 1,
    };

    const result = await executor.executeTask(task);

    expect(result.success).toBe(true);
    expect(result.feedback?.success).toBe(true);
    expect(result.feedback?.observation).toContain('[OK] file.read');
  });

  it('marks denied tools in observation', async () => {
    const executor = new ExecutorRole(config, bdTools);

    const mockResponse = {
      choices: [{ message: { content: 'AI response' } }],
    };
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const task: TaskAssignment = {
      taskId: 't2',
      description: 'Attempt unauthorized tool',
      tools: ['file.read'],
      priority: 1,
    };

    const result = await executor.executeTask(task);

    expect(result.success).toBe(true);
    expect(result.feedback?.observation).toContain('[DENIED]');
  });

  it('handles provider failure', async () => {
    const executor = new ExecutorRole(config, bdTools);
    global.fetch = vi.fn().mockRejectedValue(new Error('provider unavailable'));

    const task: TaskAssignment = {
      taskId: 't3',
      description: 'Task fails',
      tools: [],
      priority: 1,
    };

    const result = await executor.executeTask(task);

    expect(result.success).toBe(false);
    expect(result.feedback?.success).toBe(false);
    expect(result.error).toBe('provider unavailable');
  });
});
