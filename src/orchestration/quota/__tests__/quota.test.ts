/**
 * Quota Module Unit Tests
 * 
 * Phase 1 串行验证
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getEffectiveQuota,
  type AgentConfigV1,
} from '../types.js';
import {
  SERIAL_VALIDATION_POLICY,
  isSerialValidationMode,
  getQueueDescription,
} from '../serial-policy.js';
import { RuntimeQueue } from '../runtime-queue.js';
import type { RuntimeInstanceV1 } from '../types.js';

describe('getEffectiveQuota', () => {
  it('should return workflow quota when set', () => {
    const config: AgentConfigV1 = {
      id: 'test-agent',
      name: 'Test Agent',
      role: 'executor',
      defaultQuota: 3,
      quotaPolicy: {
        projectQuota: 5,
        workflowQuota: { 'wf-1': 2 },
      },
      execution: { provider: 'test' },
      runtime: {},
    };

    const result = getEffectiveQuota(config, 'wf-1');
    expect(result.effectiveQuota).toBe(2);
    expect(result.source).toBe('workflow');
  });

  it('should return project quota when workflow quota not set', () => {
    const config: AgentConfigV1 = {
      id: 'test-agent',
      name: 'Test Agent',
      role: 'executor',
      defaultQuota: 3,
      quotaPolicy: {
        projectQuota: 5,
      },
      execution: { provider: 'test' },
      runtime: {},
    };

    const result = getEffectiveQuota(config, 'wf-1');
    expect(result.effectiveQuota).toBe(5);
    expect(result.source).toBe('project');
  });

  it('should return default quota when no policy set', () => {
    const config: AgentConfigV1 = {
      id: 'test-agent',
      name: 'Test Agent',
      role: 'executor',
      defaultQuota: 3,
      execution: { provider: 'test' },
      runtime: {},
    };

    const result = getEffectiveQuota(config);
    expect(result.effectiveQuota).toBe(3);
    expect(result.source).toBe('default');
  });

  it('should return 1 when defaultQuota not set', () => {
    const config = {
      id: 'test-agent',
      name: 'Test Agent',
      role: 'executor' as const,
      defaultQuota: undefined as unknown as number,
      execution: { provider: 'test' },
      runtime: {},
    };

    const result = getEffectiveQuota(config as AgentConfigV1);
    expect(result.effectiveQuota).toBe(1);
    expect(result.source).toBe('default');
  });
});

describe('SERIAL_VALIDATION_POLICY', () => {
  it('should have globalMaxConcurrency = 1', () => {
    expect(SERIAL_VALIDATION_POLICY.globalMaxConcurrency).toBe(1);
  });

  it('should have all perResourceConcurrency = 1', () => {
    const { perResourceConcurrency } = SERIAL_VALIDATION_POLICY;
    expect(perResourceConcurrency.executor).toBe(1);
    expect(perResourceConcurrency.orchestrator).toBe(1);
    expect(perResourceConcurrency.reviewer).toBe(1);
    expect(perResourceConcurrency.tool).toBe(1);
    expect(perResourceConcurrency.api).toBe(1);
    expect(perResourceConcurrency.database).toBe(1);
  });

  it('should use fifo queue strategy', () => {
    expect(SERIAL_VALIDATION_POLICY.queueStrategy).toBe('fifo');
  });
});

describe('isSerialValidationMode', () => {
  it('should return true for serial policy', () => {
    expect(isSerialValidationMode(SERIAL_VALIDATION_POLICY)).toBe(true);
  });

  it('should return false for non-serial policy', () => {
    expect(isSerialValidationMode({
      ...SERIAL_VALIDATION_POLICY,
      globalMaxConcurrency: 5,
    })).toBe(false);
  });
});

describe('getQueueDescription', () => {
  it('should return "即将执行" for position 0', () => {
    expect(getQueueDescription(0, 5)).toBe('即将执行');
  });

  it('should return position info for other positions', () => {
    expect(getQueueDescription(3, 5)).toBe('队列位置: 3/5');
  });
});

describe('RuntimeQueue', () => {
  let queue: RuntimeQueue;

  beforeEach(() => {
    queue = new RuntimeQueue();
  });

  const createInstance = (id: string): RuntimeInstanceV1 => ({
    instanceId: id,
    agentConfigId: 'test-agent',
    status: 'queued',
  });

  it('should enqueue instances', () => {
    const instance = createInstance('inst-1');
    const position = queue.enqueue(instance);
    expect(position).toBe(1);
  });

  it('should dequeue instances in FIFO order', () => {
    queue.enqueue(createInstance('inst-1'));
    queue.enqueue(createInstance('inst-2'));
    queue.enqueue(createInstance('inst-3'));

    const first = queue.tryDequeue();
    expect(first?.instanceId).toBe('inst-1');
    expect(first?.status).toBe('running');
  });

  it('should not dequeue when max concurrent reached (serial mode)', () => {
    queue.enqueue(createInstance('inst-1'));
    queue.enqueue(createInstance('inst-2'));

    // First dequeue succeeds
    const first = queue.tryDequeue();
    expect(first).not.toBeNull();

    // Second dequeue fails (serial mode, max 1)
    const second = queue.tryDequeue();
    expect(second).toBeNull();
  });

  it('should complete instances and allow next dequeue', () => {
    queue.enqueue(createInstance('inst-1'));
    queue.enqueue(createInstance('inst-2'));

    const first = queue.tryDequeue()!;
    queue.complete(first.instanceId, 'completed');

    const second = queue.tryDequeue();
    expect(second?.instanceId).toBe('inst-2');
  });

  it('should track queue positions correctly', () => {
    queue.enqueue(createInstance('inst-1'));
    queue.enqueue(createInstance('inst-2'));
    queue.enqueue(createInstance('inst-3'));

    const queued = queue.getQueued();
    expect(queued[0].queuePosition).toBe(1);
    expect(queued[1].queuePosition).toBe(2);
    expect(queued[2].queuePosition).toBe(3);
  });

  it('should return correct stats', () => {
    queue.enqueue(createInstance('inst-1'));
    queue.enqueue(createInstance('inst-2'));

    const first = queue.tryDequeue()!;
    queue.complete(first.instanceId, 'completed');

    const stats = queue.getStats();
    expect(stats.queued).toBe(1);
    expect(stats.active).toBe(0);
    expect(stats.completed).toBe(1);
    expect(stats.maxConcurrent).toBe(1);
  });

  it('should allow setting max concurrent', () => {
    queue.setMaxConcurrent(3);
    expect(queue.getMaxConcurrent()).toBe(3);
  });
});
