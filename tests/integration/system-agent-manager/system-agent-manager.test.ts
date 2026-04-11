import { describe, it, expect } from 'vitest';

describe('System Agent Manager Recovery Tests', () => {
  describe('parseProjectTaskState', () => {
    it('解析有效对象', async () => {
      const mod = await import('../../../src/common/project-task-state.js');
      const obj = { taskId: 'finger-288.1', status: 'in_progress', updatedAt: new Date().toISOString(), active: true, targetAgentId: mod.PROJECT_AGENT_ID };
      const result = mod.parseProjectTaskState(obj);
      expect(result?.taskId).toBe('finger-288.1');
    });
    it('无效类型', async () => {
      const mod = await import('../../../src/common/project-task-state.js');
      expect(mod.parseProjectTaskState('not json')).toBeNull();
    });
  });

  describe('isProjectTaskStateActive', () => {
    it('active true', async () => {
      const mod = await import('../../../src/common/project-task-state.js');
      const state = { taskId: 't1', status: 'in_progress', updatedAt: new Date().toISOString(), active: true, targetAgentId: mod.PROJECT_AGENT_ID };
      expect(mod.isProjectTaskStateActive(state)).toBe(true);
    });
    it('active false', async () => {
      const mod = await import('../../../src/common/project-task-state.js');
      const state = { taskId: 't1', status: 'in_progress', updatedAt: new Date().toISOString(), active: false, targetAgentId: mod.PROJECT_AGENT_ID };
      expect(mod.isProjectTaskStateActive(state)).toBe(false);
    });
    it('null', async () => {
      const mod = await import('../../../src/common/project-task-state.js');
      expect(mod.isProjectTaskStateActive(null)).toBe(false);
    });
  });
});
