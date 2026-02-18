/**
 * Orchestrator Resume Logic 单元测试
 */

import { describe, it, expect } from 'vitest';
import {
  isValidPhaseTransition,
  determineResumePhase,
  buildRecoveryContext,
  generateResumePrompt,
  shouldCheckpointAtPhase,
  PHASE_TRANSITIONS,
  type OrchestratorPhase,
} from '../../src/agents/daemon/orchestrator-resume.js';
import type { SessionCheckpoint } from '../../src/orchestration/resumable-session.js';

describe('Orchestrator Resume Logic', () => {
  describe('isValidPhaseTransition', () => {
    it('allows same phase', () => {
      expect(isValidPhaseTransition('plan', 'plan')).toBe(true);
    });

    it('allows valid forward transitions', () => {
      expect(isValidPhaseTransition('understanding', 'high_design')).toBe(true);
      expect(isValidPhaseTransition('high_design', 'detail_design')).toBe(true);
      expect(isValidPhaseTransition('detail_design', 'deliverables')).toBe(true);
      expect(isValidPhaseTransition('deliverables', 'plan')).toBe(true);
      expect(isValidPhaseTransition('plan', 'parallel_dispatch')).toBe(true);
      expect(isValidPhaseTransition('parallel_dispatch', 'blocked_review')).toBe(true);
      expect(isValidPhaseTransition('blocked_review', 'verify')).toBe(true);
      expect(isValidPhaseTransition('verify', 'completed')).toBe(true);
    });

    it('allows replanning from any phase', () => {
      const phases: OrchestratorPhase[] = ['understanding', 'high_design', 'detail_design', 'plan', 'parallel_dispatch', 'blocked_review', 'verify'];
      for (const phase of phases) {
        expect(isValidPhaseTransition(phase, 'replanning')).toBe(true);
      }
    });

    it('blocks invalid transitions', () => {
      expect(isValidPhaseTransition('verify', 'understanding')).toBe(false);
      expect(isValidPhaseTransition('completed', 'plan')).toBe(false);
      expect(isValidPhaseTransition('high_design', 'verify')).toBe(false);
    });
  });

  describe('PHASE_TRANSITIONS structure', () => {
    it('has all phases defined', () => {
      const expectedPhases: OrchestratorPhase[] = [
        'understanding', 'high_design', 'detail_design', 'deliverables',
        'plan', 'parallel_dispatch', 'blocked_review', 'verify',
        'completed', 'failed', 'replanning',
      ];
      for (const phase of expectedPhases) {
        expect(PHASE_TRANSITIONS[phase]).toBeDefined();
      }
    });
  });

  describe('determineResumePhase', () => {
    it('returns plan when there are failed tasks', () => {
      const checkpoint = {
        failedTaskIds: ['task-1'],
        taskProgress: [],
        completedTaskIds: [],
        pendingTaskIds: [],
        context: {},
      } as unknown as SessionCheckpoint;
      
      expect(determineResumePhase(checkpoint)).toBe('plan');
    });

    it('returns parallel_dispatch when there are in-progress tasks', () => {
      const checkpoint = {
        failedTaskIds: [],
        taskProgress: [
          { taskId: 'task-1', status: 'in_progress', description: 'Test' },
        ],
        completedTaskIds: [],
        pendingTaskIds: [],
        context: {},
      } as unknown as SessionCheckpoint;
      
      expect(determineResumePhase(checkpoint)).toBe('parallel_dispatch');
    });

    it('returns verify when all tasks completed', () => {
      const checkpoint = {
        failedTaskIds: [],
        taskProgress: [
          { taskId: 'task-1', status: 'completed', description: 'Test' },
        ],
        completedTaskIds: ['task-1'],
        pendingTaskIds: [],
        context: {},
      } as unknown as SessionCheckpoint;
      
      expect(determineResumePhase(checkpoint)).toBe('verify');
    });

    it('returns saved phase from context otherwise', () => {
      const checkpoint = {
        failedTaskIds: [],
        taskProgress: [],
        completedTaskIds: [],
        pendingTaskIds: ['task-1'],
        context: { phase: 'detail_design' },
      } as unknown as SessionCheckpoint;
      
      expect(determineResumePhase(checkpoint)).toBe('detail_design');
    });
  });

  describe('buildRecoveryContext', () => {
    it('builds correct recovery context', () => {
      const checkpoint = {
        failedTaskIds: ['failed-1'],
        completedTaskIds: ['completed-1'],
        pendingTaskIds: ['pending-1'],
        taskProgress: [
          { taskId: 'failed-1', status: 'failed', description: 'Failed Task' },
          { taskId: 'completed-1', status: 'completed', description: 'Done Task' },
        ],
        context: {},
      } as unknown as SessionCheckpoint;
      
      const context = buildRecoveryContext(checkpoint);
      
      expect(context.fromCheckpoint).toBe(true);
      expect(context.skipCompletedTasks).toContain('completed-1');
      expect(context.retryFailedTasks).toContain('failed-1');
    });
  });

  describe('generateResumePrompt', () => {
    it('includes all context information', () => {
      const recoveryContext = {
        fromCheckpoint: true,
        resumePhase: 'plan' as const,
        skipCompletedTasks: ['task-1'],
        retryFailedTasks: ['task-2'],
        preservedDesign: {
          architecture: 'Test Architecture',
          modules: ['mod1', 'mod2'],
        },
      };
      
      const prompt = generateResumePrompt(recoveryContext, 'Test Task');
      
      expect(prompt).toContain('Test Task');
      expect(prompt).toContain('plan');
      expect(prompt).toContain('task-1');
      expect(prompt).toContain('task-2');
      expect(prompt).toContain('Test Architecture');
    });
  });

  describe('shouldCheckpointAtPhase', () => {
    it('returns true for checkpoint phases', () => {
      const checkpointPhases: OrchestratorPhase[] = [
        'understanding', 'high_design', 'detail_design', 'deliverables',
        'plan', 'blocked_review', 'verify',
      ];
      for (const phase of checkpointPhases) {
        expect(shouldCheckpointAtPhase(phase)).toBe(true);
      }
    });

    it('returns false for non-checkpoint phases', () => {
      expect(shouldCheckpointAtPhase('parallel_dispatch')).toBe(false);
      expect(shouldCheckpointAtPhase('completed')).toBe(false);
      expect(shouldCheckpointAtPhase('replanning')).toBe(false);
    });
  });
});
