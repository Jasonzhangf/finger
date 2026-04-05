import { describe, expect, it, vi } from 'vitest';
import { sendProgressUpdateToChannels } from '../../../src/server/modules/agent-status-subscriber-status.js';

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 1000,
  intervalMs = 10,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('waitForCondition timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('agent status progress identity', () => {
  it('renders worker display identity from session dispatchWorkerId for project progress updates', async () => {
    const routeToOutput = vi.fn().mockResolvedValue(undefined);
    const messageHub = {
      getOutputs: () => [{ id: 'channel-bridge-qqbot' }],
      routeToOutput,
    } as any;

    const deps = {
      sessionManager: {
        getSession: (id: string) => {
          if (id !== 'session-james') return null;
          return {
            id,
            name: 'finger',
            projectPath: '/Volumes/extension/code/finger',
            context: {
              sessionTier: 'orchestrator-root',
              dispatchWorkerId: 'finger-project-agent-02',
            },
          };
        },
      },
    } as any;

    await sendProgressUpdateToChannels({
      deps,
      report: {
        sessionId: 'session-james',
        agentId: 'finger-project-agent',
        summary: '📊 08:10 | 执行中',
        progress: {
          status: 'running',
          toolCallsCount: 1,
          modelRoundsCount: 0,
          elapsedMs: 1000,
          contextUsagePercent: 10,
          estimatedTokensInContextWindow: 1200,
          maxInputTokens: 262000,
        },
      },
      primaryAgentId: 'finger-system-agent',
      lastProgressMailboxSummaryBySession: new Map<string, string>(),
      resolveEnvelopeMappings: () => [
        {
          sessionId: 'session-james',
          envelope: {
            channel: 'qqbot',
            envelopeId: 'env-james',
            userId: 'u1',
          },
          timestamp: Date.now(),
        },
      ],
      resolvePushSettings: () => ({
        statusUpdate: true,
        updateMode: 'both',
        progressUpdates: true,
      }),
      messageHub,
    });

    await waitForCondition(() => routeToOutput.mock.calls.length >= 1);
    expect(routeToOutput).toHaveBeenCalledTimes(1);
    const payload = routeToOutput.mock.calls[0]?.[1] as { content?: string };
    expect(payload.content).toContain('👤 [project] James(finger-project-agent-02)');
    expect(payload.content).not.toContain('👤 [project] Alex(');
  });
});
