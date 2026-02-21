/**
 * Loop Lifecycle Integration Test
 * Tests the full flow from orchestrator creating loops to executor emitting events
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loopManager } from '../../src/orchestration/loop/loop-manager';
import { globalEventBus } from '../../src/runtime/event-bus';

describe('Loop Lifecycle Integration', () => {
  const testEpicId = 'test-epic-integration-1';
  const emittedEvents: any[] = [];

  beforeEach(() => {
    emittedEvents.length = 0;
    vi.clearAllMocks();
    
    // Subscribe to all loop events
    globalEventBus.subscribe('loop.created', (e) => emittedEvents.push(e));
    globalEventBus.subscribe('loop.started', (e) => emittedEvents.push(e));
    globalEventBus.subscribe('loop.node.updated', (e) => emittedEvents.push(e));
    globalEventBus.subscribe('loop.completed', (e) => emittedEvents.push(e));
  });

  it('should create and complete a plan loop with events', () => {
    // Create plan loop
    const planLoop = loopManager.createLoop(testEpicId, 'plan');
    expect(planLoop.id).toContain('plan');
    expect(planLoop.status).toBe('queue');
    
    // Check event emission
    const createdEvent = emittedEvents.find(e => e.type === 'loop.created');
    expect(createdEvent).toBeDefined();
    expect(createdEvent.epicId).toBe(testEpicId);

    // Start loop
    loopManager.startLoop(planLoop.id);
    const startedEvent = emittedEvents.find(e => e.type === 'loop.started');
    expect(startedEvent).toBeDefined();

    // Add nodes
    const orchNode = loopManager.addNode(planLoop.id, {
      type: 'orch',
      status: 'running',
      title: '需求分析',
      text: '正在分析用户需求',
    });
    expect(orchNode).toBeDefined();
    
    const nodeUpdateEvent = emittedEvents.find(e => e.type === 'loop.node.updated');
    expect(nodeUpdateEvent).toBeDefined();
    expect(nodeUpdateEvent.payload.node.type).toBe('orch');

    // Complete loop
    loopManager.completeLoop(planLoop.id, 'success');
    const completedEvent = emittedEvents.find(e => e.type === 'loop.completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent.payload.result).toBe('success');
  });

  it('should create loops in sequence', () => {
    const uniqueEpicId = `test-epic-seq-${Date.now()}`;
    
    // Plan phase
    const planLoop = loopManager.createLoop(uniqueEpicId, 'plan');
    loopManager.startLoop(planLoop.id);
    loopManager.completeLoop(planLoop.id, 'success');

    // Design phase
    const designLoop = loopManager.createLoop(uniqueEpicId, 'design', planLoop.id);
    loopManager.startLoop(designLoop.id);
    loopManager.completeLoop(designLoop.id, 'success');

    // Execution phase
    const execLoop = loopManager.createLoop(uniqueEpicId, 'execution', designLoop.id);
    loopManager.startLoop(execLoop.id);
    
    // Add exec node
    loopManager.addNode(execLoop.id, {
      type: 'exec',
      status: 'running',
      title: 'task-1',
      text: '执行任务',
      agentId: 'executor-1',
    });

    // Complete execution
    loopManager.completeLoop(execLoop.id, 'success');

    // Verify task flow structure
    const taskFlow = loopManager.getTaskFlow(uniqueEpicId);
    expect(taskFlow?.planHistory.length).toBeGreaterThanOrEqual(1);
    expect(taskFlow?.designHistory.length).toBeGreaterThanOrEqual(1);
    expect(taskFlow?.executionHistory.length).toBeGreaterThanOrEqual(1);
  });

  it('should emit events for all loop operations', () => {
    const uniqueEpicId = `test-epic-events-${Date.now()}`;
    
    const loop = loopManager.createLoop(uniqueEpicId, 'plan');
    loopManager.startLoop(loop.id);
    loopManager.addNode(loop.id, {
      type: 'orch',
      status: 'running',
      title: 'Test',
      text: 'Testing',
    });
    loopManager.completeLoop(loop.id, 'success');

    // Verify all expected events were emitted
    const eventTypes = emittedEvents.map(e => e.type);
    expect(eventTypes).toContain('loop.created');
    expect(eventTypes).toContain('loop.started');
    expect(eventTypes).toContain('loop.node.updated');
    expect(eventTypes).toContain('loop.completed');
  });
});
