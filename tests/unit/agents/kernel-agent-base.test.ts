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

  it('runs review loop and injects reviewer feedback back to main thread', async () => {
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
        if (mainTurns === 1) {
          return {
            reply: '初始答复',
          };
        }
        expect(text).toContain('[Review Feedback]');
        return {
          reply: '修正后的最终答复',
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
    expect(result.response).toBe('修正后的最终答复');
    expect(mainTurns).toBe(2);
    expect(reviewTurns).toBe(2);
    expect(runner.runTurn).toHaveBeenCalledTimes(4);

    const reviewContexts = contexts.filter((item) => item.metadata?.mode === 'review');
    expect(reviewContexts).toHaveLength(2);
    const reviewTools = reviewContexts[0]?.tools ?? [];
    expect(Array.isArray(reviewTools)).toBe(true);
    expect(reviewTools.includes('update_plan')).toBe(false);
    expect(reviewTools.includes('apply_patch')).toBe(false);
    expect(reviewContexts[0]?.history).toEqual([]);

    const metadata = result.metadata as Record<string, unknown>;
    const review = metadata.review as Record<string, unknown>;
    expect(review.passed).toBe(true);
    expect(review.iterations).toBe(2);
  });

  it('stops review loop at configured max turns', async () => {
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
        return {
          reply: mainTurns === 1 ? '第一次答复' : '按审查意见修正一次',
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
    expect(result.response).toBe('按审查意见修正一次');
    expect(mainTurns).toBe(2);
    expect(reviewTurns).toBe(1);

    const metadata = result.metadata as Record<string, unknown>;
    const review = metadata.review as Record<string, unknown>;
    expect(review.passed).toBe(false);
    expect(review.stopReason).toBe('max_turns_reached');
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
});
