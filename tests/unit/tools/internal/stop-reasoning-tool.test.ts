import { describe, expect, it } from 'vitest';
import { stopReasoningTool, stopReasoningPolicyTool } from '../../../../src/tools/internal/stop-reasoning-tool.js';

describe('stop-reasoning-tool', () => {
  it('returns stopRequested=true when summary is provided', async () => {
    const result = await stopReasoningTool.execute(
      {
        summary: 'all acceptance checks passed',
        goal: 'Finish requested fix and report closure evidence',
        assumptions: 'Local test environment mirrors runtime behavior',
        tags: ['debug', 'context-rebuild'],
        toolsUsed: [
          { tool: 'update_plan', args: '{"plan":[{"step":"Fix bug","status":"completed"}]}', status: 'success' },
        ],
        successes: ['Reproduced issue and validated fixed behavior'],
        failures: ['Initial regex did not match heartbeat payload'],
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

  it('rejects stop request when mandatory structured fields are missing', async () => {
    const result = await stopReasoningTool.execute(
      {
        summary: 'done',
      },
      {
        invocationId: 'inv-1b',
        cwd: '/tmp',
        timestamp: new Date().toISOString(),
        sessionId: 'session-1',
        agentId: 'finger-system-agent',
      },
    );

    expect((result as any).ok).toBe(false);
    expect((result as any).stopRequested).toBe(false);
    expect((result as any).error).toBe('goal is required');
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
