import { describe, expect, it } from 'vitest';
import {
  buildDispatchReasonSummary,
  sanitizeUserFacingStatusText,
} from '../../src/server/modules/agent-status-subscriber-handler-helpers.js';

describe('agent-status subscriber sanitization', () => {
  it('strips finger-control block from status text', () => {
    const text = [
      '修复完成',
      '```finger-control',
      '{"schema_version":"1.1","task_completed":true,"evidence_ready":true,"needs_user_input":false,"has_blocker":false,"dispatch_required":false,"review_required":false,"wait":false,"user_signal":null,"tags":[],"self_eval":"","anti_patterns":[],"learning":null}',
      '```',
    ].join('\n');
    const sanitized = sanitizeUserFacingStatusText(text, 240);
    expect(sanitized).toBe('修复完成');
    expect(sanitized).not.toContain('finger-control');
    expect(sanitized).not.toContain('schema_version');
  });

  it('extracts summary from role json payload', () => {
    const text = '{"role":"orchestrator","summary":"派发完成，等待执行"}';
    const sanitized = sanitizeUserFacingStatusText(text, 240);
    expect(sanitized).toBe('派发完成，等待执行');
    expect(sanitized).not.toContain('orchestrator');
  });

  it('buildDispatchReasonSummary uses sanitized summary', () => {
    const reason = buildDispatchReasonSummary({
      dispatchStatus: 'completed',
      resultStatus: 'completed',
      mailboxFlow: false,
      mailboxPreview: '',
      resultSummary: '{"role":"orchestrator","summary":"E2E 执行通过"}',
      nextAction: '',
      assignmentTaskId: '',
    });
    expect(reason).toBe('E2E 执行通过');
  });
});

