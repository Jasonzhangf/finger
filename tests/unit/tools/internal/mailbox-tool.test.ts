import { describe, it, expect } from 'vitest';
import { createToolExecutionContext } from '../../../../src/tools/internal/types.js';
import { mailboxListTool, mailboxStatusTool } from '../../../../src/tools/internal/mailbox-tool.js';

describe('mailbox tools', () => {
  it('defaults mailbox target to context.agentId', async () => {
    const uniqueAgentId = `test-mailbox-defaults-${Date.now()}`;
    const ctx = createToolExecutionContext({ agentId: uniqueAgentId });

    const status = await mailboxStatusTool.execute({}, ctx) as { target: string; counts: { total: number } };
    const list = await mailboxListTool.execute({}, ctx) as { target: string; total: number };

    expect(status.target).toBe(uniqueAgentId);
    expect(status.counts.total).toBe(0);
    expect(list.target).toBe(uniqueAgentId);
    expect(list.total).toBe(0);
  });

  it('falls back to finger-system-agent when context has no agentId', async () => {
    const ctx = createToolExecutionContext();
    const status = await mailboxStatusTool.execute({}, ctx) as { target: string };
    expect(status.target).toBe('finger-system-agent');
  });
});
