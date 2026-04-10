import { describe, it, expect } from 'vitest';
import { EventUtils } from '../../../src/protocol/event-types.js';

describe('Protocol: Event Types', () => {
  describe('EventUtils', () => {
    it('should generate unique eventIds', () => {
      const id1 = EventUtils.generateEventId();
      const id2 = EventUtils.generateEventId();
      expect(id1).not.toBe(id2);
      expect(id1.startsWith('evt-')).toBe(true);
    });

    it('should create event with required fields', () => {
      const event = EventUtils.create(
        'agent_dispatch_started',
        '/root/finger-system-agent',
        { dispatchId: 'dispatch-1', taskId: 'task-1', attempt: 1 } as any,
        'correlation-1',
        'causation-1',
        'worker-1',
      );
      expect(event.schemaVersion).toBe('v1');
      expect(event.eventId).toBeDefined();
      expect(event.type).toBe('agent_dispatch_started');
      expect(event.actor).toBe('/root/finger-system-agent');
      expect(event.timestamp).toBeDefined();
      expect(event.correlationId).toBe('correlation-1');
      expect(event.causationId).toBe('causation-1');
      expect(event.ownerWorkerId).toBe('worker-1');
    });

    it('should validate event', () => {
      const validEvent = EventUtils.create(
        'agent_dispatch_started',
        '/root/finger-system-agent',
        { dispatchId: 'dispatch-1', taskId: 'task-1', attempt: 1 } as any,
        'correlation-1',
        'causation-1',
        'worker-1',
      );
      const result = EventUtils.validate(validEvent);
      expect(result.valid).toBe(true);
      expect(result.missing.length).toBe(0);
    });

    it('should detect missing fields', () => {
      const result = EventUtils.validate({} as any);
      expect(result.valid).toBe(false);
      expect(result.missing).toContain('schemaVersion');
      expect(result.missing).toContain('eventId');
      expect(result.missing).toContain('type');
      expect(result.missing).toContain('actor');
      expect(result.missing).toContain('timestamp');
      expect(result.missing).toContain('correlationId');
      expect(result.missing).toContain('causationId');
      expect(result.missing).toContain('ownerWorkerId');
      expect(result.missing).toContain('payload');
    });

    it('should compute dedup key', () => {
      const event = EventUtils.create(
        'agent_dispatch_started',
        '/root/finger-system-agent',
        { dispatchId: 'dispatch-1', taskId: 'task-1', attempt: 1 } as any,
        'correlation-1',
        'causation-1',
        'worker-1',
      );
      const dedupKey = EventUtils.computeDedupKey(event);
      expect(dedupKey).toContain('agent_dispatch_started');
      expect(dedupKey).toContain('dispatch-1');
      expect(dedupKey).toContain('task-1');
      expect(dedupKey).toContain('1');
    });

    it('should check event group membership', () => {
      expect(EventUtils.belongsToGroup('turn_started', 'turn_lifecycle')).toBe(true);
      expect(EventUtils.belongsToGroup('turn_complete', 'turn_lifecycle')).toBe(true);
      expect(EventUtils.belongsToGroup('agent_dispatch_started', 'agent_status')).toBe(true);
      expect(EventUtils.belongsToGroup('tool_call_begin', 'tool_execution')).toBe(true);
      expect(EventUtils.belongsToGroup('progress_update', 'progress')).toBe(true);
      expect(EventUtils.belongsToGroup('review_started', 'review')).toBe(true);
      
      // Wrong group
      expect(EventUtils.belongsToGroup('turn_started', 'agent_status')).toBe(false);
      
      // All group
      expect(EventUtils.belongsToGroup('turn_started', 'all')).toBe(true);
      expect(EventUtils.belongsToGroup('agent_dispatch_started', 'all')).toBe(true);
    });

    it('should check dispatch closure gate', () => {
      const completePayload = {
        dispatchId: 'dispatch-1',
        taskId: 'task-1',
        attempt: 1,
        status: 'success' as const,
        evidence: { result: 'done' },
        exploredPaths: ['path1'],
      };
      const gate = EventUtils.canCloseDispatch(completePayload);
      expect(gate.hasEvidence).toBe(true);
      expect(gate.hasExploredPaths).toBe(true);
      expect(gate.canClose).toBe(true);

      const partialPayload = {
        dispatchId: 'dispatch-1',
        taskId: 'task-1',
        attempt: 1,
        missingEvidence: ['execution_result'],
        blockReason: 'missing_evidence' as const,
        userDecisionOptions: ['retry'],
      } as any;
      const partialGate = EventUtils.canCloseDispatch(partialPayload);
      expect(partialGate.hasEvidence).toBe(false);
      expect(partialGate.canClose).toBe(false);
      expect(partialGate.blockReason).toBe('missing_evidence');
    });
  });
});
