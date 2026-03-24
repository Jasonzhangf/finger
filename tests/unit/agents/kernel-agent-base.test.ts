import { describe, expect, it, vi } from 'vitest';
import { KernelAgentBase, type KernelAgentRunner, type KernelRunContext } from '../../../src/agents/base/kernel-agent-base.js';

describe('KernelAgentBase session binding', () => {
  it('reuses internal session for repeated external sessionId', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, context?: KernelRunContext) => {
        if (context) {
          contexts.push(context);
        }
        return {
          reply: 'ok',
        };
      }),
    };

    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
    );

    await agent.handle({ text: 'first', sessionId: 'ui-session-1' });
    await agent.handle({ text: 'second', sessionId: 'ui-session-1' });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.sessionId).toBeTruthy();
    expect(contexts[0]?.sessionId).toBe(contexts[1]?.sessionId);
    expect(contexts[1]?.history.some((item) => item.role === 'user' && item.content === 'first')).toBe(true);
  });

  it('skips session persistence when client controls session messages', async () => {
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async () => ({ reply: 'ok' })),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
    );

    await agent.handle({
      text: 'client-side persist only',
      sessionId: 'ui-session-client-1',
      metadata: { sessionPersistence: 'client' },
    });

    const contexts: KernelRunContext[] = [];
    (runner.runTurn as any).mock.calls.forEach((call: unknown[]) => {
      const context = call[1] as KernelRunContext | undefined;
      if (context) contexts.push(context);
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.history.length).toBe(0);
  });

  it('ignores inline review loop and returns main-thread reply directly', async () => {
    const contexts: KernelRunContext[] = [];
    let mainTurns = 0;
    let reviewTurns = 0;
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (text: string, context?: KernelRunContext) => {
        if (context) {
          contexts.push(context);
        }
        const mode = typeof context?.metadata?.mode === 'string' ? context.metadata.mode : 'main';
        if (mode === 'review') {
          reviewTurns += 1;
          if (reviewTurns === 1) {
            return {
              reply: JSON.stringify({
                passed: false,
                feedback: '需要补充最终文件路径与验证结论',
              }),
            };
          }
          return {
            reply: JSON.stringify({
              passed: true,
              feedback: '通过',
            }),
          };
        }

        mainTurns += 1;
        return {
          reply: '主线程直接答复',
        };
      }),
    };

    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
    );

    const result = await agent.handle({
      text: '完成任务',
      sessionId: 'ui-session-review-1',
      metadata: {
        review: {
          enabled: true,
          target: '验证结果可复现',
          strictness: 'strict',
          maxTurns: 10,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.response).toBe('主线程直接答复');
    expect(mainTurns).toBe(1);
    expect(reviewTurns).toBe(0);
    expect(runner.runTurn).toHaveBeenCalledTimes(1);
    const reviewContexts = contexts.filter((item) => item.metadata?.mode === 'review');
    expect(reviewContexts).toHaveLength(0);
  });

  it('does not execute inline review turns even when review metadata is provided', async () => {
    let mainTurns = 0;
    let reviewTurns = 0;
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, context?: KernelRunContext) => {
        const mode = typeof context?.metadata?.mode === 'string' ? context.metadata.mode : 'main';
        if (mode === 'review') {
          reviewTurns += 1;
          return {
            reply: JSON.stringify({
              passed: false,
              feedback: '仍不满足约束',
            }),
          };
        }
        mainTurns += 1;
        return { reply: '第一次答复' };
      }),
    };

    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
    );

    const result = await agent.handle({
      text: '完成任务',
      sessionId: 'ui-session-review-2',
      metadata: {
        review: {
          enabled: true,
          target: '主线合格',
          strictness: 'mainline',
          maxTurns: 1,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.response).toBe('第一次答复');
    expect(mainTurns).toBe(1);
    expect(reviewTurns).toBe(0);
  });

  it('nudges once when execution request gets promise-only reply without tool evidence', async () => {
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (text: string, context?: KernelRunContext) => {
        if (text.includes('[SYSTEM CONTINUATION REQUEST]')) {
          expect(context?.metadata?.executionNudgeApplied).toBe(true);
          return {
            reply: '已执行并完成：列出了目录并写入文件。',
            metadata: {
              tool_trace: [
                { tool: 'exec_command', status: 'ok' },
              ],
            },
          };
        }
        return {
          reply: '收到，我会马上处理并回报结果。',
        };
      }),
    };

    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
    );

    const result = await agent.handle({
      text: '请列出当前目录并写入 ./tmp/readme.md',
      sessionId: 'ui-session-nudge-1',
    });

    expect(result.success).toBe(true);
    expect(result.response).toBe('已执行并完成：列出了目录并写入文件。');
    expect(runner.runTurn).toHaveBeenCalledTimes(2);
  });

  it('repairs structured output locally when JSON has fences and trailing comma', async () => {
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async () => ({
        reply: '```json\n{"role":"executor","summary":"done","status":"completed","outputs":[],"evidence":[],"nextAction":"none",}\n```',
      })),
    };

    const agent = new KernelAgentBase(
      {
        moduleId: 'finger-executor',
        provider: 'codex',
        defaultRoleProfileId: 'executor',
        maxContextMessages: 20,
      },
      runner,
    );

    const result = await agent.handle({
      text: '执行任务',
      sessionId: 'ui-session-structured-1',
      roleProfile: 'executor',
      metadata: { responsesStructuredOutput: true },
    });

    expect(result.success).toBe(true);
    expect(result.response).toContain('"summary": "done"');
    expect(runner.runTurn).toHaveBeenCalledTimes(1);
  });

  it('requests one structured output retry with field-level errors when schema validation fails', async () => {
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (text: string) => {
        if (text.includes('[STRUCTURED OUTPUT RETRY]')) {
          expect(text).toContain('$.summary: is required');
          expect(text).toContain('$.status: must be one of');
          return {
            reply: JSON.stringify({
              role: 'executor',
              summary: 'fixed',
              status: 'completed',
              outputs: [],
              evidence: [],
              nextAction: 'none',
            }),
          };
        }
        return {
          reply: JSON.stringify({
            role: 'executor',
            status: 'oops',
            outputs: [],
            evidence: [],
            nextAction: 'none',
          }),
        };
      }),
    };

    const agent = new KernelAgentBase(
      {
        moduleId: 'finger-executor',
        provider: 'codex',
        defaultRoleProfileId: 'executor',
        maxContextMessages: 20,
      },
      runner,
    );

    const result = await agent.handle({
      text: '执行任务',
      sessionId: 'ui-session-structured-2',
      roleProfile: 'executor',
      metadata: { responsesStructuredOutput: true },
    });

    expect(result.success).toBe(true);
    expect(result.response).toContain('"summary": "fixed"');
    expect(runner.runTurn).toHaveBeenCalledTimes(2);
  });

  it('fails with explicit resend paths when structured output is still invalid after retry', async () => {
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (text: string) => {
        if (text.includes('[STRUCTURED OUTPUT RETRY]')) {
          return {
            reply: JSON.stringify({
              role: 'executor',
              status: 'bad',
              outputs: [],
              evidence: [],
              nextAction: 'none',
            }),
          };
        }
        return {
          reply: '{"role":"executor"',
        };
      }),
    };

    const agent = new KernelAgentBase(
      {
        moduleId: 'finger-executor',
        provider: 'codex',
        defaultRoleProfileId: 'executor',
        maxContextMessages: 20,
      },
      runner,
    );

    const result = await agent.handle({
      text: '执行任务',
      sessionId: 'ui-session-structured-3',
      roleProfile: 'executor',
      metadata: { responsesStructuredOutput: true },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Structured output schema validation failed after retry');
    expect(result.error).toContain('$.summary: is required');
    expect(result.error).toContain('$.status: must be one of');
  });

  it('supports configurable structured output retry count', async () => {
    let attempts = 0;
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (text: string) => {
        if (text.includes('[STRUCTURED OUTPUT RETRY]')) {
          attempts += 1;
          if (attempts === 1) {
            return {
              reply: JSON.stringify({
                role: 'executor',
                status: 'still_bad',
                outputs: [],
                evidence: [],
                nextAction: 'none',
              }),
            };
          }
          return {
            reply: JSON.stringify({
              role: 'executor',
              summary: 'second retry fixed',
              status: 'completed',
              outputs: [],
              evidence: [],
              nextAction: 'none',
            }),
          };
        }
        return {
          reply: '{"role":"executor"',
        };
      }),
    };

    const agent = new KernelAgentBase(
      {
        moduleId: 'finger-executor',
        provider: 'codex',
        defaultRoleProfileId: 'executor',
        maxContextMessages: 20,
      },
      runner,
    );

    const result = await agent.handle({
      text: '执行任务',
      sessionId: 'ui-session-structured-4',
      roleProfile: 'executor',
      metadata: {
        responsesStructuredOutput: true,
        structuredOutputRetryMaxAttempts: 2,
      },
    });

    expect(result.success).toBe(true);
    expect(result.response).toContain('"summary": "second retry fixed"');
    expect(runner.runTurn).toHaveBeenCalledTimes(3);
  });
});

describe('inference chain uses MemorySessionManager not ledger/context builder', () => {
  it('proves history comes from in-memory session.messages, not ledger or context builder', async () => {
    const { MemorySessionManager } = await import('../../../src/agents/base/memory-session-manager.js');

    // This test proves that KernelAgentBase.handle() reads from MemorySessionManager
    // (session.messages.slice(-limit)) and NOT from ledger/context-builder.
    //
    // Evidence: We add a message directly to MemorySessionManager before the turn,
    // and verify that the runner receives it in context.history.
    // If it were reading from ledger, the message would not appear (ledger is empty).
    // If it were using context-builder, the message would have different shape.

    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'done' };
      }),
    };

    // Create agent with custom MemorySessionManager
    const customSessionManager = new MemorySessionManager();
    const agent = new KernelAgentBase(
      {
        moduleId: 'test-module',
        provider: 'test',
        maxContextMessages: 50,
      },
      runner,
      customSessionManager,
    );

    // Pre-populate the MemorySessionManager with a message (simulating prior turn)
    // This message exists ONLY in memory, NOT in ledger
    const session = await customSessionManager.createSession({
      projectPath: '/tmp/test',
    });
    const sessionId = session.id;
    await customSessionManager.addMessage(sessionId, {
      id: 'msg-memory-only-1',
      role: 'user',
      content: 'This message exists only in MemorySessionManager, not in ledger',
      timestamp: new Date().toISOString(),
    });

    // Now handle a new turn
    await agent.handle({
      text: 'New request',
      sessionId,
    });

    // Evidence: The runner should have received the memory-only message in history
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.history).toBeDefined();

    // The history should contain the pre-populated message
    const memoryOnlyMsg = contexts[0]?.history.find(
      (h) => h.content === 'This message exists only in MemorySessionManager, not in ledger'
    );
    expect(memoryOnlyMsg).toBeDefined();
    expect(memoryOnlyMsg?.role).toBe('user');

    // Additional evidence: history shape matches MemorySessionManager output
    // (simple { role, content } items), not context-builder's TaskMessage shape
    // which has additional fields like id, timestamp, tokenCount, isCurrentTurn
    expect(contexts[0]?.history[0]).not.toHaveProperty('isCurrentTurn');
    expect(contexts[0]?.history[0]).not.toHaveProperty('tokenCount');
    expect(contexts[0]?.history[0]).not.toHaveProperty('timestampIso');
  });
});
