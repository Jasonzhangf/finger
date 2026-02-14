import { describe, it, expect, beforeEach } from 'vitest';
import { Scheduler } from '../../src/app/scheduler.js';
import type { Task, Agent } from '../../src/core/types.js';

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let tasks: Task[];
  let agents: Agent[];

  beforeEach(() => {
    scheduler = new Scheduler();

    tasks = [
      {
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
      },
      {
        id: 'task-2',
        title: 'Implement: Feature',
        description: '',
        priority: 0,
        status: 'open',
        isMainPath: true,
        dependencies: ['task-1'],
        createdAt: new Date(),
        updatedAt: new Date(),
        retryCount: 0,
        artifacts: []
      }
    ];

    agents = [
      {
        id: 'agent-1',
        name: 'executor-1',
        role: 'executor',
        sdk: 'codex',
        status: 'idle',
        capabilities: [],
        lastHeartbeat: new Date()
      },
      {
        id: 'agent-2',
        name: 'architect-1',
        role: 'architect',
        sdk: 'claude',
        status: 'idle',
        capabilities: [],
        lastHeartbeat: new Date()
      }
    ];
  });

  describe('schedule', () => {
    it('schedules non-main-path tasks first', () => {
      const results = scheduler.schedule(tasks, agents);

      expect(results.length).toBe(1);
      expect(results[0].taskId).toBe('task-1');
      expect(results[0].agentId).toBe('agent-2');
    });

    it('waits for dependencies to complete', () => {
      const results = scheduler.schedule(tasks, agents);

      const task2Result = results.find(r => r.taskId === 'task-2');
      expect(task2Result).toBeUndefined();
    });

    it('schedules main-path task when dependency is complete', () => {
      tasks[0].status = 'closed';
      const results = scheduler.schedule(tasks, agents);

      expect(results.length).toBe(1);
      expect(results[0].taskId).toBe('task-2');
      expect(results[0].agentId).toBe('agent-1');
    });

    it('returns null agent when no suitable agent available', () => {
      agents[0].status = 'busy';
      agents[1].status = 'busy';

      const results = scheduler.schedule(tasks, agents);

      expect(results[0].agentId).toBeNull();
    });

    it('matches task role to agent role', () => {
      const testTask: Task = {
        id: 'test-task',
        title: 'Test: Feature',
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

      const testerAgent: Agent = {
        id: 'agent-tester',
        name: 'tester-1',
        role: 'tester',
        sdk: 'codex',
        status: 'idle',
        capabilities: [],
        lastHeartbeat: new Date()
      };

      const results = scheduler.schedule([testTask], [agents[0], agents[1], testerAgent]);

      expect(results[0].agentId).toBe('agent-tester');
    });
  });
});
