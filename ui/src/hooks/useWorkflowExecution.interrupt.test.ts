import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkflowExecution } from './useWorkflowExecution.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('../api/websocket.js', () => ({
  getWebSocket: () => ({
    connect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    onMessage: vi.fn(() => () => undefined),
    send: vi.fn(),
    getClientId: vi.fn().mockReturnValue('client-1'),
  }),
}));

describe('useWorkflowExecution interruptCurrentTurn', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('sends interrupt via unified agents control with session agent id', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/sessions/session-1/messages')) {
        return {
          ok: true,
          json: async () => ({ success: true, messages: [] }),
        };
      }
      if (url.includes('/api/v1/sessions/session-1')) {
        return {
          ok: true,
          json: async () => ({ id: 'session-1', ownerAgentId: 'finger-executor' }),
        };
      }
      if (url.includes('/api/v1/agents/control')) {
        return {
          ok: true,
          json: async () => ({ ok: true, status: 'completed', result: { interruptedCount: 1 } }),
        };
      }
      return {
        ok: true,
        json: async () => ({}),
      };
    });

    const { result } = renderHook(() => useWorkflowExecution('session-1', '/tmp/project', { disablePolling: true }));

    await waitFor(() => {
      expect(result.current.sessionAgentId).toBe('finger-executor');
    });

    await act(async () => {
      await result.current.interruptCurrentTurn();
    });

    const interruptCall = fetchMock.mock.calls.find(([input]: [RequestInfo | URL]) => String(input).includes('/api/v1/agents/control'));
    expect(interruptCall).toBeTruthy();
    const body = JSON.parse(String((interruptCall?.[1] as RequestInit | undefined)?.body ?? '{}'));
    expect(body).toMatchObject({
      action: 'interrupt',
      targetAgentId: 'finger-executor',
      sessionId: 'session-1',
    });
    expect(result.current.agentRunStatus.text).toBe('已停止当前回合');
  });
});
