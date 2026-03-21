import { describe, it, expect } from 'vitest';
import {
  formatDispatchResultContent,
  buildDispatchFeedbackPayload,
  buildLedgerPointerInfo,
  formatLedgerPointerContent,
  extractLoopToolTrace,
  buildAgentStepContent,
  asString,
  inferAgentRoleLabel,
} from '../../src/server/modules/event-forwarding-helpers.js';
import type { AgentStepCompletedEvent } from '../../src/runtime/events.js';

describe('event-forwarding-helpers', () => {
  describe('asString', () => {
    it('should return trimmed string', () => {
      expect(asString('  hello  ')).toBe('hello');
    });

    it('should return undefined for empty string', () => {
      expect(asString('   ')).toBeUndefined();
    });

    it('should return undefined for non-string', () => {
      expect(asString(42)).toBeUndefined();
      expect(asString(null)).toBeUndefined();
    });
  });

  describe('inferAgentRoleLabel', () => {
    it('should infer orchestrator', () => {
      expect(inferAgentRoleLabel('finger-orchestrator')).toBe('orchestrator');
    });

    it('should infer reviewer', () => {
      expect(inferAgentRoleLabel('finger-reviewer')).toBe('reviewer');
    });

    it('should default to executor', () => {
      expect(inferAgentRoleLabel('unknown')).toBe('executor');
    });
  });

  describe('buildLedgerPointerInfo', () => {
    it('should build pointer info with defaults', () => {
      const info = buildLedgerPointerInfo({ sessionId: 's1', agentId: 'a1' });
      expect(info.sessionId).toBe('s1');
      expect(info.agentId).toBe('a1');
      expect(info.mode).toBe('main');
      expect(info.ledgerPath).toContain('context-ledger');
    });
  });

  describe('formatLedgerPointerContent', () => {
    it('should format content with label', () => {
      const info = buildLedgerPointerInfo({ sessionId: 's1', agentId: 'a1' });
      const content = formatLedgerPointerContent(info, 'main');
      expect(content).toContain('[ledger_pointer:main]');
      expect(content).toContain('session=s1');
      expect(content).toContain('agent=a1');
    });
  });

  describe('buildDispatchFeedbackPayload', () => {
    it('should include childSessionId from result', () => {
      const payload = buildDispatchFeedbackPayload({
        targetAgentId: 'agent-1',
        status: 'completed',
        result: { sessionId: 'child-123', summary: 'done' },
      });
      expect(payload.childSessionId).toBe('child-123');
      expect(payload.status).toBe('complete');
    });

    it('should not include childSessionId when not present', () => {
      const payload = buildDispatchFeedbackPayload({
        targetAgentId: 'agent-1',
        status: 'completed',
        result: { summary: 'done' },
      });
      expect(payload.childSessionId).toBeUndefined();
    });
  });

  describe('extractLoopToolTrace', () => {
    it('should extract valid tool traces', () => {
      const traces = extractLoopToolTrace([
        { tool: 'shell.exec', status: 'ok', input: 'ls', output: 'file.txt', durationMs: 100 },
        { tool: 'file.read', status: 'error', error: 'not found' },
      ]);
      expect(traces).toHaveLength(2);
      expect(traces[0].tool).toBe('shell.exec');
      expect(traces[0].status).toBe('ok');
      expect(traces[1].tool).toBe('file.read');
      expect(traces[1].status).toBe('error');
    });

    it('should skip entries without tool name', () => {
      const traces = extractLoopToolTrace([{ status: 'ok' }]);
      expect(traces).toHaveLength(0);
    });

    it('should handle non-array input', () => {
      expect(extractLoopToolTrace(null)).toHaveLength(0);
      expect(extractLoopToolTrace('not-array')).toHaveLength(0);
    });
  });

  describe('buildAgentStepContent', () => {
    it('should build content from thought/action/observation', () => {
      const content = buildAgentStepContent({
        thought: 'thinking',
        action: 'doing',
        observation: 'saw result',
        success: true,
      } as AgentStepCompletedEvent['payload']);
      expect(content).toContain('思考: thinking');
      expect(content).toContain('动作: doing');
      expect(content).toContain('观察: saw result');
    });

    it('should return default when all fields are empty', () => {
      const content = buildAgentStepContent({
        success: true,
      } as AgentStepCompletedEvent['payload']);
      expect(content).toBe('agent step 完成');
    });
  });
});
