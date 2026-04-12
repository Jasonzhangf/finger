import { describe, expect, it, vi } from 'vitest';
import { createOrchestrationConfigApplier } from '../../../src/server/modules/orchestration-config-applier.js';

describe('orchestration-config-applier', () => {
  it('does not deploy system agent (owned by SystemAgentManager)', async () => {
    const execute = vi.fn(async (command: string, payload?: Record<string, unknown>) => {
      if (command === 'runtime_view') {
        return { agents: [] };
      }
      return { success: true, payload };
    });

    const setCurrentSession = vi.fn(() => true);
    const ensureOrchestratorRootSession = vi.fn(() => ({
      id: 'root-session',
      projectPath: '/tmp/finger',
      sessionWorkspaceRoot: '/tmp/finger/ws',
      memoryDir: '/tmp/finger/ws/memory',
      deliverablesDir: '/tmp/finger/ws/deliverables',
      exchangeDir: '/tmp/finger/ws/exchange',
    }));
    const ensureRuntimeChildSession = vi.fn((_root: unknown, _agentId: string) => ({
      id: 'runtime-child',
      projectPath: '/tmp/finger',
    }));

    const apply = createOrchestrationConfigApplier({
      agentRuntimeBlock: { execute } as any,
      sessionManager: { setCurrentSession } as any,
      getLoadedAgentConfigs: vi.fn(() => [{ id: "finger-system-agent", instanceCount: 1 }, { id: "finger-project-agent", instanceCount: 2 }]),
      sessionWorkspaces: {
        ensureOrchestratorRootSession,
        ensureRuntimeChildSession,
        findRuntimeChildSession: vi.fn(() => null),
      } as any,
    });

    const result = await apply({
      version: 1,
      activeProfileId: 'default',
      profiles: [
        {
          id: 'default',
          name: 'Default',
          agents: [
            {
              targetAgentId: 'finger-system-agent',
              role: 'orchestrator',
              enabled: true,
              instanceCount: 1,
              launchMode: 'orchestrator',
            },
            {
              targetAgentId: 'finger-project-agent',
              role: 'executor',
              enabled: true,
              instanceCount: 1,
              launchMode: 'orchestrator',
            },
          ],
        },
      ],
    } as any);

    const deployCalls = execute.mock.calls.filter((call) => call[0] === 'deploy');
    const deployedAgentIds = deployCalls.map((call) => (call[1] as { targetAgentId?: string })?.targetAgentId);

    expect(deployedAgentIds).toContain('finger-project-agent');
    expect(deployedAgentIds).not.toContain('finger-system-agent');
    expect(result.agents).toContain('finger-system-agent');
    expect(result.agents).toContain('finger-project-agent');
    expect(setCurrentSession).toHaveBeenCalledWith('root-session');
  });
});

