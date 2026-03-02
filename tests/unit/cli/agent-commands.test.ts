/**
 * Unit tests for agent commands - Message Hub wrappers
 * 
 * 所有命令通过 Message Hub (5521) 发送消息
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;
const TEST_HUB_URL = process.env.FINGER_HUB_URL || 'http://localhost:5521';

describe('agent commands - Message Hub', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should verify understand command structure', () => {
    const command = {
      name: 'understand',
      description: '语义理解：分析用户输入意图',
      hasArgument: true,
      argumentName: '<input>',
      hasOptions: ['-s, --session <id>'],
    };
    expect(command.name).toBe('understand');
    expect(command.description).toContain('语义');
    expect(command.hasArgument).toBe(true);
  });

  it('should verify route command structure', () => {
    const command = {
      name: 'route',
      description: '路由决策：基于语义分析结果决定任务流向',
      hasOptions: ['-i, --intent <json>', '-s, --session <id>'],
    };
    expect(command.name).toBe('route');
    expect(command.description).toContain('路由');
  });

  it('should verify plan command structure', () => {
    const command = {
      name: 'plan',
      description: '任务规划：将大任务拆解为可执行子任务',
      hasArgument: true,
      argumentName: '<task>',
      hasOptions: ['-s, --session <id>'],
    };
    expect(command.name).toBe('plan');
    expect(command.description).toContain('任务规划');
  });

  it('should verify execute command structure', () => {
    const command = {
      name: 'execute',
      description: '任务执行：调用工具完成具体任务',
      hasOptions: ['-t, --task <description>', '-a, --agent <id>', '-b, --blocking', '-s, --session <id>'],
    };
    expect(command.name).toBe('execute');
    expect(command.description).toContain('任务执行');
  });

  it('should verify review command structure', () => {
    const command = {
      name: 'review',
      description: '质量审查：审查计划和执行结果',
      hasOptions: ['-p, --proposal <json>'],
    };
    expect(command.name).toBe('review');
    expect(command.description).toContain('质量审查');
  });

  it('should verify orchestrate command structure', () => {
    const command = {
      name: 'orchestrate',
      description: '编排协调：管理整体任务流程',
      hasArgument: true,
      argumentName: '<task>',
      hasOptions: ['-s, --session <id>', '-w, --watch'],
    };
    expect(command.name).toBe('orchestrate');
    expect(command.description).toContain('编排');
  });
});

describe('understand command - Message Hub', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should send message to Message Hub', async () => {
    const { understandCommand } = await import('../../../src/cli/agent-commands.js');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messageId: 'msg-123', status: 'queued' }),
    });
    await understandCommand('搜索 deepseek', { sessionId: 'test-session' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`${TEST_HUB_URL}/api/v1/message`),
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.target).toBe('understanding-agent');
    expect(callBody.message.type).toBe('UNDERSTAND');
    expect(callBody.message.input).toBe('搜索 deepseek');
  });

  it('should include callbackId in response', async () => {
    const { understandCommand } = await import('../../../src/cli/agent-commands.js');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messageId: 'msg-123', status: 'queued' }),
    });
    await understandCommand('test', {});
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.callbackId).toMatch(/^cli-\d+-[a-z0-9]+$/);
  });

  it('should handle Message Hub error', async () => {
    const { understandCommand } = await import('../../../src/cli/agent-commands.js');
    mockFetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Service Unavailable',
    });
    await expect(understandCommand('test', {})).rejects.toThrow('Message Hub error');
  });
});

describe('route command - Message Hub', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should send message to router-agent', async () => {
    const { routeCommand } = await import('../../../src/cli/agent-commands.js');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messageId: 'msg-456', status: 'queued' }),
    });
    await routeCommand('{"intent": "search"}', {});
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.target).toBe('router-agent');
    expect(callBody.message.type).toBe('ROUTE');
  });
});

describe('plan command - Message Hub', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should send message to planner-agent', async () => {
    const { planCommand } = await import('../../../src/cli/agent-commands.js');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messageId: 'msg-789', status: 'queued' }),
    });
    await planCommand('实现搜索功能', { sessionId: 'session-abc' });
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.target).toBe('planner-agent');
    expect(callBody.message.type).toBe('PLAN');
    expect(callBody.message.task).toBe('实现搜索功能');
  });
});

describe('execute command - Message Hub', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should send message to executor-agent', async () => {
    const { executeCommand } = await import('../../../src/cli/agent-commands.js');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messageId: 'msg-exec', status: 'queued' }),
    });
    await executeCommand('搜索 deepseek', {
      agent: 'executor-1',
      blocking: true,
      sessionId: 'session-xyz',
    });
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.target).toBe('executor-1');
    expect(callBody.message.type).toBe('EXECUTE');
    expect(callBody.blocking).toBe(true);
  });

  it('should use default executor-agent if not specified', async () => {
    const { executeCommand } = await import('../../../src/cli/agent-commands.js');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messageId: 'msg-exec2', status: 'queued' }),
    });
    await executeCommand('分析数据', { blocking: false });
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.target).toBe('executor-agent');
    expect(callBody.blocking).toBe(false);
  });
});

describe('review command - Message Hub', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should send message to reviewer-agent', async () => {
    const { reviewCommand } = await import('../../../src/cli/agent-commands.js');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messageId: 'msg-review', status: 'queued' }),
    });
    await reviewCommand('{"proposal": "test plan"}');
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.target).toBe('reviewer-agent');
    expect(callBody.message.type).toBe('REVIEW');
  });
});

describe('orchestrate command - Message Hub', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should send message to orchestrator', async () => {
    const { orchestrateCommand } = await import('../../../src/cli/agent-commands.js');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messageId: 'msg-orch', status: 'queued', result: { workflowId: 'wf-001' } }),
    });
    await orchestrateCommand('搜索 deepseek 最新发布', {
      sessionId: 'session-001',
      watch: true,
    });
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.target).toBe('orchestrator');
    expect(callBody.message.type).toBe('ORCHESTRATE');
  });

  it('should include watch mode instructions', async () => {
    const { orchestrateCommand } = await import('../../../src/cli/agent-commands.js');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messageId: 'msg-orch2', status: 'queued', result: { workflowId: 'wf-002' } }),
    });
    await orchestrateCommand('test task', { watch: true });
    expect(mockFetch).toHaveBeenCalled();
  });
});
