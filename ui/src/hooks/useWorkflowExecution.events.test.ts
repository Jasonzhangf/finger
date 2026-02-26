import { describe, expect, it } from 'vitest';
import type { WsMessage } from '../api/types.js';
import { mapWsMessageToRuntimeEvent } from './useWorkflowExecution.js';

describe('mapWsMessageToRuntimeEvent tool payload mapping', () => {
  it('maps view_image tool_result to image attachment event', () => {
    const msg: WsMessage = {
      type: 'tool_result',
      sessionId: 'session-1',
      agentId: 'chat-codex',
      timestamp: '2026-02-25T10:00:00.000Z',
      payload: {
        toolName: 'view_image',
        duration: 23,
        output: {
          ok: true,
          path: '/tmp/demo.png',
          mimeType: 'image/png',
          sizeBytes: 42,
        },
      },
    };

    const event = mapWsMessageToRuntimeEvent(msg, 'session-1');
    expect(event).not.toBeNull();
    expect(event?.toolName).toBe('view_image');
    expect(event?.images?.length).toBe(1);
    expect(event?.images?.[0]?.url).toContain('/api/v1/files/local-image?path=');
  });

  it('maps update_plan tool_result to structured plan event', () => {
    const msg: WsMessage = {
      type: 'tool_result',
      sessionId: 'session-1',
      agentId: 'chat-codex',
      timestamp: '2026-02-25T10:00:00.000Z',
      payload: {
        toolName: 'update_plan',
        duration: 51,
        output: {
          ok: true,
          explanation: '先完成核心回环，再接入工具回填',
          updatedAt: '2026-02-25T10:00:00.000Z',
          plan: [
            { step: '实现核心回环', status: 'completed' },
            { step: '接入工具回填', status: 'in_progress' },
          ],
        },
      },
    };

    const event = mapWsMessageToRuntimeEvent(msg, 'session-1');
    expect(event).not.toBeNull();
    expect(event?.toolName).toBe('update_plan');
    expect(event?.planSteps?.length).toBe(2);
    expect(event?.planExplanation).toBe('先完成核心回环，再接入工具回填');
  });
});
