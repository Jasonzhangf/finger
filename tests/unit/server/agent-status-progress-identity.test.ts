import { describe, expect, it, vi } from 'vitest';
import { saveOrchestrationConfig } from '../../../src/orchestration/orchestration-config.js';
import { sendProgressUpdateToChannels } from '../../../src/server/modules/agent-status-subscriber-status.js';


function seedRuntimeNames(): void {
  saveOrchestrationConfig({
    version: 1,
    activeProfileId: 'default',
    profiles: [
      {
        id: 'default',
        name: 'Default',
        agents: [
          { targetAgentId: 'finger-system-agent', role: 'system', enabled: true },
          { targetAgentId: 'finger-project-agent', role: 'project', enabled: true },
        ],
      },
    ],
    runtime: {
      systemAgent: {
        id: 'finger-system-agent',
        name: 'Mirror',
        maxInstances: 1,
      },
      projectWorkers: {
        maxWorkers: 3,
        autoNameOnFirstAssign: true,
        nameCandidates: ['Alex', 'James', 'Robin'],
        workers: [
          { id: 'finger-project-agent', name: 'Alex', enabled: true },
          { id: 'finger-project-agent-02', name: 'James', enabled: true },
          { id: 'finger-project-agent-03', name: 'Robin', enabled: true },
        ],
      },
    },
  });
}

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
    seedRuntimeNames();
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
    expect(payload.content).toContain('👤 [project]');
    expect(payload.content).toContain('finger-project-agent-02');
    expect(payload.content).not.toContain('👤 [agent]');
  });

  it('renders grouped global status blocks with named worker identities', async () => {
    seedRuntimeNames();
    const routeToOutput = vi.fn().mockResolvedValue(undefined);
    const messageHub = {
      getOutputs: () => [{ id: 'channel-bridge-qqbot' }],
      routeToOutput,
    } as any;

    const deps = {
      sessionManager: {
        getSession: (id: string) => {
          if (id !== 'session-global-status') return null;
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
        sessionId: 'session-global-status',
        agentId: 'finger-project-agent',
        summary: '📊 08:10 | 执行中',
        progress: {
          status: 'running',
          toolCallsCount: 1,
          modelRoundsCount: 0,
          elapsedMs: 1000,
        },
        teamStatus: [
          {
            agentId: 'finger-system-agent',
            projectPath: '/Users/fanzhang/.finger/system',
            projectId: 'system',
            role: 'system',
            runtimeStatus: 'running',
            updatedAt: new Date().toISOString(),
          },
          {
            agentId: 'finger-project-agent',
            projectPath: '/Volumes/extension/code/finger',
            projectId: 'finger',
            role: 'project',
            runtimeStatus: 'running',
            updatedAt: new Date().toISOString(),
          },
          {
            agentId: 'finger-project-agent-02',
            projectPath: '/Volumes/extension/code/finger',
            projectId: 'finger',
            role: 'project',
            runtimeStatus: 'idle',
            updatedAt: new Date().toISOString(),
          },
        ],
      },
      primaryAgentId: 'finger-system-agent',
      lastProgressMailboxSummaryBySession: new Map<string, string>(),
      resolveEnvelopeMappings: () => [
        {
          sessionId: 'session-global-status',
          envelope: {
            channel: 'qqbot',
            envelopeId: 'env-global-status',
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
    const payload = routeToOutput.mock.calls[0]?.[1] as { content?: string };
    expect(payload.content).toContain('Global status');
    expect(payload.content).toContain('System Agent');
    expect(payload.content).toContain('Project finger');
    expect(payload.content).toContain('Mirror(finger-system-agent)');
    expect(payload.content).toContain('Alex(finger-project-agent)');
    expect(payload.content).toContain('James(finger-project-agent-02)');
  });
});
