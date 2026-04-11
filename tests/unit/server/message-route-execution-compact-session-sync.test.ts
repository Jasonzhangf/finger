import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { executeBlockingMessageRoute } from '../../../src/server/routes/message-route-execution.js';
import { resolveBaseDir } from '../../../src/runtime/context-ledger-memory-helpers.js';
import { SessionManager } from '../../../src/orchestration/session-manager.js';

describe('message-route execution compact session sync', () => {
  it('replaces session snapshot and pointers from kernel compact api_history before persisting assistant reply', async () => {
    const sessionManager = new SessionManager();
    const projectPath = `/tmp/finger-compact-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = sessionManager.createSession(projectPath, 'compact sync route test');
    sessionManager.updateContext(session.id, { ownerAgentId: 'finger-system-agent' });

    await sessionManager.addMessage(session.id, 'user', 'legacy raw history');
    await sessionManager.addMessage(session.id, 'assistant', 'legacy raw reply');
    await sessionManager.addMessage(session.id, 'user', 'continue after compact');

    const ledgerRoot = sessionManager.resolveLedgerRootForSession(session.id);
    expect(ledgerRoot).not.toBeNull();
    const compactDir = resolveBaseDir(ledgerRoot!, session.id, 'finger-system-agent', 'main');
    fs.mkdirSync(compactDir, { recursive: true });
    fs.writeFileSync(
      path.join(compactDir, 'compact-memory.jsonl'),
      `${JSON.stringify({
        id: 'cpt-1',
        timestamp_ms: Date.now(),
        timestamp_iso: new Date().toISOString(),
        session_id: session.id,
        agent_id: 'finger-system-agent',
        mode: 'main',
        payload: {
          algorithm: 'task_digest_v2',
          summary: 'algorithm=task_digest_v2',
          replacement_history: [
            {
              task_id: 'task-1',
              request: 'legacy raw history',
              summary: 'legacy summary',
              tags: ['compact'],
              topic: 'compaction',
            },
          ],
        },
      })}\n`,
      'utf-8',
    );

    const rawResult = {
      success: true,
      response: 'final after compact',
      metadata: {
        kernelMode: 'main',
        mode: 'main',
        compact: {
          applied: true,
          summary: 'algorithm=task_digest_v2',
        },
        api_history: [
          {
            id: 'digest-1',
            role: 'assistant',
            timestamp_iso: '2026-04-09T12:00:00.000Z',
            content: [
              {
                type: 'output_text',
                text: '<task_digest>{"task_id":"task-1","request":"legacy raw history","summary":"legacy summary","tags":["compact"],"topic":"compaction"}</task_digest>',
              },
            ],
          },
          {
            id: 'user-2',
            role: 'user',
            timestamp_iso: '2026-04-09T12:01:00.000Z',
            content: [
              { type: 'input_text', text: 'continue after compact' },
            ],
          },
          {
            id: 'assistant-2',
            role: 'assistant',
            timestamp_iso: '2026-04-09T12:02:00.000Z',
            content: [
              { type: 'output_text', text: 'final after compact' },
            ],
          },
        ],
      },
    };

    const mailbox = {
      updateStatus: vi.fn(),
    };

    const deps = {
      hub: {
        sendToModule: vi.fn(async () => rawResult),
      },
      mailbox,
      sessionManager,
      channelBridgeManager: {},
      broadcast: vi.fn(),
      writeMessageErrorSample: vi.fn(),
      blockingTimeoutMs: 3_000,
      blockingMaxRetries: 0,
      blockingRetryBaseMs: 10,
    } as any;

    const result = await executeBlockingMessageRoute({
      deps,
      body: { sender: 'cli', blocking: true },
      targetId: 'finger-system-agent',
      requestMessage: { text: 'continue after compact' },
      requestSessionId: session.id,
      messageId: 'route-msg-1',
      shouldPersistSession: true,
      channelId: 'cli',
      displayChannels: [],
      parsedCommand: { shouldSwitch: false, targetAgent: 'finger-system-agent' },
    });

    expect(result.statusCode).toBe(200);

    const reloaded = new SessionManager();
    const persisted = reloaded.getSession(session.id);
    expect(persisted).not.toBeNull();
    expect(persisted?.latestCompactIndex).toBe(0);
    expect(persisted?.originalStartIndex).toBe(0);
    expect(persisted?.originalEndIndex).toBe(2);
    expect(persisted?.pointers?.contextHistory.endLine).toBe(0);
    expect(persisted?.pointers?.currentHistory.startLine).toBe(1);
    expect(persisted?.messages.length).toBeGreaterThanOrEqual(3);
    expect(persisted?.messages[0]?.metadata?.compactDigest).toBeTruthy();
    expect(persisted?.messages[0]?.metadata?.contextZone).toBe('historical_memory');
    expect(persisted?.messages[2]?.content).toBe('final after compact');

    const hydrated = reloaded.getMessages(session.id, 0);
    expect(hydrated).toHaveLength(3);
    expect(hydrated[0]?.content).toContain('<task_digest>');
    expect(hydrated[2]?.content).toBe('final after compact');
  });

  it('still syncs compacted session projection when module result is failed but carries kernel compact metadata', async () => {
    const sessionManager = new SessionManager();
    const projectPath = `/tmp/finger-compact-sync-failed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = sessionManager.createSession(projectPath, 'compact sync failed route test');
    sessionManager.updateContext(session.id, { ownerAgentId: 'finger-system-agent' });

    await sessionManager.addMessage(session.id, 'user', 'legacy raw history');
    await sessionManager.addMessage(session.id, 'assistant', 'legacy raw reply');
    await sessionManager.addMessage(session.id, 'user', 'continue after compact');

    const ledgerRoot = sessionManager.resolveLedgerRootForSession(session.id);
    expect(ledgerRoot).not.toBeNull();
    const compactDir = resolveBaseDir(ledgerRoot!, session.id, 'finger-system-agent', 'main');
    fs.mkdirSync(compactDir, { recursive: true });
    fs.writeFileSync(
      path.join(compactDir, 'compact-memory.jsonl'),
      `${JSON.stringify({
        id: 'cpt-failed-1',
        timestamp_ms: Date.now(),
        timestamp_iso: new Date().toISOString(),
        session_id: session.id,
        agent_id: 'finger-system-agent',
        mode: 'main',
        payload: {
          algorithm: 'task_digest_v2',
          summary: 'algorithm=task_digest_v2',
          replacement_history: [
            {
              task_id: 'task-failed-1',
              request: 'legacy raw history',
              summary: 'legacy summary failed path',
              tags: ['compact'],
              topic: 'compaction',
            },
          ],
        },
      })}\n`,
      'utf-8',
    );

    const rawResult = {
      success: false,
      error: 'post-turn followup failed',
      response: 'partial reply before stop-tool failure',
      metadata: {
        kernelMode: 'main',
        mode: 'main',
        compact: {
          applied: true,
          summary: 'algorithm=task_digest_v2',
        },
        api_history: [
          {
            id: 'digest-failed-1',
            role: 'assistant',
            timestamp_iso: '2026-04-09T12:00:00.000Z',
            content: [
              {
                type: 'output_text',
                text: '<task_digest>{"task_id":"task-failed-1","request":"legacy raw history","summary":"legacy summary failed path","tags":["compact"],"topic":"compaction"}</task_digest>',
              },
            ],
          },
          {
            id: 'user-failed-2',
            role: 'user',
            timestamp_iso: '2026-04-09T12:01:00.000Z',
            content: [
              { type: 'input_text', text: 'continue after compact' },
            ],
          },
          {
            id: 'assistant-failed-2',
            role: 'assistant',
            timestamp_iso: '2026-04-09T12:02:00.000Z',
            content: [
              { type: 'output_text', text: 'partial reply before stop-tool failure' },
            ],
          },
        ],
      },
    };

    const mailbox = {
      updateStatus: vi.fn(),
    };

    const deps = {
      hub: {
        sendToModule: vi.fn(async () => rawResult),
      },
      mailbox,
      sessionManager,
      channelBridgeManager: {},
      broadcast: vi.fn(),
      writeMessageErrorSample: vi.fn(),
      blockingTimeoutMs: 3_000,
      blockingMaxRetries: 0,
      blockingRetryBaseMs: 10,
    } as any;

    const result = await executeBlockingMessageRoute({
      deps,
      body: { sender: 'cli', blocking: true },
      targetId: 'finger-system-agent',
      requestMessage: { text: 'continue after compact' },
      requestSessionId: session.id,
      messageId: 'route-msg-failed-1',
      shouldPersistSession: true,
      channelId: 'cli',
      displayChannels: [],
      parsedCommand: { shouldSwitch: false, targetAgent: 'finger-system-agent' },
    });

    expect(result.statusCode).toBe(200);

    const reloaded = new SessionManager();
    const persisted = reloaded.getSession(session.id);
    expect(persisted).not.toBeNull();
    expect(persisted?.latestCompactIndex).toBe(0);
    expect(persisted?.messages.length).toBeGreaterThanOrEqual(3);
    expect(persisted?.messages[0]?.metadata?.compactDigest).toBeTruthy();
    expect(persisted?.messages[2]?.content).toBe('partial reply before stop-tool failure');
    expect((persisted?.context as Record<string, unknown>).kernelProjection).toMatchObject({
      compactApplied: true,
      latestCompactIndex: 0,
    });
  });
});
