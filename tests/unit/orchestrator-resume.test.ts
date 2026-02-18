/**
 * Orchestrator Resume Logic 单元测试
 */

import { describe, it, expect } from 'vitest';
import {
  isValidPhaseTransition,
  buildRecoveryContext,
  generateResumePrompt,
  shouldCheckpointAtPhase,
  PHASE_TRANSITIONS,
  type OrchestratorPhase,
} from '../../src/agents/daemon/orchestrator-resume.js';
import { determineResumePhase } from '../../src/orchestration/resumable-session.js';
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
    
    it('returns phaseHistory latest phase when available', () => {
      const checkpoint = {
        failedTaskIds: [],
        taskProgress: [{ taskId: 'task-1', status: 'pending', description: 'Test' }],
        completedTaskIds: [],
        pendingTaskIds: ['task-1'],
        context: { phase: 'understanding' },
        phaseHistory: [
          { phase: 'understanding', timestamp: '2024-01-01T00:00:00Z', action: 'start' },
          { phase: 'high_design', timestamp: '2024-01-01T00:01:00Z', action: 'design_completed' },
        ],
      } as unknown as SessionCheckpoint;
      
      expect(determineResumePhase(checkpoint)).toBe('high_design');
    });
    
    it('prefers phaseHistory over context.phase', () => {
      const checkpoint = {
        failedTaskIds: [],
        taskProgress: [{ taskId: 'task-1', status: 'pending', description: 'Test' }],
        completedTaskIds: [],
        pendingTaskIds: ['task-1'],
        context: { phase: 'plan' },
        phaseHistory: [{ phase: 'high_design', timestamp: '2024-01-01T00:00:00Z', action: 'design' }],
      } as unknown as SessionCheckpoint;
      
      // Should prefer checkpoint.phaseHistory over context.phaseHistory
      expect(determineResumePhase(checkpoint)).toBe('high_design');
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
