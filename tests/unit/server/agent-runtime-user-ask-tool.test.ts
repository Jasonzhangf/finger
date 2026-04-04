import { describe, expect, it, vi } from 'vitest';
import { registerAgentRuntimeTools } from '../../../src/server/modules/agent-runtime.js';

interface RegisteredTool {
  name: string;
  inputSchema?: Record<string, unknown>;
  handler: (input: unknown, context?: Record<string, unknown>) => Promise<unknown>;
}

function createDeps(sessionContext: Record<string, unknown> = {}) {
  const tools = new Map<string, RegisteredTool>();
  const runtime = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      tools.set(tool.name, tool);
    }),
    getCurrentSession: vi.fn(() => ({ id: 'session-main' })),
  };
  const askManager = {
    open: vi.fn((input: any) => ({
      pending: {
        requestId: 'ask-1',
        question: input.question,
        options: input.options,
        context: input.context,
        agentId: input.agentId,
        sessionId: input.sessionId,
        createdAt: new Date().toISOString(),
      },
      result: Promise.resolve({
        ok: true,
        requestId: 'ask-1',
        answer: '继续',
        selectedOption: '继续',
        respondedAt: new Date().toISOString(),
      }),
    })),
  };
  const eventBus = {
    emit: vi.fn(async () => undefined),
  };
  const broadcast = vi.fn();

  registerAgentRuntimeTools({
    runtime,
    askManager,
    eventBus,
    broadcast,
    sessionManager: {
      getSession: vi.fn(() => ({ id: 'session-main', context: sessionContext })),
    },
    agentRuntimeBlock: {
      execute: vi.fn(async () => ({})),
    },
    primaryOrchestratorAgentId: 'finger-system-agent',
  } as any);

  return {
    tool: tools.get('user.ask'),
    askManager,
    eventBus,
  };
}

describe('agent-runtime user.ask tool', () => {
  it('registers strict openai-compatible schema for user.ask', async () => {
    const { tool } = createDeps();
    if (!tool) throw new Error('user.ask tool missing');
    expect(tool.inputSchema).toEqual(expect.objectContaining({
      type: 'object',
      required: ['question'],
      additionalProperties: false,
    }));
    const props = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
    expect(typeof props.question).toBe('object');
    expect(typeof props.blocking_reason).toBe('object');
    expect(typeof props.decision_impact).toBe('object');
  });

  it('registers user.ask and runs blocking ask with caller fallback context', async () => {
    const { tool, askManager, eventBus } = createDeps();
    if (!tool) throw new Error('user.ask tool missing');

    const result = await tool.handler(
      {
        question: '请选择部署窗口',
        options: ['今晚', '明天'],
        blocking_reason: '生产发布窗口需要用户最终决策',
        decision_impact: 'critical',
      },
      {
        agentId: 'finger-system-agent',
        sessionId: 'session-system',
      },
    ) as Record<string, unknown>;

    expect(askManager.open).toHaveBeenCalledWith(expect.objectContaining({
      question: '请选择部署窗口',
      agentId: 'finger-system-agent',
      sessionId: 'session-system',
    }));
    expect(eventBus.emit).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.requestId).toBe('ask-1');
  });

  it('rejects approval-only yes/no ask without blocker context', async () => {
    const { tool, askManager } = createDeps();
    if (!tool) throw new Error('user.ask tool missing');

    await expect(tool.handler({
      question: '要我继续吗？',
      options: ['是', '否'],
    }, {
      agentId: 'finger-project-agent',
      sessionId: 'session-project',
    })).rejects.toThrow(/critical blocking decisions/i);

    expect(askManager.open).not.toHaveBeenCalled();
  });

  it('allows yes/no ask when explicitly marked as critical blocker', async () => {
    const { tool, askManager } = createDeps();
    if (!tool) throw new Error('user.ask tool missing');

    await expect(tool.handler({
      question: '是否执行不可逆数据库迁移？',
      options: ['是', '否'],
      blocking_reason: '该迁移不可逆，需用户确认',
      decision_impact: 'critical',
    }, {
      agentId: 'finger-project-agent',
      sessionId: 'session-project',
    })).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(askManager.open).toHaveBeenCalledTimes(1);
  });

  it('fills channel scope from session context when user.ask input omits channel fields', async () => {
    const { tool, askManager } = createDeps({
      channelId: 'qqbot',
      channelUserId: 'user-123',
      channelGroupId: 'group-xyz',
    });
    if (!tool) throw new Error('user.ask tool missing');

    await expect(tool.handler({
      question: '是否执行不可逆数据库迁移？',
      options: ['是', '否'],
      blocking_reason: '该迁移不可逆，需用户确认',
      decision_impact: 'critical',
    }, {
      agentId: 'finger-system-agent',
      sessionId: 'session-main',
    })).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(askManager.open).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'qqbot',
      userId: 'user-123',
      groupId: 'group-xyz',
    }));
  });
});
