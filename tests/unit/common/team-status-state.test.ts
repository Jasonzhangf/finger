import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync, readFileSync } from 'fs';

function loadModule() {
  const mod = require(require('path').resolve(__dirname, '../../../dist/common/team-status-state.js'));
  return mod;
}

describe('Team Status State Management', () => {
  let tempDir: string;
  let mod: ReturnType<typeof loadModule>;

  beforeEach(() => {
    tempDir = join(tmpdir(), 'team-status-test-' + Date.now());
    mkdirSync(tempDir, { recursive: true });
    process.env.FINGER_TEAM_STATUS_STORE_FILE = join(tempDir, 'team-status.json');
    mod = loadModule();
  });

  afterEach(() => {
    delete process.env.FINGER_TEAM_STATUS_STORE_FILE;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should register new agent', () => {
    mod.updateTeamAgentStatus('test-agent', {
      agentId: 'test-agent',
      projectPath: '/test',
      projectId: 'test',
      role: 'project',
    });
    const store = mod.loadTeamStatusStore();
    expect(store.agents['test-agent']).toBeDefined();
    expect(store.agents['test-agent'].role).toBe('project');
  });

  it('should update runtime status', () => {
    mod.updateTeamAgentStatus('test-agent', {
      agentId: 'test-agent',
      projectPath: '/test',
      projectId: 'test',
      role: 'project',
    });
    mod.updateRuntimeStatus({ agentId: 'test-agent', runtimeStatus: 'running' });
    const store = mod.loadTeamStatusStore();
    expect(store.agents['test-agent'].runtimeStatus).toBe('running');
  });

  it('system agent sees all agents via scope filter', () => {
    mod.updateTeamAgentStatus('system-agent', {
      agentId: 'system-agent', projectPath: '/system', projectId: 'system', role: 'system',
    });
    mod.updateTeamAgentStatus('project-agent', {
      agentId: 'project-agent', projectPath: '/project', projectId: 'project', role: 'project',
    });
    const store = mod.loadTeamStatusStore();
    // Check that both agents are present (may have leftover from previous tests in same process)
    expect(store.agents['system-agent']).toBeDefined();
    expect(store.agents['project-agent']).toBeDefined();
    // System agent sees all agents present in the store
    const visible = mod.filterTeamStatusByScope(store, 'system-agent', '/system', 'system');
    expect(visible.find(a => a.agentId === 'system-agent')).toBeDefined();
    expect(visible.find(a => a.agentId === 'project-agent')).toBeDefined();
  });

  it('project agent sees same-project + system only', () => {
    mod.updateTeamAgentStatus('system-agent', {
      agentId: 'system-agent', projectPath: '/system', projectId: 'system', role: 'system',
    });
    mod.updateTeamAgentStatus('project-a-agent', {
      agentId: 'project-a-agent', projectPath: '/projectA', projectId: 'projectA', role: 'project',
    });
    mod.updateTeamAgentStatus('project-b-agent', {
      agentId: 'project-b-agent', projectPath: '/projectB', projectId: 'projectB', role: 'project',
    });
    const store = mod.loadTeamStatusStore();
    const visible = mod.filterTeamStatusByScope(store, 'project-a-agent', '/projectA', 'project');
    expect(visible.length).toBe(2);
    expect(visible.find(a => a.agentId === 'system-agent')).toBeDefined();
    expect(visible.find(a => a.agentId === 'project-a-agent')).toBeDefined();
    expect(visible.find(a => a.agentId === 'project-b-agent')).toBeUndefined();
  });

  it('should sync plan summary', () => {
    mod.updateTeamAgentStatus('test-agent', {
      agentId: 'test-agent', projectPath: '/test', projectId: 'test', role: 'project',
    });
    mod.syncTeamStatusFromPlan('test-agent', '/test', undefined, {
      total: 5, completed: 2, inProgress: 1, blocked: 0,
      currentStep: 'Step 3', updatedAt: new Date().toISOString(),
    });
    const store = mod.loadTeamStatusStore();
    expect(store.agents['test-agent'].planSummary.total).toBe(5);
    expect(store.agents['test-agent'].planSummary.completed).toBe(2);
  });


  it('should preserve fields across updates', () => {
    mod.updateTeamAgentStatus('test-agent', {
      agentId: 'test-agent', projectPath: '/test', projectId: 'test', role: 'project',
    });
    mod.updateRuntimeStatus({ agentId: 'test-agent', runtimeStatus: 'running' });
    mod.syncTeamStatusFromPlan('test-agent', '/test', undefined, {
      total: 3, completed: 1, inProgress: 1, blocked: 1,
      currentStep: 'X', updatedAt: new Date().toISOString(),
    });
    mod.updateTeamAgentStatus('test-agent', {
      agentId: 'test-agent', projectPath: '/test', projectId: 'test', role: 'project',
    });
    const store = mod.loadTeamStatusStore();
    expect(store.agents['test-agent'].runtimeStatus).toBe('running');
    expect(store.agents['test-agent'].planSummary.total).toBe(3);
  });
});
