/**
 * LoopManager 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LoopManager } from '../../../../dist/orchestration/loop/loop-manager.js';
import type { LoopPhase, LoopStatus, LoopResult } from '../../../../dist/orchestration/loop/types.js';

// Mock globalEventBus
vi.mock('../../../../dist/runtime/event-bus.js', () => ({
  globalEventBus: {
    emit: vi.fn(),
  },
}));

// Mock resourcePool
vi.mock('../../../../dist/orchestration/resource-pool.js', () => ({
  resourcePool: {
    allocateResources: vi.fn(() => ({ success: true, allocatedResources: ['executor-1'] })),
    releaseResources: vi.fn(),
    getAllocation: vi.fn(() => ({ allocatedResources: ['executor-1'] })),
  },
}));

describe('LoopManager', () => {
  let manager: LoopManager;

  beforeEach(() => {
    manager = new LoopManager();
    vi.clearAllMocks();
  });

  describe('createLoop', () => {
    it('should create a loop with correct id format', () => {
      const loop = manager.createLoop('epic-1', 'plan');
      expect(loop.id).toBe('L-epic-1-plan-1');
      expect(loop.phase).toBe('plan');
      expect(loop.status).toBe('queue');
      expect(loop.nodes).toEqual([]);
    });

    it('should increment sequence for same phase', () => {
      const loop1 = manager.createLoop('epic-1', 'plan');
      manager.startLoop(loop1.id);
      manager.completeLoop(loop1.id, 'success');
      
      const loop2 = manager.createLoop('epic-1', 'plan');
      expect(loop2.id).toBe('L-epic-1-plan-2');
    });
  });

  describe('startLoop', () => {
    it('should change status from queue to running', () => {
      const loop = manager.createLoop('epic-1', 'execution');
      manager.queueLoop(loop);
      
      const started = manager.startLoop(loop.id);
      expect(started.status).toBe('running');
    });

    it('should set runningLoop in taskFlow', () => {
      const loop = manager.createLoop('epic-1', 'execution');
      manager.queueLoop(loop);
      manager.startLoop(loop.id);
      
      const taskFlow = manager.getTaskFlow('epic-1');
      expect(taskFlow?.runningLoop?.id).toBe(loop.id);
    });
  });

  describe('completeLoop', () => {
    it('should move loop to history', () => {
      const loop = manager.createLoop('epic-1', 'plan');
      manager.startLoop(loop.id);
      
      const completed = manager.completeLoop(loop.id, 'success');
      expect(completed.status).toBe('history');
      expect(completed.result).toBe('success');
      expect(completed.completedAt).toBeDefined();
    });

    it('should add to correct history based on phase', () => {
      const loop = manager.createLoop('epic-1', 'plan');
      manager.startLoop(loop.id);
      manager.completeLoop(loop.id, 'success');
      
      const taskFlow = manager.getTaskFlow('epic-1');
      expect(taskFlow?.planHistory).toHaveLength(1);
      expect(taskFlow?.runningLoop).toBeUndefined();
    });
  });

  describe('addNode', () => {
    it('should add node with generated id', () => {
      const loop = manager.createLoop('epic-1', 'execution');
      manager.startLoop(loop.id);
      
      const node = manager.addNode(loop.id, {
        type: 'orch',
        status: 'running',
        title: '编排门',
        text: '正在分析任务',
      });
      
      expect(node.id).toBe('N-L-epic-1-execution-1-1');
      expect(node.timestamp).toBeDefined();
    });

    it('should track multiple nodes', () => {
      const loop = manager.createLoop('epic-1', 'execution');
      manager.startLoop(loop.id);
      
      manager.addNode(loop.id, { type: 'orch', status: 'done', title: '编排', text: '分析完成' });
      manager.addNode(loop.id, { type: 'exec', status: 'running', title: '执行', text: '正在执行' });
      
      const taskFlow = manager.getTaskFlow('epic-1');
      expect(taskFlow?.runningLoop?.nodes).toHaveLength(2);
    });
  });

  describe('updateNodeStatus', () => {
    it('should update node status', () => {
      const loop = manager.createLoop('epic-1', 'execution');
      manager.startLoop(loop.id);
      
      const node = manager.addNode(loop.id, {
        type: 'exec',
        status: 'running',
        title: '执行',
        text: '正在执行',
      });
      
      manager.updateNodeStatus(loop.id, node.id, 'done');
      
      const taskFlow = manager.getTaskFlow('epic-1');
      const updatedNode = taskFlow?.runningLoop?.nodes.find(n => n.id === node.id);
      expect(updatedNode?.status).toBe('done');
    });
  });

  describe('queueLoop', () => {
    it('should add loop to queue', () => {
      const loop = manager.createLoop('epic-1', 'execution');
      manager.queueLoop(loop);
      
      const taskFlow = manager.getTaskFlow('epic-1');
      expect(taskFlow?.queue).toHaveLength(1);
      expect(taskFlow?.queue[0].status).toBe('queue');
    });
  });

  describe('getActiveLoops', () => {
    it('should return all running loops', () => {
      const loop1 = manager.createLoop('epic-1', 'execution');
      manager.startLoop(loop1.id);
      
      const loop2 = manager.createLoop('epic-2', 'execution');
      manager.startLoop(loop2.id);
      
      const active = manager.getActiveLoops();
      expect(active).toHaveLength(2);
    });
  });

  describe('transitionPhase', () => {
    it('should update taskFlow status', () => {
      manager.getOrCreateTaskFlow('epic-1');
      manager.transitionPhase('epic-1', 'design', '需求已确认');
      
      const taskFlow = manager.getTaskFlow('epic-1');
      expect(taskFlow?.status).toBe('design');
    });
  });

  describe('user interaction', () => {
    it('should create pending user input', () => {
      const loop = manager.createLoop('epic-1', 'plan');
      manager.startLoop(loop.id);
      
      const pending = manager.requestUserInput('epic-1', '请确认概要设计？', ['确认', '修改']);
      
      expect(pending.question).toBe('请确认概要设计？');
      expect(pending.options).toEqual(['确认', '修改']);
      expect(pending.loopId).toBe(loop.id);
    });

    it('should receive user input and update node', () => {
      const loop = manager.createLoop('epic-1', 'plan');
      manager.startLoop(loop.id);
      
      manager.requestUserInput('epic-1', '请确认？');
      manager.receiveUserInput('epic-1', '确认');
      
      const taskFlow = manager.getTaskFlow('epic-1');
      const userNode = taskFlow?.runningLoop?.nodes.find(n => n.type === 'user');
      expect(userNode?.status).toBe('done');
    });
  });
});
