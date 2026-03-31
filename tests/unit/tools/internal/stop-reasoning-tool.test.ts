import { describe, expect, it } from 'vitest';
import { stopReasoningTool, stopReasoningPolicyTool } from '../../../../src/tools/internal/stop-reasoning-tool.js';

describe('stop-reasoning-tool', () => {
  it('returns stopRequested=true when summary is provided', async () => {
    const result = await stopReasoningTool.execute(
      {
        summary: 'all acceptance checks passed',
        status: 'completed',
        task: 'task-1',
      },
      {
        invocationId: 'inv-1',
        cwd: '/tmp',
        timestamp: new Date().toISOString(),
        sessionId: 'session-1',
        agentId: 'finger-system-agent',
      },
    );

    expect((result as any).ok).toBe(true);
    expect((result as any).stopRequested).toBe(true);
    expect((result as any).stopTool).toBe('reasoning.stop');
  });

  it('policy status action returns current policy snapshot', async () => {
    const result = await stopReasoningPolicyTool.execute(
      { action: 'status' },
      {
        invocationId: 'inv-2',
        cwd: '/tmp',
        timestamp: new Date().toISOString(),
      },
    );

    expect((result as any).ok).toBe(true);
    expect((result as any).policy).toBeDefined();
  });
});
