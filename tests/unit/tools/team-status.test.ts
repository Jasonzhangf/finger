/**
 * team.status Unit Tests
 *
 * 测试 team-status-state.ts 的所有函数：
 * - loadTeamStatusStore / saveTeamStatusStore
 * - updateTeamAgentStatus
 * - updateRuntimeStatus
 * - removeTeamAgentStatus
 * - filterTeamStatusByScope
 * - syncTeamStatusFromPlan
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('team-status-state', () => {
  let tempHome = '';
  let teamStatusState: typeof import('../../../src/common/team-status-state.js');

  beforeEach(async () => {
    vi.resetModules();
    const { promises: fs } = await import('fs');
    const { tmpdir } = await import('os');
    const path = await import('path');
    tempHome = await fs.mkdtemp(path.join(tmpdir(), 'finger-team-status-test-'));
    
    // Mock FINGER_HOME
    vi.doMock('../../../src/core/finger-paths.js', async () => {
      const actual = await vi.importActual<typeof import('../../../src/core/finger-paths.js')>(
        '../../../src/core/finger-paths.js',
      );
      return {
        ...actual,
        FINGER_HOME: tempHome,
        FINGER_PATHS: actual.getFingerPaths(tempHome),
        resolveFingerHome: () => tempHome,
      };
    });

    // Import after mock
    teamStatusState = await import('../../../src/common/team-status-state.js');
    
    // 创建 system 子目录
    const { promises: fs2 } = await import('fs');
    const path2 = await import('path');
    await fs2.mkdir(path2.join(tempHome, 'system'), { recursive: true });
  });

  afterEach(async () => {
    try {
      const { promises: fs } = await import('fs');
      await fs.rm(tempHome, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    vi.doUnmock('../../../src/core/finger-paths.js');
  });

  describe('loadTeamStatusStore / saveTeamStatusStore', () => {
    it('should create empty store if not exists', () => {
      const store = teamStatusState.loadTeamStatusStore();
      expect(store.version).toBe(1);
      expect(store.agents).toEqual({});
    });

    it('should persist and load store', async () => {
      const store: teamStatusState.TeamStatusStore = {
        version: 1,
        lastUpdate: new Date().toISOString(),
        agents: {
          'test-agent': {
            agentId: 'test-agent',
            projectId: 'test-project',
            projectPath: '/test/path',
            role: 'project',
            runtimeStatus: 'idle',
            updatedAt: new Date().toISOString(),
          },
        },
      };
      teamStatusState.saveTeamStatusStore(store);
      const loaded = teamStatusState.loadTeamStatusStore();
      expect(loaded.agents['test-agent']).toBeDefined();
      expect(loaded.agents['test-agent'].runtimeStatus).toBe('idle');
    });
  });

  describe('updateTeamAgentStatus', () => {
    it('should create new agent status', () => {
      const result = teamStatusState.updateTeamAgentStatus('new-agent', {
        agentId: 'new-agent',
        projectPath: '/new/path',
        projectId: 'new-project',
      });
      expect(result.agentId).toBe('new-agent');
      expect(result.projectPath).toBe('/new/path');
      expect(result.runtimeStatus).toBe('idle'); // default
    });

    it('should update existing agent status', async () => {
      // First create
      teamStatusState.updateTeamAgentStatus('existing-agent', {
        agentId: 'existing-agent',
        projectPath: '/existing/path',
        projectId: 'existing-project',
      });
      // Then update with planSummary
      const planSummary: teamStatusState.PlanSummary = {
        total: 5,
        completed: 2,
        inProgress: 1,
        blocked: 0,
        currentStep: 'step-3',
        updatedAt: new Date().toISOString(),
      };
      const result = teamStatusState.updateTeamAgentStatus('existing-agent', {
        agentId: 'existing-agent',
        projectPath: '/existing/path',
        projectId: 'existing-project',
        planSummary,
      });
      expect(result.planSummary).toBeDefined();
      expect(result.planSummary?.total).toBe(5);
    });
  });

  describe('updateRuntimeStatus', () => {
    it('should update runtimeStatus for existing agent', () => {
      // First create agent
      teamStatusState.updateTeamAgentStatus('runtime-test', {
        agentId: 'runtime-test',
        projectPath: '/runtime/test',
        projectId: 'runtime-project',
      });
      // Then update runtimeStatus
      const result = teamStatusState.updateRuntimeStatus({
        agentId: 'runtime-test',
        runtimeStatus: 'running',
        lastDispatchId: 'dispatch-123',
        lastTaskId: 'task-456',
        lastTaskName: 'test task',
      });
      expect(result).toBeDefined();
      expect(result?.runtimeStatus).toBe('running');
      expect(result?.lastDispatchId).toBe('dispatch-123');
    });

    it('should return null if agent not found', () => {
      const result = teamStatusState.updateRuntimeStatus({
        agentId: 'non-existent',
        runtimeStatus: 'running',
      });
      expect(result).toBeNull();
    });
  });

  describe('removeTeamAgentStatus', () => {
    it('should remove existing agent', () => {
      // First create
      teamStatusState.updateTeamAgentStatus('remove-test', {
        agentId: 'remove-test',
        projectPath: '/remove/test',
        projectId: 'remove-project',
      });
      // Then remove
      const result = teamStatusState.removeTeamAgentStatus('remove-test');
      expect(result).toBe(true);
      // Verify removed
      const store = teamStatusState.loadTeamStatusStore();
      expect(store.agents['remove-test']).toBeUndefined();
    });

    it('should return false if agent not found', () => {
      const result = teamStatusState.removeTeamAgentStatus('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('filterTeamStatusByScope', () => {
    beforeEach(() => {
      // 创建干净的测试数据
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
        projectPath: '/project/A',
        projectId: 'project-A',
        role: 'project',
      });
      teamStatusState.updateTeamAgentStatus('project-agent-3', {
        agentId: 'project-agent-3',
        projectPath: '/project/B',
        projectId: 'project-B',
        role: 'project',
      });
    });

    it('should return all agents for system viewer', () => {
      const store = teamStatusState.loadTeamStatusStore();
      const result = teamStatusState.filterTeamStatusByScope(
        store,
        'system-agent',
        '/global',
        'system'
      );
      // 只有 4 个 agents
      expect(result.length).toBe(4);
    });

    it('should return same-project agents + system agent for project viewer', () => {
      const store = teamStatusState.loadTeamStatusStore();
      const result = teamStatusState.filterTeamStatusByScope(
        store,
        'project-agent-1',
        '/project/A',
        'project'
      );
      // Should see: system-agent, project-agent-1, project-agent-2
      expect(result.length).toBe(3);
      expect(result.find(a => a.agentId === 'system-agent')).toBeDefined();
      expect(result.find(a => a.agentId === 'project-agent-1')).toBeDefined();
      expect(result.find(a => a.agentId === 'project-agent-2')).toBeDefined();
      // Should NOT see project-agent-3 (different project)
      expect(result.find(a => a.agentId === 'project-agent-3')).toBeUndefined();
    });
  });

  describe('syncTeamStatusFromPlan', () => {
    it('should sync planSummary to team status', () => {
      // First create agent
      teamStatusState.updateTeamAgentStatus('plan-sync-test', {
        agentId: 'plan-sync-test',
        projectPath: '/plan/sync',
        projectId: 'plan-sync',
      });
      // Sync plan
      const planSummary: teamStatusState.PlanSummary = {
        total: 10,
        completed: 3,
        inProgress: 2,
        blocked: 1,
        currentStep: 'implementing feature X',
        updatedAt: new Date().toISOString(),
      };
      teamStatusState.syncTeamStatusFromPlan('plan-sync-test', '/plan/sync', undefined, planSummary);
      // Verify
      const store = teamStatusState.loadTeamStatusStore();
      expect(store.agents['plan-sync-test'].planSummary).toBeDefined();
      expect(store.agents['plan-sync-test'].planSummary?.total).toBe(10);
    });
  });
});
