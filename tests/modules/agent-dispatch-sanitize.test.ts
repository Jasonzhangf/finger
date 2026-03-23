import { describe, expect, it } from 'vitest';
import { sanitizeDispatchResult } from '../../src/common/agent-dispatch.js';

describe('sanitizeDispatchResult', () => {
  it('keeps full raw payload for ledger while exposing readable summary', () => {
    const raw = {
      summary: '审查完成：发现 3 个问题，建议优先修复 keyword 不一致。',
      issues: [
        { title: 'issue-1' },
        { title: 'issue-2' },
      ],
      reviewed_files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      nested: {
        veryLongText: 'x'.repeat(5000),
      },
    };

    const result = sanitizeDispatchResult(raw as any);
    expect(result.summary).toContain('审查完成');
    expect(result.rawPayload).toBeDefined();
    expect(result.rawPayload?.nested).toBeDefined();
    expect((result.rawPayload as any).nested.veryLongText.length).toBe(5000);
  });

  it('builds readable summary from structured fields when summary missing', () => {
    const raw = {
      verdict: 'detail 阶段审查完成',
      issues: [
        { title: 'keyword 空值校验缺失' },
        { title: 'overrides 展开顺序风险' },
      ],
      reviewed_files: ['xhs-unified-options.mjs', 'xhs-unified-runner.mjs'],
    };

    const result = sanitizeDispatchResult(raw as any);
    expect(result.summary).toContain('detail 阶段审查完成');
    expect(result.summary.startsWith('{')).toBe(false);
  });
});
