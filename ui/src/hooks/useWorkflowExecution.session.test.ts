import { describe, expect, it } from 'vitest';
import type { SessionApiMessage } from './useWorkflowExecution.types.js';
import { mapSessionMessageToRuntimeEvent } from './useWorkflowExecution.session.js';

function buildMessage(input: Partial<SessionApiMessage>): SessionApiMessage {
  return {
    id: 'msg-1',
    role: 'system',
    content: '',
    timestamp: '2026-03-24T08:00:00.000Z',
    ...input,
  };
}

describe('mapSessionMessageToRuntimeEvent', () => {
  it('ignores persisted tool_call messages', () => {
    const event = mapSessionMessageToRuntimeEvent(
      buildMessage({
        type: 'tool_call',
        content: '调用工具: exec_command',
        toolName: 'exec_command',
        toolInput: { cmd: 'cat HEARTBEAT.md' },
      }),
      'finger-system-agent',
    );

    expect(event).toBeNull();
  });

  it('rebuilds generic tool_result content with parsed summary', () => {
    const event = mapSessionMessageToRuntimeEvent(
      buildMessage({
        type: 'tool_result',
        content: '工具完成: exec_command',
        toolName: 'exec_command',
        toolInput: { cmd: 'cat HEARTBEAT.md' },
        toolOutput: { ok: true, output: '# HEARTBEAT' },
      }),
      'finger-system-agent',
    );

    expect(event).not.toBeNull();
    expect(event?.content).toContain('[read]');
    expect(event?.content).toContain('HEARTBEAT.md');
    expect(event?.content).toContain('success');
  });

  it('maps update_plan output to planSteps for UI checklist', () => {
    const event = mapSessionMessageToRuntimeEvent(
      buildMessage({
        type: 'tool_result',
        content: '工具完成: update_plan',
        toolName: 'update_plan',
        toolOutput: {
          explanation: '先修复关键显示，再补充细节',
          updatedAt: '2026-03-24T08:00:00.000Z',
          plan: [
            { step: '修复工具结果摘要', status: 'completed' },
            { step: '补充 mailbox 显示', status: 'in_progress' },
          ],
        },
      }),
      'finger-system-agent',
    );

    expect(event).not.toBeNull();
    expect(event?.planSteps).toHaveLength(2);
    expect(event?.planExplanation).toBe('先修复关键显示，再补充细节');
  });
});
