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
});
