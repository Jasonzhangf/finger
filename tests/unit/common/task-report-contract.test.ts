import { describe, expect, it } from 'vitest';
import {
  buildTaskReportContract,
  parseTaskReportContract,
  resolveStructuredDeliveryClaim,
} from '../../../src/common/task-report-contract.js';
import { EvidenceType } from '../../../src/common/evidence-schema.js';

describe('task-report-contract', () => {
  it('builds normalized task report contract', () => {
    const report = buildTaskReportContract({
      taskId: 'task-1',
      taskName: 'weibo-detail',
      sessionId: 'session-1',
      projectId: 'project-1',
      sourceAgentId: 'finger-project-agent',
      result: 'success',
      summary: 'done',
      status: 'review_ready',
      nextAction: 'review',
      evidence: 'file-a.ts,file-b.ts',
      deliveryClaim: true,
    });

    expect(report.schema).toBe('finger.task-report.v1');
    expect(report.status).toBe('review_ready');
    expect(report.nextAction).toBe('review');
    expect(report.evidence).toHaveLength(2);
    expect(report.evidence![0].type).toBe(EvidenceType.Log);
    expect(report.evidence![0].details).toBe('file-a.ts');
    expect(report.evidence![1].details).toBe('file-b.ts');
    expect(resolveStructuredDeliveryClaim(report)).toBe(true);
  });

  it('parses raw contract and preserves deterministic routing flags', () => {
    const parsed = parseTaskReportContract({
      schema: 'finger.task-report.v1',
      taskId: 'task-2',
      sessionId: 'session-2',
      projectId: 'project-2',
      sourceAgentId: 'finger-reviewer',
      result: 'failure',
      summary: 'blocked by missing fixture',
      status: 'needs_rework',
      nextAction: 'rework',
      deliveryClaim: false,
      createdAt: new Date().toISOString(),
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.status).toBe('needs_rework');
    expect(parsed?.nextAction).toBe('rework');
    expect(resolveStructuredDeliveryClaim(parsed!)).toBe(false);
  });
});
