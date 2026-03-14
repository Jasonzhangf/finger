/**
 * Integration Test: Quota + Runtime Lifecycle Integration
 *
 * Phase 1 Gate-1 Verification: 资源池 + runtime 生命周期 + 会话绑定集成测试
 * @see docs/AGENT_MANAGEMENT_IMPLEMENTATION_PLAN.md Phase 1 Gate-1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RuntimeQueue } from '../../src/orchestration/quota/runtime-queue.js';
import { getEffectiveQuota, type AgentConfigV1, type RuntimeInstanceV1 } from '../../src/orchestration/quota/types.js';
import { SERIAL_VALIDATION_POLICY } from '../../src/orchestration/quota/serial-policy.js';
import {
  createSpawnedEvent,
  createStatusChangedEvent,
  createFinishedEvent,
  runtimeEventEmitter,
} from '../../src/orchestration/quota/events.js';

describe('Quota + Runtime Lifecycle Integration', () => {
  let queue: RuntimeQueue;
  let eventLog: any[] = [];

  beforeEach(() => {
    queue = new RuntimeQueue();
    eventLog = [];

    // 订阅所有事件用于验证
    runtimeEventEmitter.on('runtime_spawned', (event) => eventLog.push(event));
    runtimeEventEmitter.on('runtime_status_changed', (event) => eventLog.push(event));
    runtimeEventEmitter.on('runtime_finished', (event) => eventLog.push(event));
  });

  afterEach(() => {
    queue.reset();
    eventLog = [];
  });

  const createTestAgentConfig = (overrides?: Partial<AgentConfigV1>): AgentConfigV1 => ({
    id: 'test-executor',
    name: 'Test Executor',
    role: 'executor',
    defaultQuota: 1,
    execution: { provider: 'test' },
    runtime: {},
    ...overrides,
  });

  const createTestInstance = (id: string, agentConfigId: string): RuntimeInstanceV1 => ({
    instanceId: id,
    agentConfigId,
    status: 'queued',
  });

  describe('Quota Resolution', () => {
    it('should resolve workflow quota when set', () => {
      const config: AgentConfigV1 = {
        ...createTestAgentConfig(),
        defaultQuota: 3,
        quotaPolicy: {
          projectQuota: 5,
          workflowQuota: { 'wf-1': 2 },
        },
      };

      const result = getEffectiveQuota(config, 'wf-1');
      expect(result.effectiveQuota).toBe(2);
      expect(result.source).toBe('workflow');
    });

    it('should resolve project quota when workflow quota not set', () => {
      const config: AgentConfigV1 = {
        ...createTestAgentConfig(),
        defaultQuota: 3,
        quotaPolicy: {
          projectQuota: 5,
        },
      };

      const result = getEffectiveQuota(config, 'wf-1');
      expect(result.effectiveQuota).toBe(5);
      expect(result.source).toBe('project');
    });

    it('should resolve default quota when no policy set', () => {
      const config = createTestAgentConfig();
      const result = getEffectiveQuota(config);
      expect(result.effectiveQuota).toBe(1);
      expect(result.source).toBe('default');
    });
  });

  describe('Serial Validation Mode', () => {
    it('should enforce globalMaxConcurrency = 1', () => {
      expect(SERIAL_VALIDATION_POLICY.globalMaxConcurrency).toBe(1);
    });

    it('should enforce perResourceConcurrency = 1 for all resources', () => {
      const { perResourceConcurrency } = SERIAL_VALIDATION_POLICY;
      expect(perResourceConcurrency.executor).toBe(1);
      expect(perResourceConcurrency.orchestrator).toBe(1);
      expect(perResourceConcurrency.reviewer).toBe(1);
    });

    it('should use fifo queue strategy', () => {
      expect(SERIAL_VALIDATION_POLICY.queueStrategy).toBe('fifo');
    });
  });

  describe('Runtime Lifecycle', () => {
    it('should enqueue -> dequeue -> run -> complete lifecycle', () => {
      const instance = createTestInstance('inst-1', 'test-executor');

      // 1. Enqueue
      const position = queue.enqueue(instance);
      expect(position).toBe(1);

      const queued = queue.getQueued();
      expect(queued[0].status).toBe('queued');
      expect(queued[0].queuePosition).toBe(1);

      // 2. Dequeue
      const running = queue.tryDequeue();
      expect(running).not.toBeNull();
      expect(running!.status).toBe('running');
      expect(running!.instanceId).toBe('inst-1');

      // 3. Update status
      queue.updateStatus('inst-1', 'running', 'Starting task execution');
      const active = queue.getActive();
      expect(active[0].summary).toBe('Starting task execution');

      // 4. Complete
      queue.complete('inst-1', 'completed');
      const completed = queue.getCompleted();
      expect(completed[0].status).toBe('completed');
      expect(completed[0].finalStatus).toBe('completed');
    });

    it('should maintain queue positions correctly', () => {
      queue.enqueue(createTestInstance('inst-1', 'test-executor'));
      queue.enqueue(createTestInstance('inst-2', 'test-executor'));
      queue.enqueue(createTestInstance('inst-3', 'test-executor'));

      const queued = queue.getQueued();
      expect(queued[0].queuePosition).toBe(1);
      expect(queued[1].queuePosition).toBe(2);
      expect(queued[2].queuePosition).toBe(3);
      expect(queued[0].queuedCount).toBe(3);
      expect(queued[1].queuedCount).toBe(3);
      expect(queued[2].queuedCount).toBe(3);
    });
  });

  describe('Serial Execution Order', () => {
    it('should execute instances in FIFO order', async () => {
      // Enqueue 3 instances
      queue.enqueue(createTestInstance('inst-1', 'test-executor'));
      queue.enqueue(createTestInstance('inst-2', 'test-executor'));
      queue.enqueue(createTestInstance('inst-3', 'test-executor'));

      // Dequeue and complete in order
      const first = queue.tryDequeue()!;
      expect(first.instanceId).toBe('inst-1');

      queue.complete(first.instanceId, 'completed');

      const second = queue.tryDequeue()!;
      expect(second.instanceId).toBe('inst-2');

      queue.complete(second.instanceId, 'completed');

      const third = queue.tryDequeue()!;
      expect(third.instanceId).toBe('inst-3');

      queue.complete(third.instanceId, 'completed');

      // Verify all completed in order
      const completed = queue.getCompleted();
      expect(completed).toHaveLength(3);
      expect(completed[0].instanceId).toBe('inst-1');
      expect(completed[1].instanceId).toBe('inst-2');
      expect(completed[2].instanceId).toBe('inst-3');
    });

    it('should not allow concurrent execution in serial mode', () => {
      queue.enqueue(createTestInstance('inst-1', 'test-executor'));
      queue.enqueue(createTestInstance('inst-2', 'test-executor'));

      const first = queue.tryDequeue();
      expect(first).not.toBeNull();

      const second = queue.tryDequeue();
      expect(second).toBeNull(); // Serial mode blocks second dequeue

      expect(queue.getStats().active).toBe(1);
      expect(queue.getStats().queued).toBe(1);
    });
  });
});
