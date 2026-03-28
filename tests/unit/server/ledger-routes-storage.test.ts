import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function writeJsonl(filePath: string, entries: unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n'));
}

describe('listLedgerSessionsSnapshot', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads message counts from the ledger directory even when session metadata lives under a normalized session-* dir', async () => {
    const fingerHome = mkdtempSync(join(tmpdir(), 'finger-ledger-storage-'));
    tempRoots.push(fingerHome);

    const metaDir = join(fingerHome, 'system', 'sessions', 'session-live-continuity-check');
    const ledgerDir = join(fingerHome, 'system', 'sessions', 'live-continuity-check', 'finger-system-agent', 'main');

    writeJson(join(metaDir, 'main.json'), {
      id: 'live-continuity-check',
      name: 'finger-system-agent',
      projectPath: join(fingerHome, 'system'),
      createdAt: '2026-03-28T14:32:20.054Z',
      updatedAt: '2026-03-28T14:32:39.212Z',
      lastAccessedAt: '2026-03-28T14:32:39.212Z',
      messages: [],
      activeWorkflows: [],
      context: {},
      latestCompactIndex: -1,
      originalStartIndex: 0,
      originalEndIndex: 3,
      totalTokens: 32,
    });

    writeJsonl(join(ledgerDir, 'context-ledger.jsonl'), [
      {
        id: 'led-1',
        timestamp_ms: 1774708340056,
        timestamp_iso: '2026-03-28T14:32:20.056Z',
        session_id: 'live-continuity-check',
        agent_id: 'finger-system-agent',
        mode: 'main',
        event_type: 'session_message',
        payload: {
          role: 'user',
          content: '第一轮请求',
          token_count: 12,
        },
      },
      {
        id: 'led-2',
        timestamp_ms: 1774708342976,
        timestamp_iso: '2026-03-28T14:32:22.976Z',
        session_id: 'live-continuity-check',
        agent_id: 'finger-system-agent',
        mode: 'main',
        event_type: 'session_message',
        payload: {
          role: 'assistant',
          content: 'SystemBot: OK-1',
          token_count: 20,
        },
      },
    ]);

    vi.stubEnv('FINGER_HOME', fingerHome);
    vi.resetModules();

    const { listLedgerSessionsSnapshot } = await import('../../../src/server/routes/ledger-routes-storage.js');
    const sessions = listLedgerSessionsSnapshot();
    const matched = sessions.find((item) => item.id === 'live-continuity-check');

    expect(matched).toBeTruthy();
    expect(matched?.messageCount).toBe(2);
    expect(matched?.totalTokens).toBe(32);
    expect(matched?.projectPath).toBe(join(fingerHome, 'system'));
    expect(matched?.lastMessageAt).toBe('2026-03-28T14:32:22.976Z');
    expect(matched?.relationKind).toBe('standalone');
    expect(matched?.childSessionCount).toBe(0);
    expect(matched?.previewMessages).toEqual([
      {
        role: 'user',
        timestamp: '2026-03-28T14:32:20.056Z',
        summary: '第一轮请求',
      },
      {
        role: 'assistant',
        timestamp: '2026-03-28T14:32:22.976Z',
        summary: 'SystemBot: OK-1',
      },
    ]);
  });

  it('builds root/child relation metadata for session snapshots', async () => {
    const fingerHome = mkdtempSync(join(tmpdir(), 'finger-ledger-rel-'));
    tempRoots.push(fingerHome);

    const systemRoot = join(fingerHome, 'system', 'sessions');
    const rootDir = join(systemRoot, 'session-root-1');
    const childDir = join(systemRoot, 'session-child-1');

    writeJson(join(rootDir, 'main.json'), {
      id: 'session-root-1',
      name: 'Root Session',
      projectPath: join(fingerHome, 'system'),
      context: {
        sessionTier: 'orchestrator-root',
      },
    });
    writeJson(join(childDir, 'main.json'), {
      id: 'session-child-1',
      name: 'Child Session',
      projectPath: join(fingerHome, 'system'),
      context: {
        sessionTier: 'runtime',
        parentSessionId: 'session-root-1',
        rootSessionId: 'session-root-1',
        ownerAgentId: 'finger-project-agent',
      },
    });

    writeJsonl(join(rootDir, 'finger-system-agent', 'main', 'context-ledger.jsonl'), [
      {
        id: 'root-msg-1',
        timestamp_ms: 1774708342056,
        timestamp_iso: '2026-03-28T14:32:22.056Z',
        event_type: 'session_message',
        payload: { role: 'user', content: 'root', token_count: 3 },
      },
    ]);
    writeJsonl(join(childDir, 'finger-project-agent', 'main', 'context-ledger.jsonl'), [
      {
        id: 'child-msg-1',
        timestamp_ms: 1774708343056,
        timestamp_iso: '2026-03-28T14:32:23.056Z',
        event_type: 'session_message',
        payload: { role: 'assistant', content: 'child', token_count: 4 },
      },
    ]);

    vi.stubEnv('FINGER_HOME', fingerHome);
    vi.resetModules();

    const { listLedgerSessionsSnapshot } = await import('../../../src/server/routes/ledger-routes-storage.js');
    const sessions = listLedgerSessionsSnapshot();
    const root = sessions.find((item) => item.id === 'session-root-1');
    const child = sessions.find((item) => item.id === 'session-child-1');

    expect(root).toBeTruthy();
    expect(root?.relationKind).toBe('root');
    expect(root?.childSessionCount).toBe(1);
    expect(root?.childSessions).toEqual([
      expect.objectContaining({
        id: 'session-child-1',
        ownerAgentId: 'finger-project-agent',
      }),
    ]);

    expect(child).toBeTruthy();
    expect(child?.relationKind).toBe('child');
    expect(child?.isRuntimeChild).toBe(true);
  });
});
