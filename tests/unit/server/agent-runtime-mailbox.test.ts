import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../../../src/core/finger-paths.js';
import type { AgentRuntimeDeps } from '../../../src/server/modules/agent-runtime/types.js';
import { heartbeatMailbox } from '../../../src/server/modules/heartbeat-mailbox.js';
import { registerMailboxRuntimeTools } from '../../../src/server/modules/agent-runtime/mailbox.js';

type RegisteredTool = {
  handler: (input: unknown, context?: Record<string, unknown>) => Promise<unknown>;
};

const cleanupTargets = new Set<string>();

afterEach(() => {
  for (const target of cleanupTargets) {
    fs.rmSync(path.join(FINGER_PATHS.home, 'mailbox', target), { recursive: true, force: true });
  }
  cleanupTargets.clear();
});

function createDeps() {
  const tools = new Map<string, RegisteredTool>();
  const eventBusEmit = vi.fn(async () => {});
  const runtime = {
    registerTool: vi.fn((tool: { name: string; handler: RegisteredTool['handler'] }) => {
      tools.set(tool.name, { handler: tool.handler });
    }),
  };

  const deps = {
    runtime,
    eventBus: { emit: eventBusEmit },
  } as unknown as AgentRuntimeDeps;

  registerMailboxRuntimeTools(deps);
  return { tools, eventBusEmit };
}

function getTool(tools: Map<string, RegisteredTool>, name: string): RegisteredTool {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Tool not registered: ${name}`);
  }
  return tool;
}

describe('agent runtime mailbox tools', () => {
  it('registers mailbox tools into runtime tool list', () => {
    const { tools } = createDeps();
    expect(Array.from(tools.keys())).toEqual([
      'mailbox.status',
      'mailbox.list',
      'mailbox.read',
      'mailbox.ack',
    ]);
  });

  it('moves dispatch task to processing on read and completes it on ack', async () => {
    const { tools, eventBusEmit } = createDeps();
    const targetAgentId = `test-mailbox-agent-${Date.now()}-processing`;
    cleanupTargets.add(targetAgentId);

    const appended = heartbeatMailbox.append(targetAgentId, {
      type: 'dispatch-task',
      dispatchId: 'dispatch-mailbox-1',
      sourceAgentId: 'finger-system-agent',
      targetAgentId,
      sessionId: 'session-mailbox-1',
      assignment: { taskId: 'task-mailbox-1' },
    }, {
      sender: 'finger-system-agent',
      category: 'dispatch-task',
      priority: 0,
    });

    const readResult = await getTool(tools, 'mailbox.read').handler(
      { id: appended.id },
      { agentId: targetAgentId },
    ) as {
      success: boolean;
      handshake: { movedToProcessing: boolean };
      message: { status: string };
    };

    expect(readResult.success).toBe(true);
    expect(readResult.handshake.movedToProcessing).toBe(true);
    expect(readResult.message.status).toBe('processing');
    expect(eventBusEmit).toHaveBeenCalledTimes(1);
    expect(eventBusEmit.mock.calls[0][0].payload.status).toBe('processing');

    const ackResult = await getTool(tools, 'mailbox.ack').handler(
      { id: appended.id, summary: 'mailbox done' },
      { agentId: targetAgentId },
    ) as {
      success: boolean;
      status: string;
      message: { ackAt?: string; result?: { summary?: string } };
    };

    expect(ackResult.success).toBe(true);
    expect(ackResult.status).toBe('completed');
    expect(ackResult.message.ackAt).toBeDefined();
    expect(ackResult.message.result).toEqual({ summary: 'mailbox done' });
    expect(eventBusEmit).toHaveBeenCalledTimes(2);
    expect(eventBusEmit.mock.calls[1][0].payload.status).toBe('completed');
    expect(eventBusEmit.mock.calls[1][0].payload.result.summary).toBe('mailbox done');
  });

  it('keeps notification as pending when read and rejects ack before read for tasks', async () => {
    const { tools, eventBusEmit } = createDeps();
    const notificationAgentId = `test-mailbox-agent-${Date.now()}-notification`;
    const taskAgentId = `${notificationAgentId}-task`;
    cleanupTargets.add(notificationAgentId);
    cleanupTargets.add(taskAgentId);

    const notification = heartbeatMailbox.append(notificationAgentId, {
      type: 'dispatch-result',
      dispatchId: 'dispatch-notify-1',
      sourceAgentId: 'finger-project-agent',
      targetAgentId: notificationAgentId,
    }, {
      sender: 'finger-project-agent',
      category: 'notification',
      priority: 2,
    });

    const notificationRead = await getTool(tools, 'mailbox.read').handler(
      { id: notification.id },
      { agentId: notificationAgentId },
    ) as {
      success: boolean;
      handshake: { movedToProcessing: boolean; requiresAck: boolean };
      message: { status: string };
    };
    expect(notificationRead.success).toBe(true);
    expect(notificationRead.handshake.movedToProcessing).toBe(false);
    expect(notificationRead.handshake.requiresAck).toBe(false);
    expect(notificationRead.message.status).toBe('pending');

    const task = heartbeatMailbox.append(taskAgentId, {
      type: 'dispatch-task',
      dispatchId: 'dispatch-task-ack-1',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: taskAgentId,
    }, {
      sender: 'finger-system-agent',
      category: 'dispatch-task',
      priority: 0,
    });

    const ackBeforeRead = await getTool(tools, 'mailbox.ack').handler(
      { id: task.id, summary: 'should fail' },
      { agentId: taskAgentId },
    ) as { success: boolean; error?: string };

    expect(ackBeforeRead.success).toBe(false);
    expect(ackBeforeRead.error).toContain('mailbox.read');
    expect(eventBusEmit).toHaveBeenCalledTimes(0);
  });
});
