/**
 * team.status Integration Tests
 *
 * 测试 team.status 工具在实际 ToolRegistry 环境中的行为
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('team-status integration', () => {
  let tempHome = '';
  let ToolRegistry: typeof import('../../src/runtime/tool-registry.js').ToolRegistry;
  let registerTeamStatusTool: typeof import('../../src/tools/internal/team-status-tool.js').registerTeamStatusTool;
  let teamStatusState: typeof import('../../src/common/team-status-state.js');

  beforeEach(async () => {
    vi.resetModules();
    const { promises: fs } = await import('fs');
    const { tmpdir } = await import('os');
    const path = await import('path');
    tempHome = await fs.mkdtemp(path.join(tmpdir(), 'finger-team-status-integration-'));
    
    vi.doMock('../../src/core/finger-paths.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/core/finger-paths.js')>(
        '../../src/core/finger-paths.js',
      );
      return {
        ...actual,
        FINGER_HOME: tempHome,
        FINGER_PATHS: actual.getFingerPaths(tempHome),
        resolveFingerHome: () => tempHome,
      };
    });

    ToolRegistry = await import('../../src/runtime/tool-registry.js');
    registerTeamStatusTool = await import('../../src/tools/internal/team-status-tool.js');
    teamStatusState = await import('../../src/common/team-status-state.js');
    
    const { promises: fs2 } = await import('fs');
    const path2 = await import('path');
    await fs2.mkdir(path2.join(tempHome, 'system'), { recursive: true });
  });

  afterEach(async () => {
    try {
      const { promises: fs } = await import('fs');
      await fs.rm(tempHome, { recursive: true, force: true });
    } catch {}
    vi.doUnmock('../../src/core/finger-paths.js');
  });

  describe('I1: team.status tool status action', () => {
    it('should return team status filtered by scope', async () => {
      teamStatusState.updateTeamAgentStatus('system-agent', {
        agentId: 'system-agent',
        projectPath: '/global',
        projectId: 'system',
        role: 'system',
      });
      teamStatusState.updateTeamAgentStatus('project-agent-1', {
        agentId: 'project-agent-1',
        projectPath: '/project/A',
        projectId: 'project-A',
        role: 'project',
      });

      const registry = new ToolRegistry.ToolRegistry({ internalRegistry: undefined, tools: [] });
      registerTeamStatusTool.registerTeamStatusTool(registry, () => ({
        agentId: 'project-agent-1',
        projectPath: '/project/A',
        role: 'project',
      }) as any);

      const result = await registry.execute('team.status', { action: 'status' });

      expect(result.ok).toBe(true);
      expect(result.agents).toBeDefined();
      expect(result.agents.length).toBe(2);
    });

    it('should return all agents for system viewer', async () => {
      teamStatusState.updateTeamAgentStatus('system-agent', {
        agentId: 'system-agent',
        projectPath: '/global',
        projectId: 'system',
        role: 'system',
      });
      teamStatusState.updateTeamAgentStatus('project-agent-1', {
        agentId: 'project-agent-1',
        projectPath: '/project/A',
        projectId: 'project-A',
        role: 'project',
      });
      teamStatusState.updateTeamAgentStatus('project-agent-2', {
        agentId: 'project-agent-2',
        projectPath: '/project/B',
        projectId: 'project-B',
        role: 'project',
      });

      const registry = new ToolRegistry.ToolRegistry({ internalRegistry: undefined, tools: [] });
      registerTeamStatusTool.registerTeamStatusTool(registry, () => ({
        agentId: 'finger-system-agent',
        projectPath: '/global',
        role: 'system',
      }) as any);

      const result = await registry.execute('team.status', { action: 'status' });

      expect(result.ok).toBe(true);
      expect(result.agents.length).toBe(3);
    });
  });

  describe('I2: team.status tool update action', () => {
    it('should update own planSummary', async () => {
      teamStatusState.updateTeamAgentStatus('project-agent-1', {
        agentId: 'project-agent-1',
        projectPath: '/project/A',
        projectId: 'project-A',
        role: 'project',
      });

      const registry = new ToolRegistry.ToolRegistry({ internalRegistry: undefined, tools: [] });
      registerTeamStatusTool.registerTeamStatusTool(registry, () => ({
        agentId: 'project-agent-1',
        projectPath: '/project/A',
        role: 'project',
      }) as any);

      const result = await registry.execute('team.status', {
        action: 'update',
        planSummary: {
          total: 5,
          completed: 2,
          inProgress: 1,
          blocked: 0,
          currentStep: 'testing',
          updatedAt: new Date().toISOString(),
        },
      });

      expect(result.ok).toBe(true);
      expect(result.self.agentId).toBe('project-agent-1');

      const store = teamStatusState.loadTeamStatusStore();
      expect(store.agents['project-agent-1'].planSummary?.total).toBe(5);
    });

    it('should reject update for different agentId', async () => {
      teamStatusState.updateTeamAgentStatus('project-agent-1', {
        agentId: 'project-agent-1',
        projectPath: '/project/A',
        projectId: 'project-A',
        role: 'project',
      });
      teamStatusState.updateTeamAgentStatus('project-agent-2', {
        agentId: 'project-agent-2',
        projectPath: '/project/A',
        projectId: 'project-A',
        role: 'project',
      });

      const registry = new ToolRegistry.ToolRegistry({ internalRegistry: undefined, tools: [] });
      registerTeamStatusTool.registerTeamStatusTool(registry, () => ({
        agentId: 'project-agent-1',
        projectPath: '/project/A',
        role: 'project',
      }) as any);

      const result = await registry.execute('team.status', {
        action: 'update',
        agentId: 'project-agent-2',
        planSummary: {
          total: 10,
          completed: 5,
          inProgress: 2,
          blocked: 1,
          currentStep: 'hack',
          updatedAt: new Date().toISOString(),
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain('can only update own status');
    });
  });

  describe('I3: PeriodicCheckRunner updates team.status', () => {
    it('should update runtimeStatus when agent status changes', async () => {
      teamStatusState.updateTeamAgentStatus('project-agent-1', {
        agentId: 'project-agent-1',
        projectPath: '/project/A',
        projectId: 'project-A',
        role: 'project',
        runtimeStatus: 'idle',
      });

      const result = teamStatusState.updateRuntimeStatus({
        agentId: 'project-agent-1',
        runtimeStatus: 'running',
        lastDispatchId: 'dispatch-123',
        lastTaskId: 'task-456',
        lastTaskName: 'implementing feature',
      });

      expect(result).toBeDefined();
      expect(result?.runtimeStatus).toBe('running');

      const store = teamStatusState.loadTeamStatusStore();
      expect(store.agents['project-agent-1'].runtimeStatus).toBe('running');
    });
  });

  describe('I5: unregister removes team.status', () => {
    it('should cleanup team.status when agent is unregistered', async () => {
      teamStatusState.updateTeamAgentStatus('project-agent-1', {
        agentId: 'project-agent-1',
        projectPath: '/project/A',
        projectId: 'project-A',
        role: 'project',
      });

      const result = teamStatusState.removeTeamAgentStatus('project-agent-1');
      expect(result).toBe(true);

      const store = teamStatusState.loadTeamStatusStore();
      expect(store.agents['project-agent-1']).toBeUndefined();
    });
  });
});
