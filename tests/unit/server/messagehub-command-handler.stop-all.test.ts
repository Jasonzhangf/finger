import { describe, expect, it, vi } from 'vitest';
import { handleSystemStopAllReasoning } from '../../../src/server/modules/messagehub-command-handler.js';

describe('handleSystemStopAllReasoning', () => {
  it('interrupts all active turns and reports summary', async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        result: {
          chatCodexSessions: [
            { sessionId: 's1', providerId: 'p-a', hasActiveTurn: true },
            { sessionId: 's2', providerId: 'p-a', hasActiveTurn: false },
            { sessionId: 's3', hasActiveTurn: true },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { interruptedCount: 1 },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: {
          sessions: [{ sessionId: 's3', interrupted: false }],
        },
      });

    const result = await handleSystemStopAllReasoning({
      callTool,
    } as any);

    expect(result).toContain('扫描 2 个 active session');
    expect(result).toContain('成功中断 1 个推理回合');
    expect(result).toContain('⚠️ 未中断: 1 个');
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(callTool).toHaveBeenNthCalledWith(
      1,
      'finger-system-agent',
      'agent.control',
      { action: 'status' },
    );
    expect(callTool).toHaveBeenNthCalledWith(
      2,
      'finger-system-agent',
      'agent.control',
      { action: 'interrupt', session_id: 's1', provider_id: 'p-a' },
    );
    expect(callTool).toHaveBeenNthCalledWith(
      3,
      'finger-system-agent',
      'agent.control',
      { action: 'interrupt', session_id: 's3' },
    );
  });

  it('returns no-op message when no active turns', async () => {
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        chatCodexSessions: [{ sessionId: 's1', providerId: 'p-a', hasActiveTurn: false }],
      },
    });

    const result = await handleSystemStopAllReasoning({ callTool } as any);
    expect(result).toContain('0 active turns');
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('surfaces status errors instead of silent failure', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('status timeout'));
    const result = await handleSystemStopAllReasoning({ callTool } as any);
    expect(result).toContain('强制停止失败');
    expect(result).toContain('status timeout');
  });
});

