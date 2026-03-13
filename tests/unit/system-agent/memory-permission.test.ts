import { describe, it, expect } from 'vitest';
import { memoryTool } from '../../../src/tools/internal/memory/memory-tool.js';

// NOTE: this test only checks permission gate, not full file IO

describe('Memory permission guard', () => {
  it('rejects non-system agent editing system memory', async () => {
    const res = await memoryTool.execute({
      action: 'edit',
      scope: 'system',
      entry_id: 'dummy',
      updates: { title: 'x' },
      caller_agent_id: 'finger-orchestrator',
      is_system_agent: false,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Only system agent');
  });
});
