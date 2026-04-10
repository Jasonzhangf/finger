import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { SessionManager } from '../../src/orchestration/session-manager.js';
import { resolveBaseDir } from '../../src/runtime/context-ledger-memory-helpers.js';

function createUniqueProjectPath(prefix: string): string {
  const projectPath = `/tmp/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  mkdirSync(projectPath, { recursive: true });
  return projectPath;
}

describe('session compact projection regression', () => {
  it('syncs compact projection from ledger immediately after digest append', async () => {
    const manager = new SessionManager();
    const session = manager.createSession(createUniqueProjectPath('compact-ledger-sync'), 'Compact Ledger Sync', { allowReuse: false });

    await manager.addMessage(session.id, 'user', 'first live compact message');
    await manager.addMessage(session.id, 'assistant', 'second live compact message');

    await manager.appendDigest(
      session.id,
      {
        id: 'digest-source-msg',
        role: 'assistant',
        content: '<task_digest>{"task_id":"ledger-sync-test","tags":["compact"],"topic":"ledger"}</task_digest>',
        timestamp: new Date().toISOString(),
      },
      ['compact'],
      'finger-system-agent',
      'main',
    );

    const syncResult = await manager.syncProjectionFromLedger(session.id, {
      agentId: 'finger-system-agent',
      mode: 'main',
      source: 'compact_projection_regression',
    });

    expect(syncResult.applied).toBe(true);
    expect((syncResult.latestCompactIndex ?? -1)).toBeGreaterThanOrEqual(0);

    const restored = manager.getSession(session.id);
    expect(restored?.latestCompactIndex).toBeGreaterThanOrEqual(0);
    expect(((restored?.context as Record<string, unknown>)?.kernelProjection as Record<string, unknown>)?.compactApplied).toBe(true);
    expect((restored?.totalTokens ?? 0)).toBeGreaterThan(0);
  });

  it('normalizes kernel compact projection into historical prefix and current suffix', () => {
    const manager = new SessionManager();
    const session = manager.createSession(createUniqueProjectPath('compact-kernel-projection'), 'Compact Kernel Projection', { allowReuse: false });
    manager.updateContext(session.id, { ownerAgentId: 'finger-system-agent' });

    const ledgerRoot = manager.resolveLedgerRootForSession(session.id);
    expect(ledgerRoot).not.toBeNull();
    const compactDir = resolveBaseDir(ledgerRoot!, session.id, 'finger-system-agent', 'main');
    mkdirSync(compactDir, { recursive: true });
    writeFileSync(
      join(compactDir, 'compact-memory.jsonl'),
      `${JSON.stringify({
        id: 'compact-normalize-1',
        timestamp_ms: Date.now(),
        timestamp_iso: new Date().toISOString(),
        session_id: session.id,
        agent_id: 'finger-system-agent',
        mode: 'main',
        payload: {
          algorithm: 'task_digest_v2',
          summary: 'kernel normalize summary',
          replacement_history: [
            { task_id: 'hist-1', summary: 'history 1' },
            { task_id: 'hist-2', summary: 'history 2' },
          ],
        },
      })}\n`,
      'utf-8',
    );

    const syncResult = manager.syncProjectionFromKernelMetadata(session.id, {
      compact: {
        applied: true,
        summary: 'kernel normalize summary',
      },
      api_history: [
        {
          id: '',
          role: 'user',
          timestamp_iso: '2026-04-09T12:00:00.000Z',
          content: [{ type: 'input_text', text: '<environment_context>cwd=/tmp/test-project</environment_context>' }],
        },
        {
          id: 'hist-1',
          role: 'assistant',
          timestamp_iso: '2026-04-09T12:00:01.000Z',
          content: [{ type: 'output_text', text: '<task_digest>{"task_id":"hist-1","summary":"history 1"}</task_digest>' }],
        },
        {
          id: 'hist-2',
          role: 'assistant',
          timestamp_iso: '2026-04-09T12:00:02.000Z',
          content: [{ type: 'output_text', text: '<task_digest>{"task_id":"hist-2","summary":"history 2"}</task_digest>' }],
        },
        {
          id: 'current-user',
          role: 'user',
          timestamp_iso: '2026-04-09T12:00:03.000Z',
          content: [{ type: 'input_text', text: 'continue after compact' }],
        },
        {
          id: 'current-assistant',
          role: 'assistant',
          timestamp_iso: '2026-04-09T12:00:04.000Z',
          content: [{ type: 'output_text', text: 'final reply' }],
        },
      ],
    }, {
      agentId: 'finger-system-agent',
      mode: 'main',
    });

    expect(syncResult.applied).toBe(true);

    const restored = manager.getSession(session.id);
    expect(restored?.messages.map((message) => message.content)).toEqual([
      '<task_digest>{"task_id":"hist-1","summary":"history 1"}</task_digest>',
      '<task_digest>{"task_id":"hist-2","summary":"history 2"}</task_digest>',
      '<environment_context>cwd=/tmp/test-project</environment_context>',
      'continue after compact',
      'final reply',
    ]);
    expect(restored?.messages.every((message) => typeof message.id === 'string' && message.id.trim().length > 0)).toBe(true);
    expect(restored?.messages.slice(0, 2).every((message) => message.metadata?.contextZone === 'historical_memory')).toBe(true);
    expect(restored?.messages.slice(2).every((message) => message.metadata?.contextZone === 'current_history')).toBe(true);
    expect(restored?.pointers?.contextHistory.endLine).toBe(1);
    expect(restored?.pointers?.currentHistory.startLine).toBe(2);
  });

  it('repairs stale compacted projection on startup load', async () => {
    const manager = new SessionManager();
    const session = manager.createSession(createUniqueProjectPath('compact-startup-repair'), 'Compact Startup Repair', { allowReuse: false });

    await manager.addMessage(session.id, 'user', 'startup repair user message');
    await manager.addMessage(session.id, 'assistant', 'startup repair assistant message');
    await manager.appendDigest(
      session.id,
      {
        id: 'startup-repair-digest',
        role: 'assistant',
        content: '<task_digest>{"task_id":"startup-repair","tags":["repair"],"topic":"startup"}</task_digest>',
        timestamp: new Date().toISOString(),
      },
      ['repair'],
      'finger-system-agent',
      'main',
    );

    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    const mainFile = join(sessionDir!, 'main.json');
    const stale = JSON.parse(readFileSync(mainFile, 'utf-8'));
    stale.latestCompactIndex = -1;
    stale.totalTokens = 300000;
    stale.context = stale.context || {};
    delete stale.context.kernelProjection;
    writeFileSync(mainFile, JSON.stringify(stale, null, 2), 'utf-8');

    const reloaded = new SessionManager();
    const repaired = reloaded.getSession(session.id);
    expect(repaired?.latestCompactIndex).toBeGreaterThanOrEqual(0);
    expect(((repaired?.context as Record<string, unknown>)?.kernelProjection as Record<string, unknown>)?.compactApplied).toBe(true);
    expect(((repaired?.context as Record<string, unknown>)?.kernelProjection as Record<string, unknown>)?.source).toBe('startup_ledger_projection_repair');
  });

  it('repairs mixed compact projection ordering on startup load', () => {
    const manager = new SessionManager();
    const session = manager.createSession(createUniqueProjectPath('compact-startup-order-repair'), 'Compact Startup Order Repair', { allowReuse: false });

    const sessionDir = manager.resolveSessionStorageDir(session.id);
    expect(sessionDir).not.toBeNull();
    const mainFile = join(sessionDir!, 'main.json');
    const stale = JSON.parse(readFileSync(mainFile, 'utf-8'));
    stale.latestCompactIndex = 1;
    stale.totalTokens = 999999;
    stale.messages = [
      {
        id: '',
        role: 'user',
        content: '<environment_context>cwd=/tmp/test-project</environment_context>',
        timestamp: '2026-04-09T12:10:00.000Z',
        metadata: { contextZone: 'current_history' },
      },
      {
        id: 'hist-1',
        role: 'assistant',
        content: '<task_digest>{"task_id":"hist-1","summary":"history 1"}</task_digest>',
        timestamp: '2026-04-09T12:10:01.000Z',
        metadata: { contextZone: 'historical_memory', compactDigest: true },
      },
      {
        id: 'hist-2',
        role: 'assistant',
        content: '<task_digest>{"task_id":"hist-2","summary":"history 2"}</task_digest>',
        timestamp: '2026-04-09T12:10:02.000Z',
        metadata: { contextZone: 'historical_memory', compactDigest: true },
      },
      {
        id: 'current-user',
        role: 'user',
        content: 'continue after compact',
        timestamp: '2026-04-09T12:10:03.000Z',
      },
    ];
    stale.pointers = {
      contextHistory: { startLine: 0, endLine: -1, estimatedTokens: 0 },
      currentHistory: { startLine: 0, endLine: 3, estimatedTokens: 0 },
    };
    stale.context = stale.context || {};
    stale.context.kernelProjection = {
      version: 1,
      source: 'rust_kernel_api_history',
      compactApplied: true,
    };
    writeFileSync(mainFile, JSON.stringify(stale, null, 2), 'utf-8');

    const reloaded = new SessionManager();
    const repaired = reloaded.getSession(session.id);

    expect(repaired?.messages.map((message) => message.content)).toEqual([
      '<task_digest>{"task_id":"hist-1","summary":"history 1"}</task_digest>',
      '<task_digest>{"task_id":"hist-2","summary":"history 2"}</task_digest>',
      '<environment_context>cwd=/tmp/test-project</environment_context>',
      'continue after compact',
    ]);
    expect(repaired?.messages.every((message) => typeof message.id === 'string' && message.id.trim().length > 0)).toBe(true);
    expect(repaired?.messages.slice(0, 2).every((message) => message.metadata?.contextZone === 'historical_memory')).toBe(true);
    expect(repaired?.messages.slice(2).every((message) => message.metadata?.contextZone === 'current_history')).toBe(true);
    expect(repaired?.pointers?.contextHistory.endLine).toBe(1);
    expect(repaired?.pointers?.currentHistory.startLine).toBe(2);
  });
});
