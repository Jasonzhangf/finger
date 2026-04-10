/**
 * EventBuilder Tests
 *
 * @see src/protocol/event-builder.ts
 */

import { describe, it, expect } from 'vitest';
import { EventBuilder, createDispatchEvent } from '../../../src/protocol/event-builder.js';
import type { AgentPath, DispatchStatus } from '../../../src/protocol/index.js';

describe('EventBuilder', () => {
  it('should build a valid Event with all required fields', () => {
    const event = new EventBuilder()
      .withType('agent_dispatch_started')
      .withActor('/root/finger-project-agent')
      .withOwnerWorkerId('worker-123')
      .withCorrelationId('dispatch-abc')
      .withCausationId('dispatch-abc')
      .withPayload({ dispatchId: 'abc', taskId: 'task-1', attempt: 1 })
      .build();

    expect(event.schemaVersion).toBe('v1');
    expect(event.eventId).toMatch(/^evt-/);
    expect(event.type).toBe('agent_dispatch_started');
    expect(event.actor).toBe('/root/finger-project-agent');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(event.correlationId).toBe('dispatch-abc');
    expect(event.causationId).toBe('dispatch-abc');
    expect(event.ownerWorkerId).toBe('worker-123');
    expect(event.payload).toEqual({ dispatchId: 'abc', taskId: 'task-1', attempt: 1 });
  });

  it('should auto-generate eventId and timestamp', () => {
    const event = new EventBuilder()
      .withType('agent_dispatch_complete')
      .withActor('/root/finger-system-agent')
      .withOwnerWorkerId('worker-1')
      .withPayload({ dispatchId: 'd1', status: 'success' })
      .build();

    expect(event.eventId).toBeDefined();
    expect(event.eventId.length).toBeGreaterThan(10);
    expect(event.timestamp).toBeDefined();
  });

  it('should throw error if type is missing', () => {
    expect(() => {
      new EventBuilder()
        .withActor('/root/finger-project-agent')
        .withOwnerWorkerId('worker-1')
        .withPayload({})
        .build();
    }).toThrow('Event type is required');
  });

  it('should throw error if actor is invalid AgentPath', () => {
    expect(() => {
      new EventBuilder()
        .withType('agent_dispatch_started')
        .withActor('invalid-path')
        .withPayload({})
        .build();
    }).toThrow('Invalid AgentPath');
  });

  it('should accept valid AgentPath with hyphens', () => {
    const event = new EventBuilder()
      .withType('agent_dispatch_started')
      .withActor('/root/finger-project-agent')
      .withOwnerWorkerId('worker-1')
      .withPayload({})
      .build();

    expect(event.actor).toBe('/root/finger-project-agent');
  });

  it('should use default values from context', () => {
    const context = {
      defaultActor: '/root/finger-system-agent' as AgentPath,
      defaultOwnerWorkerId: 'default-worker',
      defaultCorrelationIdSource: () => 'default-correlation',
    };

    const event = new EventBuilder(context)
      .withType('agent_dispatch_queued')
      .withPayload({ dispatchId: 'd1' })
      .build();

    expect(event.actor).toBe('/root/finger-system-agent');
    expect(event.ownerWorkerId).toBe('default-worker');
    expect(event.correlationId).toBe('default-correlation');
  });

  it('should support fromDispatch helper', () => {
    const event = new EventBuilder()
      .withType('agent_dispatch_complete')
      .withActor('/root/finger-project-agent')
      .withOwnerWorkerId('worker-1')
      .fromDispatch('dispatch-123')
      .withPayload({ dispatchId: 'dispatch-123' })
      .build();

    expect(event.correlationId).toBe('dispatch-123');
    expect(event.causationId).toBe('dispatch-123');
  });

  it('should support optional fields', () => {
    const event = new EventBuilder()
      .withType('agent_dispatch_started')
      .withActor('/root/finger-project-agent')
      .withOwnerWorkerId('worker-1')
      .withPayload({})
      .withRelatedOpId('op-123')
      .withTraceId('trace-abc')
      .build();

    expect(event.relatedOpId).toBe('op-123');
    expect(event.traceId).toBe('trace-abc');
  });
});

describe('createDispatchEvent factory', () => {
  it('should create a valid dispatch event', () => {
    const event = createDispatchEvent('agent_dispatch_started', {
      dispatchId: 'd1',
      actor: '/root/finger-project-agent',
      ownerWorkerId: 'worker-1',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      status: 'started' as DispatchStatus,
      sessionId: 'session-1',
      workflowId: 'workflow-1',
    });

    expect(event.type).toBe('agent_dispatch_started');
    expect(event.correlationId).toBe('d1');
    expect(event.causationId).toBe('d1');
    expect(event.payload.dispatchId).toBe('d1');
    expect(event.payload.status).toBe('started');
  });

  it('should include optional fields', () => {
    const event = createDispatchEvent('agent_dispatch_failed', {
      dispatchId: 'd2',
      actor: '/root/finger-project-agent',
      ownerWorkerId: 'worker-1',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      status: 'failed',
      error: 'Execution timeout',
      queuePosition: 5,
    });

    expect(event.payload.error).toBe('Execution timeout');
    expect(event.payload.queuePosition).toBe(5);
  });

  it('should include closureGate for partial status', () => {
    const event = createDispatchEvent('agent_dispatch_partial', {
      dispatchId: 'd3',
      actor: '/root/finger-project-agent',
      ownerWorkerId: 'worker-1',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
      status: 'partial',
      closureGate: {
        hasEvidence: false,
        hasExploredPaths: false,
        canClose: false,
        blockReason: 'missing_evidence',
      },
    });

    expect(event.payload.closureGate?.hasEvidence).toBe(false);
    expect(event.payload.closureGate?.blockReason).toBe('missing_evidence');
  });
});
