import { describe, it, expect } from 'vitest';
import {
  EVENT_GROUPS,
  getSupportedEventTypes,
  getSupportedEventGroups,
  getEventTypesByGroup,
  isEventInGroup,
  isSessionEvent,
  isTaskEvent,
  isToolEvent,
  isDialogEvent,
  isProgressEvent,
  isPhaseEvent,
  isResourceEvent,
  isHumanInLoopEvent,
  isSystemEvent,
  type RuntimeEvent,
} from '../../../src/runtime/events.js';

describe('events', () => {
  describe('EVENT_GROUPS', () => {
    it('should contain ALL group', () => {
      expect(EVENT_GROUPS.ALL).toBeDefined();
      expect(Array.isArray(EVENT_GROUPS.ALL)).toBe(true);
    });

    it('should contain SESSION group', () => {
      expect(EVENT_GROUPS.SESSION).toBeDefined();
      expect(Array.isArray(EVENT_GROUPS.SESSION)).toBe(true);
    });

    it('should contain TASK group', () => {
      expect(EVENT_GROUPS.TASK).toBeDefined();
      expect(Array.isArray(EVENT_GROUPS.TASK)).toBe(true);
    });

    it('should contain TOOL group', () => {
      expect(EVENT_GROUPS.TOOL).toBeDefined();
      expect(Array.isArray(EVENT_GROUPS.TOOL)).toBe(true);
    });

    it('should contain DIALOG group', () => {
      expect(EVENT_GROUPS.DIALOG).toBeDefined();
      expect(Array.isArray(EVENT_GROUPS.DIALOG)).toBe(true);
    });

    it('should contain PROGRESS group', () => {
      expect(EVENT_GROUPS.PROGRESS).toBeDefined();
      expect(Array.isArray(EVENT_GROUPS.PROGRESS)).toBe(true);
    });

    it('should contain PHASE group', () => {
      expect(EVENT_GROUPS.PHASE).toBeDefined();
      expect(Array.isArray(EVENT_GROUPS.PHASE)).toBe(true);
    });

    it('should contain RESOURCE group', () => {
      expect(EVENT_GROUPS.RESOURCE).toBeDefined();
      expect(Array.isArray(EVENT_GROUPS.RESOURCE)).toBe(true);
    });

    it('should contain HUMAN_IN_LOOP group', () => {
      expect(EVENT_GROUPS.HUMAN_IN_LOOP).toBeDefined();
      expect(Array.isArray(EVENT_GROUPS.HUMAN_IN_LOOP)).toBe(true);
    });

    it('should contain SYSTEM group', () => {
      expect(EVENT_GROUPS.SYSTEM).toBeDefined();
      expect(Array.isArray(EVENT_GROUPS.SYSTEM)).toBe(true);
    });
  });

  describe('getSupportedEventTypes', () => {
    it('should return all event types', () => {
      const types = getSupportedEventTypes();
      expect(Array.isArray(types)).toBe(true);
      expect(types.length).toBeGreaterThan(0);
    });
  });

  describe('getSupportedEventGroups', () => {
    it('should return all group names', () => {
      const groups = getSupportedEventGroups();
      expect(groups).toContain('SESSION');
      expect(groups).toContain('TASK');
      expect(groups).toContain('TOOL');
      expect(groups).toContain('HUMAN_IN_LOOP');
    });
  });

  describe('getEventTypesByGroup', () => {
    it('should return types for SESSION group', () => {
      const types = getEventTypesByGroup('SESSION');
      expect(types).toContain('session_created');
      expect(types).toContain('session_resumed');
    });

    it('should return types for TASK group', () => {
      const types = getEventTypesByGroup('TASK');
      expect(types).toContain('task_started');
      expect(types).toContain('task_completed');
    });

    it('should return empty array for unknown group', () => {
      const types = getEventTypesByGroup('UNKNOWN' as never);
      expect(types).toEqual([]);
    });
  });

  describe('isEventInGroup', () => {
    it('should return true for event in group', () => {
      expect(isEventInGroup('task_started', 'TASK')).toBe(true);
      expect(isEventInGroup('session_created', 'SESSION')).toBe(true);
    });

    it('should return false for event not in group', () => {
      expect(isEventInGroup('task_started', 'SESSION')).toBe(false);
    });
  });

  describe('type guards', () => {
    it('isSessionEvent should identify session events', () => {
      const event = {
        type: 'session_created',
        sessionId: 's1',
        timestamp: new Date().toISOString(),
        payload: { name: 'Test', projectPath: '/test' },
      } as RuntimeEvent;
      expect(isSessionEvent(event)).toBe(true);
    });

    it('isTaskEvent should identify task events', () => {
      const event = {
        type: 'task_started',
        sessionId: 's1',
        taskId: 't1',
        timestamp: new Date().toISOString(),
        payload: { title: 'Test' },
      } as RuntimeEvent;
      expect(isTaskEvent(event)).toBe(true);
    });

    it('isToolEvent should identify tool events', () => {
      const event = {
        type: 'tool_call',
        sessionId: 's1',
        toolId: 'tool1',
        toolName: 'test_tool',
        agentId: 'a1',
        timestamp: new Date().toISOString(),
        payload: { input: {} },
      } as RuntimeEvent;
      expect(isToolEvent(event)).toBe(true);
    });

    it('isDialogEvent should identify dialog events', () => {
      const event = {
        type: 'user_message',
        sessionId: 's1',
        agentId: 'a1',
        timestamp: new Date().toISOString(),
        payload: { role: 'assistant', content: 'Hello' },
      } as RuntimeEvent;
      expect(isDialogEvent(event)).toBe(true);
    });

    it('isProgressEvent should identify progress events', () => {
      const event = {
        type: 'workflow_progress',
        sessionId: 's1',
        timestamp: new Date().toISOString(),
        payload: { progress: 50, phase: 'executing' },
      } as RuntimeEvent;
      expect(isProgressEvent(event)).toBe(true);
    });

    it('isPhaseEvent should identify phase events', () => {
      const event = {
        type: 'phase_transition',
        sessionId: 's1',
        timestamp: new Date().toISOString(),
        payload: { phase: 'planning' },
      } as RuntimeEvent;
      expect(isPhaseEvent(event)).toBe(true);
    });

    it('isResourceEvent should identify resource events', () => {
      const event = {
        type: 'resource_update',
        sessionId: 's1',
        timestamp: new Date().toISOString(),
        payload: { resourceId: 'r1', type: 'executor' },
      } as RuntimeEvent;
      expect(isResourceEvent(event)).toBe(true);
    });

    it('isHumanInLoopEvent should identify human-in-loop events', () => {
      const event = {
        type: 'waiting_for_user',
        sessionId: 's1',
        timestamp: new Date().toISOString(),
        payload: { prompt: 'Please confirm', options: [] },
      } as RuntimeEvent;
      expect(isHumanInLoopEvent(event)).toBe(true);
    });

    it('isSystemEvent should identify system events', () => {
      const event = {
        type: 'system_error',
        sessionId: 's1',
        timestamp: new Date().toISOString(),
        payload: { error: 'Something went wrong' },
      } as RuntimeEvent;
      expect(isSystemEvent(event)).toBe(true);
    });
  });
});
