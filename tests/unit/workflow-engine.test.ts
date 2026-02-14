import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine, type WorkflowContext } from '../../src/app/workflow-engine.js';
import type { Task, Agent } from '../../src/core/types.js';

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;
  let context: WorkflowContext;

  beforeEach(() => {
    engine = new WorkflowEngine();

    const task1: Task = {
      id: 'task-1',
      title: 'Design: Feature',
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

    const agent1: Agent = {
      id: 'agent-1',
      name: 'executor-1',
      role: 'executor',
      sdk: 'codex',
      status: 'idle',
      capabilities: [],
      lastHeartbeat: new Date()
    };

    context = {
      projectId: 'project-1',
      tasks: new Map([['task-1', task1]]),
      agents: new Map([['agent-1', agent1]])
    };
  });

  describe('start/stop', () => {
    it('does not schedule when stopped', () => {
      const results = engine.tick(context);
      expect(results).toEqual([]);
    });

    it('schedules when started', () => {
      engine.start();
      const results = engine.tick(context);
      expect(results.length).toBe(1);
    });
  });

  describe('handleTaskCompletion', () => {
    it('transitions task to review', () => {
      const task = context.tasks.get('task-1')!;
      task.status = 'in_progress';

      engine.handleTaskCompletion('task-1', context);

      expect(context.tasks.get('task-1')!.status).toBe('review');
    });

    it('does nothing for non-existent task', () => {
      engine.handleTaskCompletion('non-existent', context);
    });
  });

  describe('handleTaskFailure', () => {
    it('marks task as failed', () => {
      const task = context.tasks.get('task-1')!;
      task.status = 'in_progress';

      const action = engine.handleTaskFailure('task-1', context);

      expect(context.tasks.get('task-1')!.status).toBe('failed');
      expect(action.taskId).toBe('task-1');
    });

    it('returns retry action for first failure', () => {
      const task = context.tasks.get('task-1')!;
      task.status = 'in_progress';

      const action = engine.handleTaskFailure('task-1', context);

      expect(action.action).toBe('retry');
    });
  });

  describe('events', () => {
    it('emits task_completed event', () => {
      const events: string[] = [];
      engine.onEvent(e => events.push(e.type));

      const task = context.tasks.get('task-1')!;
      task.status = 'in_progress';
      engine.handleTaskCompletion('task-1', context);

      expect(events).toContain('task_completed');
    });

    it('emits task_failed event', () => {
      const events: string[] = [];
      engine.onEvent(e => events.push(e.type));

      const task = context.tasks.get('task-1')!;
      task.status = 'in_progress';
      engine.handleTaskFailure('task-1', context);

      expect(events).toContain('task_failed');
    });
  });
});
