import { describe, expect, it, vi } from 'vitest';
import { KernelAgentBase, type KernelAgentRunner, type KernelRunContext, type KernelInputItem } from '../../../src/agents/base/kernel-agent-base.js';
import { setContextBuilderOnDemandView } from '../../../src/runtime/context-builder-on-demand-state.js';
import { resetUpdatePlanToolState, updatePlanTool } from '../../../src/tools/internal/codex-update-plan-tool.js';

describe('KernelAgentBase session binding', () => {
  it('reuses internal session for repeated external sessionId', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
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
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], _context?: KernelRunContext) => ({ reply: 'ok' })),
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
      const context = call[2] as KernelRunContext | undefined;
      if (context) contexts.push(context);
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.history.length).toBe(0);
  });

  it('propagates context-builder routing metadata from provided history to runner metadata', async () => {
    const contexts: KernelRunContext[] = [];
    const providerSessionIds: string[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
        contextHistoryProvider: async (sessionId) => {
          providerSessionIds.push(sessionId);
          return [
          {
            role: 'user',
            content: '历史消息',
            metadata: {
              contextBuilderHistorySource: 'raw_session',
              contextBuilderBypassed: true,
              contextBuilderBypassReason: 'media_turn',
              contextBuilderRebuilt: false,
            },
          },
          ];
        },
      },
      runner,
    );

    await agent.handle({
      text: '当前输入',
      sessionId: 'ui-session-context-meta-1',
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.metadata).toMatchObject({
      contextHistorySource: 'raw_session',
      contextBuilderBypassed: true,
      contextBuilderBypassReason: 'media_turn',
      contextBuilderRebuilt: false,
    });
    expect(providerSessionIds).toEqual(['ui-session-context-meta-1']);
  });

  it('keeps raw-session history unchanged when rebuild is not requested', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
        contextHistoryProvider: async () => [
          {
            id: 'u1',
            role: 'user',
            content: '任务A：检查 mailbox 流程',
            metadata: { contextLedgerSlot: 10, contextBuilderHistorySource: 'raw_session', contextBuilderBypassed: true },
          },
          {
            id: 'a1',
            role: 'assistant',
            content: '任务A完成：已验证 mailbox',
            metadata: { contextLedgerSlot: 13, contextBuilderHistorySource: 'raw_session', contextBuilderBypassed: true },
          },
          {
            id: 'u2',
            role: 'user',
            content: '任务B：修复 context rebuild',
            metadata: { contextLedgerSlot: 20, contextBuilderHistorySource: 'raw_session', contextBuilderBypassed: true },
          },
          {
            id: 'a2',
            role: 'assistant',
            content: '任务B完成：修复完毕',
            metadata: { contextLedgerSlot: 28, contextBuilderHistorySource: 'raw_session', contextBuilderBypassed: true },
          },
        ],
      },
      runner,
    );

    await agent.handle({
      text: '继续',
      sessionId: 'ui-session-digest-1',
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.history.length).toBe(4);
    expect(contexts[0]?.history[0]?.content).toBe('任务A：检查 mailbox 流程');
    expect(contexts[0]?.history[1]?.content).toBe('任务A完成：已验证 mailbox');
    expect(contexts[0]?.history[2]?.content).toBe('任务B：修复 context rebuild');
    expect(contexts[0]?.history[3]?.content).toBe('任务B完成：修复完毕');
  });

  it('allows disabling history digest via metadata.contextHistoryDigestEnabled=false', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 20,
        contextHistoryProvider: async () => [
          {
            role: 'user',
            content: '原始历史用户消息',
            metadata: { contextBuilderHistorySource: 'raw_session', contextBuilderBypassed: true },
          },
          {
            role: 'assistant',
            content: '原始历史助手消息',
            metadata: { contextBuilderHistorySource: 'raw_session', contextBuilderBypassed: true },
          },
        ],
      },
      runner,
    );

    await agent.handle({
      text: '继续',
      sessionId: 'ui-session-digest-off-1',
      metadata: {
        contextHistoryDigestEnabled: false,
      },
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.history.length).toBe(2);
    expect(contexts[0]?.history[0]?.content).toBe('原始历史用户消息');
    expect(contexts[0]?.history[1]?.content).toBe('原始历史助手消息');
  });

  it('preserves critical lifecycle calls when rebuild-turn digest is enabled', async () => {
    const contexts: KernelRunContext[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        return { reply: 'ok' };
      }),
    };
    const rebuiltMeta = {
      contextBuilderHistorySource: 'context_builder_on_demand',
      contextBuilderRebuilt: true,
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 40,
        contextHistoryProvider: async () => [
          { id: 'u1', role: 'user', content: '任务1：编排方案', metadata: { ...rebuiltMeta, contextLedgerSlot: 1 } },
          { id: 'a1', role: 'assistant', content: '✅ [工具] agent.dispatch | 已派发给 project', metadata: { ...rebuiltMeta, contextLedgerSlot: 2 } },
          { id: 'u2', role: 'user', content: '任务2：普通修复', metadata: { ...rebuiltMeta, contextLedgerSlot: 3 } },
          { id: 'a2', role: 'assistant', content: '任务2完成', metadata: { ...rebuiltMeta, contextLedgerSlot: 4 } },
          { id: 'u3', role: 'user', content: '任务3：继续执行', metadata: { ...rebuiltMeta, contextLedgerSlot: 5 } },
          { id: 'a3', role: 'assistant', content: '任务3完成', metadata: { ...rebuiltMeta, contextLedgerSlot: 6 } },
          { id: 'u4', role: 'user', content: '任务4：review', metadata: { ...rebuiltMeta, contextLedgerSlot: 7 } },
          { id: 'a4', role: 'assistant', content: 'Decision: PASS', metadata: { ...rebuiltMeta, contextLedgerSlot: 8 } },
        ],
      },
      runner,
    );

    await agent.handle({
      text: '继续',
      sessionId: 'ui-session-digest-critical-1',
    });

    expect(contexts).toHaveLength(1);
    const history = contexts[0]?.history ?? [];
    expect(history.some((item) => item.content.includes('agent.dispatch'))).toBe(true);
    expect(history.some((item) => item.content.includes('[task_digest'))).toBe(true);
  });

  it('keeps history provider output stable while previous turn is unfinished', async () => {
    const contexts: KernelRunContext[] = [];
    const providerCalls: string[] = [];
    let turn = 0;
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        turn += 1;
        if (turn === 1) {
          return {
            reply: 'still running',
            metadata: {
              round_trace: [{ round: 1, finish_reason: 'length', response_status: 'incomplete' }],
            },
          };
        }
        return {
          reply: 'done',
          metadata: {
            round_trace: [{ round: 2, finish_reason: 'stop', response_status: 'completed' }],
          },
        };
      }),
    };

    const agent = new KernelAgentBase(
      {
        moduleId: 'chat-codex',
        provider: 'codex',
        maxContextMessages: 0,
        contextHistoryProvider: async (sessionId) => {
          providerCalls.push(sessionId);
          return [
            {
              role: 'user',
              content: providerCalls.length === 1 ? 'provider-history-v1' : 'provider-history-v2',
              metadata: {
                contextBuilderHistorySource: providerCalls.length === 1 ? 'raw_session' : 'context_builder_indexed',
              },
            },
          ];
        },
      },
      runner,
    );

    await agent.handle({ text: '第一轮', sessionId: 'ui-session-lock-1' });
    await agent.handle({ text: '继续', sessionId: 'ui-session-lock-1' });

    expect(providerCalls).toEqual(['ui-session-lock-1']);
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.history.some((item) => item.content.includes('provider-history-v1'))).toBe(true);
    expect(contexts[1]?.history.some((item) => item.content.includes('provider-history-v1'))).toBe(true);
    expect(contexts[1]?.history.some((item) => item.content.includes('provider-history-v2'))).toBe(false);
  });

  it('allows explicit context_builder.rebuild to refresh history even during unfinished continuation', async () => {
    const contexts: KernelRunContext[] = [];
    const providerCalls: string[] = [];
    let turn = 0;
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        if (context) contexts.push(context);
        turn += 1;
        if (turn === 1) {
          return {
            reply: 'still running',
            metadata: {
              round_trace: [{ round: 1, finish_reason: 'length', response_status: 'incomplete' }],
            },
          };
        }
        return {
          reply: 'done',
          metadata: {
            round_trace: [{ round: 2, finish_reason: 'stop', response_status: 'completed' }],
          },
        };
      }),
    };

    const sessionId = 'ui-session-lock-rebuild-1';
    const moduleId = 'chat-codex';
    const agent = new KernelAgentBase(
      {
        moduleId,
        provider: 'codex',
        maxContextMessages: 0,
        contextHistoryProvider: async (providerSessionId) => {
          providerCalls.push(providerSessionId);
          return [
            {
              role: 'user',
              content: providerCalls.length === 1 ? 'provider-history-v1' : 'provider-history-v2',
              metadata: {
                contextBuilderHistorySource: providerCalls.length === 1 ? 'raw_session' : 'context_builder_on_demand',
                contextBuilderRebuilt: providerCalls.length !== 1,
              },
            },
          ];
        },
      },
      runner,
    );

    await agent.handle({ text: '第一轮', sessionId });

    setContextBuilderOnDemandView({
      sessionId,
      agentId: moduleId,
      mode: 'main',
      buildMode: 'moderate',
      targetBudget: 50_000,
      selectedBlockIds: ['task-1'],
      metadata: { trigger: 'test' },
      messages: [],
      createdAt: new Date().toISOString(),
    });

    await agent.handle({ text: '继续', sessionId });

    expect(providerCalls).toEqual([sessionId, sessionId]);
    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.history.some((item) => item.content.includes('provider-history-v2'))).toBe(true);
  });

  it('ignores inline review loop and returns main-thread reply directly', async () => {
    const contexts: KernelRunContext[] = [];
    let mainTurns = 0;
    let reviewTurns = 0;
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
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
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
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
      runTurn: vi.fn(async (text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
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

  it('always injects reasoning.stop into turn tools when stop-tool policy is enabled', async () => {
    const seenTools: string[][] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        seenTools.push([...(context?.tools ?? [])]);
        return {
          reply: '执行完成，调用 stop 工具后结束。',
          metadata: {
            tool_trace: [{ tool: 'reasoning.stop', status: 'ok' }],
          },
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
      text: '执行后停止',
      sessionId: 'ui-session-stop-tool-inject-1',
      tools: ['exec_command'],
      metadata: {
        stopToolNames: ['reasoning.stop'],
        stopToolMaxAutoContinueTurns: 2,
      },
    });

    expect(result.success).toBe(true);
    expect(seenTools.length).toBeGreaterThan(0);
    expect(seenTools[0]).toContain('exec_command');
    expect(seenTools[0]).toContain('reasoning.stop');
  });

  it('injects task.plan_view into system agent context slots with all-project active plans', async () => {
    resetUpdatePlanToolState();
    const systemCtx = {
      invocationId: 't-system',
      cwd: '/repo/a',
      timestamp: new Date().toISOString(),
      agentId: 'finger-system-agent',
      sessionId: 'system-1',
    };
    await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: { title: 'Plan A', assigneeWorkerId: 'finger-worker-01' },
    }, systemCtx);
    await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/b',
      item: { title: 'Plan B', assigneeWorkerId: 'finger-worker-02' },
    }, { ...systemCtx, cwd: '/repo/b' });

    let capturedContext: KernelRunContext | undefined;
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        capturedContext = context;
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'finger-system-agent',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
    );

    await agent.handle({
      text: '检查计划视图',
      sessionId: 'system-plan-view-1',
      metadata: { cwd: '/repo/a' },
    });

    const slots = Array.isArray(capturedContext?.metadata?.contextSlots)
      ? capturedContext?.metadata?.contextSlots as Array<Record<string, unknown>>
      : [];
    const planSlot = slots.find((slot) => slot.id === 'task.plan_view');
    expect(planSlot).toBeTruthy();
    const content = String(planSlot?.content ?? '');
    expect(content).toContain('Plan A');
    expect(content).toContain('Plan B');
  });

  it('injects task.plan_view into project agent context slots scoped by project path', async () => {
    resetUpdatePlanToolState();
    const systemCtx = {
      invocationId: 't-system',
      cwd: '/repo/a',
      timestamp: new Date().toISOString(),
      agentId: 'finger-system-agent',
      sessionId: 'system-1',
    };
    await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/a',
      item: { title: 'Scoped Plan A', assigneeWorkerId: 'finger-project-agent' },
    }, systemCtx);
    await updatePlanTool.execute({
      action: 'create',
      projectPath: '/repo/b',
      item: { title: 'Scoped Plan B', assigneeWorkerId: 'finger-project-agent' },
    }, { ...systemCtx, cwd: '/repo/b' });

    let capturedContext: KernelRunContext | undefined;
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
        capturedContext = context;
        return { reply: 'ok' };
      }),
    };
    const agent = new KernelAgentBase(
      {
        moduleId: 'finger-project-agent',
        provider: 'codex',
        maxContextMessages: 20,
      },
      runner,
    );

    await agent.handle({
      text: '检查项目计划视图',
      sessionId: 'project-plan-view-1',
      metadata: { cwd: '/repo/a' },
    });

    const slots = Array.isArray(capturedContext?.metadata?.contextSlots)
      ? capturedContext?.metadata?.contextSlots as Array<Record<string, unknown>>
      : [];
    const planSlot = slots.find((slot) => slot.id === 'task.plan_view');
    expect(planSlot).toBeTruthy();
    const content = String(planSlot?.content ?? '');
    expect(content).toContain('Scoped Plan A');
    expect(content).not.toContain('Scoped Plan B');
  });

  it('repairs structured output locally when JSON has fences and trailing comma', async () => {
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], _context?: KernelRunContext) => ({
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
      runTurn: vi.fn(async (text: string, _inputItems?: KernelInputItem[], _context?: KernelRunContext) => {
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
      runTurn: vi.fn(async (text: string, _inputItems?: KernelInputItem[], _context?: KernelRunContext) => {
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
      runTurn: vi.fn(async (text: string, _inputItems?: KernelInputItem[], _context?: KernelRunContext) => {
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
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], context?: KernelRunContext) => {
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

describe('KernelAgentBase inputItems forwarding', () => {
  it('forwards inputItems from metadata to runner', async () => {
    const receivedItems: KernelInputItem[][] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, _inputItems?: KernelInputItem[], _context?: KernelRunContext) => {
        if (_inputItems) receivedItems.push(_inputItems);
        return { reply: 'ok' };
      }),
    };

    const agent = new KernelAgentBase(
      { moduleId: 'test-img', provider: 'test', maxContextMessages: 20 },
      runner,
    );

    await agent.handle({
      text: 'describe this image',
      sessionId: 'img-session-1',
      metadata: {
        inputItems: [
          { type: 'text', text: 'describe this image' },
          { type: 'local_image', path: '/tmp/test.jpg' },
        ],
      },
    });

    expect(receivedItems).toHaveLength(1);
    expect(receivedItems[0]).toHaveLength(2);
    expect(receivedItems[0][0].type).toBe('text');
    expect(receivedItems[0][1].type).toBe('local_image');
    expect(receivedItems[0][1]).toEqual({ type: 'local_image', path: '/tmp/test.jpg' });
  });

  it('passes undefined inputItems when metadata has no inputItems', async () => {
    const receivedItems: (KernelInputItem[] | undefined)[] = [];
    const runner: KernelAgentRunner = {
      runTurn: vi.fn(async (_text: string, inputItems?: KernelInputItem[]) => {
        receivedItems.push(inputItems);
        return { reply: 'ok' };
      }),
    };

    const agent = new KernelAgentBase(
      { moduleId: 'test-noimg', provider: 'test', maxContextMessages: 20 },
      runner,
    );

    await agent.handle({
      text: 'hello',
      sessionId: 'text-session-1',
    });

    expect(receivedItems).toHaveLength(1);
    expect(receivedItems[0]).toBeUndefined();
  });
});
