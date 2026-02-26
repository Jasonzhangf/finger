import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import { executeContextLedgerMemory } from '../../../src/runtime/context-ledger-memory.js';

function setupLedgerRoot(tag: string): { rootDir: string; sessionId: string; agentId: string; mode: string } {
  const now = Date.now();
  const rootDir = join(tmpdir(), `finger-ledger-memory-${tag}-${now}`);
  const sessionId = 's1';
  const agentId = 'chat-codex';
  const mode = 'main';
  const dir = join(rootDir, sessionId, agentId, mode);
  mkdirSync(dir, { recursive: true });

  const ledgerPath = join(dir, 'context-ledger.jsonl');
  const compactPath = join(dir, 'compact-memory.jsonl');

  writeFileSync(
    ledgerPath,
    [
      JSON.stringify({
        id: 'led-1',
        timestamp_ms: now - 4_000,
        timestamp_iso: new Date(now - 4_000).toISOString(),
        session_id: sessionId,
        agent_id: agentId,
        mode,
        event_type: 'tool_call',
        payload: { tool: 'shell.exec', command: 'ls -la' },
      }),
      JSON.stringify({
        id: 'led-2',
        timestamp_ms: now - 2_000,
        timestamp_iso: new Date(now - 2_000).toISOString(),
        session_id: sessionId,
        agent_id: agentId,
        mode,
        event_type: 'tool_result',
        payload: { ok: true, stdout: 'README.md' },
      }),
      '',
    ].join('\n'),
    'utf-8',
  );

  writeFileSync(
    compactPath,
    [
      JSON.stringify({
        id: 'cpt-1',
        timestamp_ms: now - 1_000,
        timestamp_iso: new Date(now - 1_000).toISOString(),
        session_id: sessionId,
        agent_id: agentId,
        mode,
        payload: {
          summary: 'Filesystem listing and readme write completed',
          source_time_start: new Date(now - 5_000).toISOString(),
          source_time_end: new Date(now - 1_500).toISOString(),
        },
      }),
      '',
    ].join('\n'),
    'utf-8',
  );

  return { rootDir, sessionId, agentId, mode };
}

describe('context-ledger-memory', () => {
  it('uses compact-first strategy for fuzzy misses in raw timeline', async () => {
    const setup = setupLedgerRoot('compact-first');

    const result = await executeContextLedgerMemory({
      action: 'query',
      contains: 'filesytem listng', // typo intended for fuzzy
      fuzzy: true,
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('query');
    if (result.action !== 'query') {
      throw new Error('expected query result');
    }
    expect(result.strategy).toBe('compact_first');
    expect(result.entries.length).toBe(0);
    expect(result.compact_hits.length).toBeGreaterThan(0);

    rmSync(setup.rootDir, { recursive: true, force: true });
  });

  it('supports detail drill-down after compact hit', async () => {
    const setup = setupLedgerRoot('compact-detail');

    const result = await executeContextLedgerMemory({
      action: 'query',
      contains: 'filesytem listng',
      fuzzy: true,
      detail: true,
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('query');
    if (result.action !== 'query') {
      throw new Error('expected query result');
    }
    expect(result.strategy).toBe('compact_then_detail');
    expect(result.entries.length).toBeGreaterThan(0);

    rmSync(setup.rootDir, { recursive: true, force: true });
  });

  it('inserts text into focus slot with append mode', async () => {
    const setup = setupLedgerRoot('insert-focus');
    const baseContext = {
      root_dir: setup.rootDir,
      session_id: setup.sessionId,
      agent_id: setup.agentId,
      mode: setup.mode,
      focus_max_chars: 1000,
    };

    const first = await executeContextLedgerMemory({
      action: 'insert',
      text: 'first line',
      _runtime_context: baseContext,
    });
    expect(first.ok).toBe(true);
    expect(first.action).toBe('insert');
    if (first.action !== 'insert') {
      throw new Error('expected insert result');
    }

    const second = await executeContextLedgerMemory({
      action: 'insert',
      text: 'second line',
      append: true,
      _runtime_context: baseContext,
    });
    expect(second.ok).toBe(true);
    expect(second.action).toBe('insert');
    if (second.action !== 'insert') {
      throw new Error('expected insert result');
    }
    expect(second.chars).toBeGreaterThan('second line'.length);

    rmSync(setup.rootDir, { recursive: true, force: true });
  });

  it('filters prompt-like blocks and keeps timeline sorted', async () => {
    const setup = setupLedgerRoot('sort-filter');
    const dir = join(setup.rootDir, setup.sessionId, setup.agentId, setup.mode);
    const now = Date.now();

    writeFileSync(
      join(dir, 'context-ledger.jsonl'),
      [
        JSON.stringify({
          id: 'led-b',
          timestamp_ms: now - 1_000,
          timestamp_iso: new Date(now - 1_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'message',
          payload: { text: '<system_message>hidden prompt</system_message>' },
        }),
        JSON.stringify({
          id: 'led-a',
          timestamp_ms: now - 5_000,
          timestamp_iso: new Date(now - 5_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'tool_call',
          payload: { command: 'pwd' },
        }),
        JSON.stringify({
          id: 'led-c',
          timestamp_ms: now - 2_000,
          timestamp_iso: new Date(now - 2_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'tool_result',
          payload: { stdout: '/tmp' },
        }),
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await executeContextLedgerMemory({
      action: 'query',
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });

    if (result.action !== 'query') {
      throw new Error('expected query result');
    }
    expect(result.entries.length).toBe(2);
    expect(result.entries[0].timestamp_ms).toBeLessThanOrEqual(result.entries[1].timestamp_ms);
    expect(JSON.stringify(result.entries)).not.toContain('<system_message>');

    rmSync(setup.rootDir, { recursive: true, force: true });
  });
});
