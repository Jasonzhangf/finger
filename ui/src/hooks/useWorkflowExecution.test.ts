/**
 * useWorkflowExecution 状态掩码测试
 */

import { describe, it, expect } from 'vitest';
import {
  mapWorkflowFSMToStatus,
  mapTaskFSMToStatus,
  mapAgentFSMToStatus,
  applyStateMask,
  DEFAULT_STATE_MASK,
  type WorkflowFSMState,
  type TaskFSMState,
  type AgentFSMState,
} from '../api/types.js';

describe('FSM State Mapping', () => {
  describe('mapWorkflowFSMToStatus', () => {
    it('should map planning states correctly', () => {
      expect(mapWorkflowFSMToStatus('idle')).toBe('planning');
      expect(mapWorkflowFSMToStatus('semantic_understanding')).toBe('planning');
      expect(mapWorkflowFSMToStatus('routing_decision')).toBe('planning');
      expect(mapWorkflowFSMToStatus('plan_loop')).toBe('planning');
    });

    it('should map executing states correctly', () => {
      expect(mapWorkflowFSMToStatus('execution')).toBe('executing');
      expect(mapWorkflowFSMToStatus('review')).toBe('executing');
      expect(mapWorkflowFSMToStatus('replan_evaluation')).toBe('executing');
    });

    it('should map terminal states correctly', () => {
      expect(mapWorkflowFSMToStatus('completed')).toBe('completed');
      expect(mapWorkflowFSMToStatus('failed')).toBe('failed');
    });

    it('should map paused states correctly', () => {
      expect(mapWorkflowFSMToStatus('paused')).toBe('paused');
      expect(mapWorkflowFSMToStatus('wait_user_decision')).toBe('paused');
    });
  });

  describe('mapTaskFSMToStatus', () => {
    it('should map ready states correctly', () => {
      expect(mapTaskFSMToStatus('created')).toBe('ready');
      expect(mapTaskFSMToStatus('ready')).toBe('ready');
    });

    it('should map in_progress states correctly', () => {
      expect(mapTaskFSMToStatus('dispatching')).toBe('in_progress');
      expect(mapTaskFSMToStatus('dispatched')).toBe('in_progress');
      expect(mapTaskFSMToStatus('running')).toBe('in_progress');
    });

    it('should map completed states correctly', () => {
      expect(mapTaskFSMToStatus('execution_succeeded')).toBe('completed');
      expect(mapTaskFSMToStatus('reviewing')).toBe('completed');
      expect(mapTaskFSMToStatus('done')).toBe('completed');
    });

    it('should map failed/blocked states correctly', () => {
      expect(mapTaskFSMToStatus('dispatch_failed')).toBe('blocked');
      expect(mapTaskFSMToStatus('execution_failed')).toBe('failed');
      expect(mapTaskFSMToStatus('rework_required')).toBe('blocked');
      expect(mapTaskFSMToStatus('blocked')).toBe('blocked');
    });
  });

  describe('mapAgentFSMToStatus', () => {
    it('should map idle states correctly', () => {
      expect(mapAgentFSMToStatus('idle')).toBe('idle');
      expect(mapAgentFSMToStatus('released')).toBe('idle');
    });

    it('should map running states correctly', () => {
      expect(mapAgentFSMToStatus('reserved')).toBe('running');
      expect(mapAgentFSMToStatus('running')).toBe('running');
    });

    it('should map error states correctly', () => {
      expect(mapAgentFSMToStatus('error')).toBe('error');
    });
  });
});

describe('State Mask', () => {
  describe('applyStateMask for workflow', () => {
    it('should hide semantic_understanding state', () => {
      const result = applyStateMask('semantic_understanding', DEFAULT_STATE_MASK, 'workflow');
      expect(result).toBeNull();
    });

    it('should hide routing_decision state', () => {
      const result = applyStateMask('routing_decision', DEFAULT_STATE_MASK, 'workflow');
      expect(result).toBeNull();
    });

    it('should show execution state', () => {
      const result = applyStateMask('execution', DEFAULT_STATE_MASK, 'workflow');
      expect(result).toBe('execution');
    });

    it('should show plan_loop state', () => {
      const result = applyStateMask('plan_loop', DEFAULT_STATE_MASK, 'workflow');
      expect(result).toBe('plan_loop');
    });
  });

  describe('applyStateMask for task', () => {
    it('should hide dispatching state', () => {
      const result = applyStateMask('dispatching', DEFAULT_STATE_MASK, 'task');
      expect(result).toBeNull();
    });

    it('should hide dispatched state', () => {
      const result = applyStateMask('dispatched', DEFAULT_STATE_MASK, 'task');
      expect(result).toBeNull();
    });

    it('should hide execution_succeeded state', () => {
      const result = applyStateMask('execution_succeeded', DEFAULT_STATE_MASK, 'task');
      expect(result).toBeNull();
    });

    it('should map running to in_progress', () => {
      const result = applyStateMask('running', DEFAULT_STATE_MASK, 'task');
      expect(result).toBe('in_progress');
    });

    it('should map done to completed', () => {
      const result = applyStateMask('done', DEFAULT_STATE_MASK, 'task');
      expect(result).toBe('completed');
    });
  });

  describe('applyStateMask for agent', () => {
    it('should hide reserved state', () => {
      const result = applyStateMask('reserved', DEFAULT_STATE_MASK, 'agent');
      expect(result).toBeNull();
    });

    it('should hide released state', () => {
      const result = applyStateMask('released', DEFAULT_STATE_MASK, 'agent');
      expect(result).toBeNull();
    });

    it('should show running state', () => {
      const result = applyStateMask('running', DEFAULT_STATE_MASK, 'agent');
      expect(result).toBe('running');
    });
  });

  describe('Custom mask configuration', () => {
    it('should support custom hide list', () => {
      const customMask = {
        ...DEFAULT_STATE_MASK,
        workflowStates: {
          ...DEFAULT_STATE_MASK.workflowStates,
          hide: ['semantic_understanding', 'routing_decision', 'plan_loop'],
        },
      };

      expect(applyStateMask('plan_loop', customMask, 'workflow')).toBeNull();
      expect(applyStateMask('execution', customMask, 'workflow')).toBe('execution');
    });

    it('should support showDetailedStates mode', () => {
      const detailedMask = {
        ...DEFAULT_STATE_MASK,
        showDetailedStates: true,
        workflowStates: {
          hide: [], // 详细模式下不隐藏任何状态
          showAs: {},
        },
      };

      expect(applyStateMask('semantic_understanding', detailedMask, 'workflow')).toBe('semantic_understanding');
      expect(applyStateMask('routing_decision', detailedMask, 'workflow')).toBe('routing_decision');
    });
  });
});
