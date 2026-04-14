/**
 * team-status-state.test.ts
 * Unit tests for team status state management
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

// Test helper functions from team-status-state.ts
const {
  loadTeamStatusStore,
  updateTeamAgentStatus,
  updateRuntimeStatus,
  filterTeamStatusByScope,
  syncTeamStatusFromPlan,
} = require('../../dist/common/team-status-state.js');

describe('Team Status State Management', () => {
  let tempDir: string;
  let originalStoreFile: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `team-status-test-${Date.now()}`);
    execSync(`mkdir -p ${tempDir}`);
    originalStoreFile = process.env.FINGER_TEAM_STATUS_STORE_FILE;
    process.env.FINGER_TEAM_STATUS_STORE_FILE = join(tempDir, 'team-status.json');
  });

  afterEach(() => {
    if (originalStoreFile) {
      process.env.FINGER_TEAM_STATUS_STORE_FILE = originalStoreFile;
    } else {
      delete process.env.FINGER_TEAM_STATUS_STORE_FILE;
    }
    execSync(`rm -rf ${tempDir}`);
  });

  describe('updateTeamAgentStatus', () => {
    it('should register new agent with basic info', () => {
      updateTeamAgentStatus('finger-test-agent', {
        agentId: 'finger-test-agent',
        projectPath: '/test/project',
        projectId: 'test-project',
        role: 'project',
      });

      const store = loadTeamStatusStore();
      expect(store.agents['finger-test-agent']).toBeDefined();
      expect(store.agents['finger-test-agent'].agentId).toBe('finger-test-agent');
      expect(store.agents['finger-test-agent'].projectPath).toBe('/test/project');
      expect(store.agents['finger-test-agent'].role).toBe('project');
    });

    it('should update existing agent without losing other fields', () => {
      // First registration
      updateTeamAgentStatus('finger-test-agent', {
        agentId: 'finger-test-agent',
        projectPath: '/test/project',
        projectId: 'test-project',
        role: 'project',
      });

      // Update runtime status
      updateRuntimeStatus({ agentId: 'finger-test-agent', runtimeStatus: 'running' });

      // Update again with basic info
      updateTeamAgentStatus('finger-test-agent', {
        agentId: 'finger-test-agent',
        projectPath: '/test/project',
        projectId: 'test-project',
        role: 'project',
      });

      const store = loadTeamStatusStore();
      expect(store.agents['finger-test-agent'].runtimeStatus).toBe('running');
    });
  });

  describe('updateRuntimeStatus', () => {
    it('should update runtime status for existing agent', () => {
      // Register first
      updateTeamAgentStatus('finger-test-agent', {
        agentId: 'finger-test-agent',
        projectPath: '/test/project',
        projectId: 'test-project',
        role: 'project',
      });

      // Update runtime status
      updateRuntimeStatus({ agentId: 'finger-test-agent', runtimeStatus: 'running' });

      const store = loadTeamStatusStore();
      expect(store.agents['finger-test-agent'].runtimeStatus).toBe('running');
    });
  });

  describe('filterTeamStatusByScope', () => {
    beforeEach(() => {
      // Setup test agents
      updateTeamAgentStatus('finger-system-agent', {
        agentId: 'finger-system-agent',
        projectPath: '/system',
        projectId: 'system',
        role: 'system',
      });

      updateTeamAgentStatus('finger-project-agent-1', {
        agentId: 'finger-project-agent-1',
        projectPath: '/project/A',
        projectId: 'project-A',
        role: 'project',
      });

      updateTeamAgentStatus('finger-project-agent-2', {
        agentId: 'finger-project-agent-2',
        projectPath: '/project/B',
        projectId: 'project-B',
        role: 'project',
      });
    });

    it('system agent should see all agents', () => {
      const store = loadTeamStatusStore();
      const visible = filterTeamStatusByScope(store, 'finger-system-agent', '/system', 'system');
      expect(visible.length).toBe(3);
    });

    it('project agent should see same project agents + system agent', () => {
      const store = loadTeamStatusStore();
      const visible = filterTeamStatusByScope(store, 'finger-project-agent-1', '/project/A', 'project');
      expect(visible.length).toBe(2); // system-agent + project-agent-1
      expect(visible.find(a => a.agentId === 'finger-system-agent')).toBeDefined();
      expect(visible.find(a => a.agentId === 'finger-project-agent-1')).toBeDefined();
      expect(visible.find(a => a.agentId === 'finger-project-agent-2')).toBeUndefined();
    });
  });

  describe('syncTeamStatusFromPlan', () => {
    it('should update planSummary for existing agent', () => {
      // Register first
      updateTeamAgentStatus('finger-test-agent', {
        agentId: 'finger-test-agent',
        projectPath: '/test/project',
        projectId: 'test-project',
        role: 'project',
      });

      // Sync plan summary
      syncTeamStatusFromPlan('finger-test-agent', '/test/project', undefined, {
        total: 5,
        completed: 2,
        inProgress: 1,
        blocked: 0,
        currentStep: 'Step 3: Implement feature',
        updatedAt: new Date().toISOString(),
      });

      const store = loadTeamStatusStore();
      expect(store.agents['finger-test-agent'].planSummary).toBeDefined();
      expect(store.agents['finger-test-agent'].planSummary?.total).toBe(5);
      expect(store.agents['finger-test-agent'].planSummary?.completed).toBe(2);
    });
  });
});
