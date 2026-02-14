import { describe, it, expect, beforeEach } from 'vitest';
import { TaskStateMachine } from '../../src/app/task-state-machine.js';
import type { Task } from '../../src/core/types.js';

describe('TaskStateMachine', () => {
  let sm: TaskStateMachine;
  let task: Task;

  beforeEach(() => {
    sm = new TaskStateMachine();
    task = {
      id: 'test-task-1',
      title: 'Test Task',
      description: '',
      priority: 1,
      status: 'open',
      isMainPath: false,
      dependencies: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      retryCount: 0,
      artifacts: []
    };
  });

  describe('canTransition', () => {
    it('allows open -> in_progress', () => {
      expect(sm.canTransition('open', 'in_progress').allowed).toBe(true);
    });

    it('allows in_progress -> review', () => {
      expect(sm.canTransition('in_progress', 'review').allowed).toBe(true);
    });

    it('allows review -> closed', () => {
      expect(sm.canTransition('review', 'closed').allowed).toBe(true);
    });

    it('allows review -> open (reject)', () => {
      expect(sm.canTransition('review', 'open').allowed).toBe(true);
    });

    it('allows failed -> open (retry)', () => {
      expect(sm.canTransition('failed', 'open').allowed).toBe(true);
    });

    it('allows failed -> escalated', () => {
      expect(sm.canTransition('failed', 'escalated').allowed).toBe(true);
    });

    it('allows open -> closed (for cancel)', () => {
      expect(sm.canTransition('open', 'closed').allowed).toBe(true);
    });

    it('blocks in_progress -> closed (must review first)', () => {
      expect(sm.canTransition('in_progress', 'closed').allowed).toBe(false);
    });
  });

  describe('transition', () => {
    it('transitions from open to in_progress', () => {
      task = sm.transition(task, 'in_progress');
      expect(task.status).toBe('in_progress');
    });

    it('transitions from in_progress to review', () => {
      task.status = 'in_progress';
      task = sm.transition(task, 'review');
      expect(task.status).toBe('review');
    });

    it('transitions from review to closed', () => {
      task.status = 'review';
      task = sm.transition(task, 'closed');
      expect(task.status).toBe('closed');
    });

    it('throws when closing from in_progress without review', () => {
      task.status = 'in_progress';
      expect(() => sm.transition(task, 'closed')).toThrow('Invalid transition');
    });

    it('throws when retrying beyond limit', () => {
      task.status = 'failed';
      task.retryCount = 3;
      expect(() => sm.transition(task, 'open')).toThrow('Retry limit');
    });

    it('increments retryCount on failed -> open', () => {
      task.status = 'failed';
      task.retryCount = 0;
      task = sm.transition(task, 'open');
      expect(task.retryCount).toBe(1);
    });

    it('allows failed -> escalated regardless of retry count', () => {
      task.status = 'failed';
      task.retryCount = 3;
      task = sm.transition(task, 'escalated');
      expect(task.status).toBe('escalated');
    });
  });

  describe('shouldEscalate', () => {
    it('returns true when failed and retryCount >= 3', () => {
      task.status = 'failed';
      task.retryCount = 3;
      expect(sm.shouldEscalate(task)).toBe(true);
    });

    it('returns false when retryCount < 3', () => {
      task.status = 'failed';
      task.retryCount = 2;
      expect(sm.shouldEscalate(task)).toBe(false);
    });

    it('returns false when not failed', () => {
      task.status = 'in_progress';
      expect(sm.shouldEscalate(task)).toBe(false);
    });
  });
});
