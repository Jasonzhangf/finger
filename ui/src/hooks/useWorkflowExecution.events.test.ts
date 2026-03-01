import { describe, expect, it } from 'vitest';
import type { WsMessage } from '../api/types.js';
import { describeOrchestratorPhase, mapOrchestratorPhaseToUiState } from './useWorkflowExecution.phase.js';
import { mapWsMessageToRuntimeEvent } from './useWorkflowExecution.ws.js';

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

  it('ignores tool_call events in conversation stream', () => {
    const msg: WsMessage = {
      type: 'tool_call',
      sessionId: 'session-1',
      agentId: 'chat-codex',
      timestamp: '2026-02-25T10:00:00.000Z',
      payload: {
        input: {
          cmd: 'pwd',
          login: true,
          shell: '/bin/zsh',
        },
      },
    };

    const event = mapWsMessageToRuntimeEvent(msg, 'session-1');
    expect(event).toBeNull();
  });

  it('includes command summary in tool_result content when input is provided', () => {
    const msg: WsMessage = {
      type: 'tool_result',
      sessionId: 'session-1',
      agentId: 'chat-codex',
      timestamp: '2026-02-25T10:00:00.000Z',
      payload: {
        input: {
          cmd: 'ls -la',
        },
        output: {
          ok: true,
          exitCode: 0,
          output: 'total 0',
        },
      },
    };

    const event = mapWsMessageToRuntimeEvent(msg, 'session-1');
    expect(event).not.toBeNull();
    expect(event?.content).toContain('执行成功：ls -la');
  });

  it('infers exec_command result output shape and avoids unknown tool output rendering', () => {
    const msg: WsMessage = {
      type: 'tool_result',
      sessionId: 'session-1',
      agentId: 'chat-codex',
      timestamp: '2026-02-25T10:00:00.000Z',
      payload: {
        output: {
          ok: true,
          exitCode: 0,
          output: '/Users/fanzhang/Documents/code/finger\n',
          wall_time_seconds: 0.034,
          termination: { type: 'exited', exitCode: 0 },
        },
      },
    };

    const event = mapWsMessageToRuntimeEvent(msg, 'session-1');
    expect(event).not.toBeNull();
    expect(event?.toolName).toBe('exec_command');
    expect(typeof event?.toolOutput).toBe('string');
    expect(String(event?.toolOutput)).toContain('/Users/fanzhang/Documents/code/finger');
  });

  it('maps agent_runtime_dispatch to system status event', () => {
    const msg: WsMessage = {
      type: 'agent_runtime_dispatch',
      sessionId: 'session-1',
      timestamp: '2026-02-25T10:00:00.000Z',
      payload: {
        targetAgentId: 'executor-debug-loop',
        status: 'queued',
      },
    };

    const event = mapWsMessageToRuntimeEvent(msg, 'session-1');
    expect(event).not.toBeNull();
    expect(event?.role).toBe('system');
    expect(event?.content).toContain('[dispatch]');
  });

  it('maps agent_runtime_mock_assertion to summary event', () => {
    const msg: WsMessage = {
      type: 'agent_runtime_mock_assertion',
      sessionId: 'session-1',
      timestamp: '2026-02-25T10:00:00.000Z',
      payload: {
        id: 'assert-1',
        content: 'task-1',
        result: {
          ok: true,
          summary: 'pass',
        },
      },
    };

    const event = mapWsMessageToRuntimeEvent(msg, 'session-1');
    expect(event).not.toBeNull();
    expect(event?.content).toContain('[assert]');
    expect(event?.content).toContain('pass');
  });

  it('maps orchestrator v2 phase to paused wait-user state', () => {
    const result = mapOrchestratorPhaseToUiState('resume_ask');
    expect(result.status).toBe('paused');
    expect(result.fsmState).toBe('wait_user_decision');
    expect(result.paused).toBe(true);
    expect(result.runPhase).toBe('idle');
  });

  it('maps orchestrator v2 review phase to executing review state', () => {
    const result = mapOrchestratorPhaseToUiState('review_accept');
    expect(result.status).toBe('executing');
    expect(result.fsmState).toBe('review');
    expect(result.runPhase).toBe('running');
  });

  it('uses readable labels for phase_transition events', () => {
    const msg: WsMessage = {
      type: 'phase_transition',
      sessionId: 'session-1',
      timestamp: '2026-02-25T10:00:00.000Z',
      payload: {
        from: 'observe',
        to: 'research_eval',
      },
    };
    const event = mapWsMessageToRuntimeEvent(msg, 'session-1');
    expect(event).not.toBeNull();
    expect(event?.content).toContain('定义观察目标');
    expect(event?.content).toContain('研究充分性评估');
  });

  it('returns fallback label for unknown phase', () => {
    expect(describeOrchestratorPhase('custom_phase')).toBe('custom_phase');
  });
});
