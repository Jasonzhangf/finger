import { describe, expect, it } from 'vitest';
import type { TaskNode, WsMessage } from '../api/types.js';
import { extractChatReply } from './useWorkflowExecution.reply.js';
import { buildExecutionRoundsFromTasks, buildRoundExecutionPath } from './useWorkflowExecution.runtime.js';
import { mapWsMessageToRuntimeEvent } from './useWorkflowExecution.ws.js';

describe('useWorkflowExecution agent source of truth helpers', () => {
  it('extractChatReply uses session agent fallback when module is absent', () => {
    const result = extractChatReply({ response: 'ok' }, 'custom-orchestrator');
    expect(result.agentId).toBe('custom-orchestrator');
    expect(result.reply).toBe('ok');
  });

  it('runtime execution path uses provided orchestrator id', () => {
    const tasks: TaskNode[] = [
      {
        id: '1-task',
        description: 'run task',
        status: 'in_progress',
        assignee: 'finger-executor',
        dependencies: [],
      },
    ];
    const path = buildRoundExecutionPath(tasks, 'custom-orchestrator');
    expect(path).toHaveLength(1);
    expect(path[0]).toMatchObject({
      from: 'custom-orchestrator',
      to: 'finger-executor',
    });
  });

  it('execution rounds use provided orchestrator id for fallback edge/agent', () => {
    const tasks: TaskNode[] = [
      {
        id: '1-task',
        description: 'run task',
        status: 'ready',
        dependencies: [],
      },
    ];
    const rounds = buildExecutionRoundsFromTasks(tasks, 'custom-orchestrator');
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.agents[0]?.agentId).toBe('custom-orchestrator');
    expect(rounds[0]?.edges[0]).toMatchObject({
      from: 'custom-orchestrator',
      to: 'custom-orchestrator',
    });
  });

  it('ws mapping uses provided fallback agent id', () => {
    const msg: WsMessage = {
      type: 'assistant_complete',
      sessionId: 'session-1',
      timestamp: '2026-03-08T00:00:00.000Z',
      payload: {
        content: 'done',
      },
    };
    const event = mapWsMessageToRuntimeEvent(msg, 'session-1', 'custom-orchestrator');
    expect(event?.agentId).toBe('custom-orchestrator');
    expect(event?.agentName).toBe('custom-orchestrator');
  });
});
