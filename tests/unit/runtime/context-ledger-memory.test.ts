import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
    expect(result.slots.length).toBe(0);
    expect(result.compact_hits.length).toBeGreaterThan(0);
    expect(result.next_query_hint).toMatchObject({ action: 'query', detail: true });

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
    expect(result.slots.length).toBeGreaterThan(0);

    rmSync(setup.rootDir, { recursive: true, force: true });
  });

  it('digest_backfill generates replacement_history digests from ledger timeline', async () => {
    const setup = setupLedgerRoot('digest-backfill');

    const result = await executeContextLedgerMemory({
      action: 'digest_backfill',
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('digest_backfill');
    if (result.action !== 'digest_backfill') {
      throw new Error('expected digest_backfill result');
    }
    expect(result.task_digest_count).toBeGreaterThan(0);

    const compactRaw = readFileSync(result.compact_path, 'utf-8')
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { payload?: { replacement_history?: unknown[] } });
    const latest = compactRaw[compactRaw.length - 1];
    const replacementHistory = Array.isArray(latest?.payload?.replacement_history)
      ? latest.payload?.replacement_history
      : [];
    expect(replacementHistory.length).toBe(result.task_digest_count);

    rmSync(setup.rootDir, { recursive: true, force: true });
  });

  it('digest_incremental compacts only newly appended slots since previous digest', async () => {
    const setup = setupLedgerRoot('digest-incremental');
    const dir = join(setup.rootDir, setup.sessionId, setup.agentId, setup.mode);
    const now = Date.now();

    writeFileSync(
      join(dir, 'context-ledger.jsonl'),
      [
        JSON.stringify({
          id: 'msg-1',
          timestamp_ms: now - 10_000,
          timestamp_iso: new Date(now - 10_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'session_message',
          payload: { role: 'user', content: 'task A' },
        }),
        JSON.stringify({
          id: 'msg-2',
          timestamp_ms: now - 9_000,
          timestamp_iso: new Date(now - 9_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'session_message',
          payload: { role: 'assistant', content: 'doing task A' },
        }),
        JSON.stringify({
          id: 'msg-3',
          timestamp_ms: now - 8_000,
          timestamp_iso: new Date(now - 8_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'session_message',
          payload: { role: 'assistant', content: '调用工具: reasoning.stop' },
        }),
        JSON.stringify({
          id: 'msg-4',
          timestamp_ms: now - 4_000,
          timestamp_iso: new Date(now - 4_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'session_message',
          payload: { role: 'user', content: 'task B' },
        }),
        JSON.stringify({
          id: 'msg-5',
          timestamp_ms: now - 3_000,
          timestamp_iso: new Date(now - 3_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'session_message',
          payload: { role: 'assistant', content: 'done task B' },
        }),
        JSON.stringify({
          id: 'msg-6',
          timestamp_ms: now - 2_000,
          timestamp_iso: new Date(now - 2_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'session_message',
          payload: { role: 'assistant', content: '调用工具: reasoning.stop' },
        }),
        '',
      ].join('\n'),
      'utf-8',
    );

    writeFileSync(
      join(dir, 'compact-memory.jsonl'),
      `${JSON.stringify({
        id: 'cpt-old',
        timestamp_ms: now - 6_000,
        timestamp_iso: new Date(now - 6_000).toISOString(),
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
        payload: {
          summary: 'old digest',
          source_slot_start: 1,
          source_slot_end: 3,
          replacement_history: [],
        },
      })}\n`,
      'utf-8',
    );

    const result = await executeContextLedgerMemory({
      action: 'digest_incremental',
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('digest_incremental');
    if (result.action !== 'digest_incremental') {
      throw new Error('expected digest_incremental result');
    }
    expect(result.no_new_entries).toBe(false);
    expect(result.previous_compacted_slot_end).toBe(3);
    expect(result.source_slot_start).toBe(4);
    expect(result.source_slot_end).toBe(6);
    expect(result.task_digest_count).toBeGreaterThan(0);

    const compactRaw = readFileSync(result.compact_path, 'utf-8')
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { payload?: { replacement_history?: unknown[]; source_slot_start?: number; source_slot_end?: number } });
    const latest = compactRaw[compactRaw.length - 1];
    expect(latest?.payload?.source_slot_start).toBe(4);
    expect(latest?.payload?.source_slot_end).toBe(6);
    const replacementHistory = Array.isArray(latest?.payload?.replacement_history)
      ? latest.payload?.replacement_history
      : [];
    expect(replacementHistory.length).toBe(result.task_digest_count);

    rmSync(setup.rootDir, { recursive: true, force: true });
  });

  it('digest_backfill keeps full key_tools list without truncation and parses tool names from payload', async () => {
    const setup = setupLedgerRoot('digest-tools-full');
    const dir = join(setup.rootDir, setup.sessionId, setup.agentId, setup.mode);
    const now = Date.now();
    const toolNames = Array.from({ length: 16 }, (_, index) => `tool.${index + 1}`);

    const rows = [
      JSON.stringify({
        id: 'user-1',
        timestamp_ms: now - 20_000,
        timestamp_iso: new Date(now - 20_000).toISOString(),
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
        event_type: 'session_message',
        payload: { role: 'user', content: 'run many tools' },
      }),
      ...toolNames.flatMap((toolName, index) => ([
        JSON.stringify({
          id: `tool-call-${index + 1}`,
          timestamp_ms: now - 19_000 + (index * 200),
          timestamp_iso: new Date(now - 19_000 + (index * 200)).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'tool_call',
          payload: { tool: toolName, input: { n: index + 1 } },
        }),
        JSON.stringify({
          id: `tool-result-${index + 1}`,
          timestamp_ms: now - 18_900 + (index * 200),
          timestamp_iso: new Date(now - 18_900 + (index * 200)).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'tool_result',
          payload: { tool: toolName, ok: true },
        }),
      ])),
      JSON.stringify({
        id: 'assistant-stop',
        timestamp_ms: now - 1_000,
        timestamp_iso: new Date(now - 1_000).toISOString(),
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
        event_type: 'session_message',
        payload: { role: 'assistant', content: '调用工具: reasoning.stop' },
      }),
      '',
    ];

    writeFileSync(join(dir, 'context-ledger.jsonl'), rows.join('\n'), 'utf-8');
    writeFileSync(join(dir, 'compact-memory.jsonl'), '', 'utf-8');

    const result = await executeContextLedgerMemory({
      action: 'digest_backfill',
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('digest_backfill');
    if (result.action !== 'digest_backfill') {
      throw new Error('expected digest_backfill result');
    }

    const compactRaw = readFileSync(result.compact_path, 'utf-8')
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { payload?: { replacement_history?: unknown[] } });
    const latest = compactRaw[compactRaw.length - 1];
    const replacementHistory = Array.isArray(latest?.payload?.replacement_history)
      ? latest.payload?.replacement_history
      : [];
    expect(replacementHistory.length).toBeGreaterThan(0);
    const firstTask = replacementHistory[0] as { key_tools?: unknown };
    expect(Array.isArray(firstTask.key_tools)).toBe(true);
    const keyTools = firstTask.key_tools as string[];
    expect(keyTools.length).toBe(toolNames.length + 1); // + reasoning.stop
    for (const toolName of toolNames) {
      expect(keyTools.includes(toolName)).toBe(true);
    }
    expect(keyTools.includes('reasoning.stop')).toBe(true);

    rmSync(setup.rootDir, { recursive: true, force: true });
  });

  it('digest_backfill keeps tool call args + status and preserves full output for key tools', async () => {
    const setup = setupLedgerRoot('digest-tool-calls-status');
    const dir = join(setup.rootDir, setup.sessionId, setup.agentId, setup.mode);
    const now = Date.now();

    const rows = [
      JSON.stringify({
        id: 'user-1',
        timestamp_ms: now - 20_000,
        timestamp_iso: new Date(now - 20_000).toISOString(),
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
        event_type: 'session_message',
        payload: { role: 'user', content: 'plan and execute' },
      }),
      JSON.stringify({
        id: 'tool-call-update-plan',
        timestamp_ms: now - 19_000,
        timestamp_iso: new Date(now - 19_000).toISOString(),
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
        event_type: 'tool_call',
        payload: {
          call_id: 'call-up-1',
          tool_name: 'update_plan',
          input: { plan: [{ step: 'A', status: 'in_progress' }] },
        },
      }),
      JSON.stringify({
        id: 'tool-result-update-plan',
        timestamp_ms: now - 18_000,
        timestamp_iso: new Date(now - 18_000).toISOString(),
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
        event_type: 'tool_result',
        payload: {
          call_id: 'call-up-1',
          tool_name: 'update_plan',
          output: {
            ok: true,
            content: 'Plan updated',
            plan: [{ step: 'A', status: 'in_progress' }],
          },
        },
      }),
      JSON.stringify({
        id: 'tool-call-rg',
        timestamp_ms: now - 17_000,
        timestamp_iso: new Date(now - 17_000).toISOString(),
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
        event_type: 'tool_call',
        payload: {
          call_id: 'call-rg-1',
          tool_name: 'exec_command',
          input: { cmd: 'rg -n TODO src' },
        },
      }),
      JSON.stringify({
        id: 'tool-error-rg',
        timestamp_ms: now - 16_000,
        timestamp_iso: new Date(now - 16_000).toISOString(),
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
        event_type: 'tool_error',
        payload: {
          call_id: 'call-rg-1',
          tool_name: 'exec_command',
          error: 'permission denied',
        },
      }),
      JSON.stringify({
        id: 'assistant-stop',
        timestamp_ms: now - 1_000,
        timestamp_iso: new Date(now - 1_000).toISOString(),
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
        event_type: 'session_message',
        payload: { role: 'assistant', content: 'done and stopping' },
      }),
      '',
    ];

    writeFileSync(join(dir, 'context-ledger.jsonl'), rows.join('\n'), 'utf-8');
    writeFileSync(join(dir, 'compact-memory.jsonl'), '', 'utf-8');

    const result = await executeContextLedgerMemory({
      action: 'digest_backfill',
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('digest_backfill');
    if (result.action !== 'digest_backfill') {
      throw new Error('expected digest_backfill result');
    }

    const compactRaw = readFileSync(result.compact_path, 'utf-8')
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { payload?: { replacement_history?: unknown[] } });
    const latest = compactRaw[compactRaw.length - 1];
    const replacementHistory = Array.isArray(latest?.payload?.replacement_history)
      ? latest.payload?.replacement_history
      : [];
    expect(replacementHistory.length).toBeGreaterThan(0);
    const firstTask = replacementHistory[0] as { tool_calls?: unknown[] };
    expect(Array.isArray(firstTask.tool_calls)).toBe(true);
    const toolCalls = (firstTask.tool_calls ?? []) as Array<{ tool?: string; status?: string; input?: string; output?: string }>;
    const updatePlanCall = toolCalls.find((item) => item.tool === 'update_plan');
    expect(updatePlanCall).toBeDefined();
    expect(updatePlanCall?.status).toBe('success');
    expect(typeof updatePlanCall?.input).toBe('string');
    expect(updatePlanCall?.input).toContain('in_progress');
    // key tool output should be kept (not just success/failure)
    expect(typeof updatePlanCall?.output).toBe('string');
    expect(updatePlanCall?.output).toContain('Plan updated');

    const execCall = toolCalls.find((item) => item.tool === 'exec_command');
    expect(execCall).toBeDefined();
    expect(execCall?.status).toBe('failure');
    expect(typeof execCall?.input).toBe('string');
    // non-key tools should not keep full output/error payload
    expect(execCall?.output).toBeUndefined();

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

  it('returns slot summaries by default and keeps timeline sorted', async () => {
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
    expect(result.entries.length).toBe(0);
    expect(result.slots.length).toBe(2);
    expect(result.slots[0].slot).toBe(1);
    expect(result.slots[1].slot).toBe(2);
    expect(result.slots[0].timestamp_ms).toBeLessThanOrEqual(result.slots[1].timestamp_ms);
    expect(JSON.stringify(result.slots)).not.toContain('<system_message>');

    const detail = await executeContextLedgerMemory({
      action: 'query',
      slot_start: 1,
      slot_end: 2,
      detail: true,
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });
    if (detail.action !== 'query') {
      throw new Error('expected query result');
    }
    expect(detail.entries.length).toBe(2);
    expect(detail.entries[0].timestamp_ms).toBeLessThanOrEqual(detail.entries[1].timestamp_ms);
    expect(JSON.stringify(detail.entries)).not.toContain('<system_message>');

    const search = await executeContextLedgerMemory({
      action: 'search',
      contains: 'pwd',
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });
    if (search.action !== 'search') {
      throw new Error('expected search result');
    }
    expect(search.entries.length).toBe(0);
    expect(search.slots.length).toBe(1);
    expect(search.note).toContain('Search returned matching slot summaries only');

    rmSync(setup.rootDir, { recursive: true, force: true });
  });

  it('returns task-block overflow candidates for search and marks omitted history via runtime context', async () => {
    const setup = setupLedgerRoot('task-block-search');
    const dir = join(setup.rootDir, setup.sessionId, setup.agentId, setup.mode);
    const now = Date.now();

    writeFileSync(
      join(dir, 'context-ledger.jsonl'),
      [
        JSON.stringify({
          id: 'msg-1',
          timestamp_ms: now - 8_000,
          timestamp_iso: new Date(now - 8_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'message',
          payload: { role: 'user', content: '帮我修复 mailbox 未读消息堆积问题' },
        }),
        JSON.stringify({
          id: 'msg-2',
          timestamp_ms: now - 7_000,
          timestamp_iso: new Date(now - 7_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'message',
          payload: {
            role: 'assistant',
            content: '已定位 mailbox backlog 根因，准备修复。',
            metadata: { tags: ['mailbox', 'backlog'], topic: 'mailbox cleanup' },
          },
        }),
        JSON.stringify({
          id: 'msg-3',
          timestamp_ms: now - 4_000,
          timestamp_iso: new Date(now - 4_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'message',
          payload: { role: 'user', content: '顺便检查 session ledger 是否会丢历史' },
        }),
        JSON.stringify({
          id: 'msg-4',
          timestamp_ms: now - 3_000,
          timestamp_iso: new Date(now - 3_000).toISOString(),
          session_id: setup.sessionId,
          agent_id: setup.agentId,
          mode: setup.mode,
          event_type: 'message',
          payload: {
            role: 'assistant',
            content: 'session history 已切到 ledger 读取。',
            metadata: { tags: ['ledger'], topic: 'session ledger' },
          },
        }),
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await executeContextLedgerMemory({
      action: 'search',
      contains: 'mailbox backlog',
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
        context_builder: {
          historical_block_ids: ['task-should-not-match'],
          working_set_block_ids: ['task-should-not-match-either'],
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.action).toBe('search');
    if (result.action !== 'search') {
      throw new Error('expected search result');
    }
    expect(result.task_blocks.length).toBeGreaterThan(0);
    expect(result.task_blocks[0]?.preview).toContain('mailbox');
    expect(result.task_blocks[0]?.detail_query_hint).toMatchObject({ action: 'query', detail: true });
    expect(result.context_bridge.searched_full_ledger).toBe(true);
    expect(result.context_bridge.total_slots).toBe(4);
    expect(result.task_blocks[0]?.visibility).toBe('omitted_history');

    rmSync(setup.rootDir, { recursive: true, force: true });
  });

  it('delete_slots returns interactive preview and does not mutate ledger without confirmation', async () => {
    const setup = setupLedgerRoot('delete-preview');

    const preview = await executeContextLedgerMemory({
      action: 'delete_slots',
      slot_ids: [1, 2],
      preview_only: true,
      reason: 'user cleanup request',
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });

    expect(preview.ok).toBe(true);
    expect(preview.action).toBe('delete_slots');
    if (preview.action !== 'delete_slots') {
      throw new Error('expected delete_slots result');
    }
    expect(preview.preview_only).toBe(true);
    expect(preview.requires_confirmation).toBe(true);
    expect(preview.deleted_count).toBe(0);
    expect(preview.selected_total).toBe(2);
    expect(preview.selected_slots[0]?.slot).toBe(1);
    expect(preview.selected_slots[1]?.slot).toBe(2);
    expect(preview.confirmation_phrase).toContain('CONFIRM_DELETE_SLOTS:');
    expect(preview.intent_id).toBeTruthy();

    const query = await executeContextLedgerMemory({
      action: 'query',
      detail: true,
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });
    if (query.action !== 'query') {
      throw new Error('expected query result');
    }
    expect(query.total).toBeGreaterThanOrEqual(2);

    rmSync(setup.rootDir, { recursive: true, force: true });
  });

  it('delete_slots requires explicit authorization token before deleting', async () => {
    const setup = setupLedgerRoot('delete-confirm');

    const denied = await executeContextLedgerMemory({
      action: 'delete_slots',
      slot_ids: [1],
      confirm: true,
      user_authorized: false,
      user_confirmation: 'CONFIRM_DELETE_SLOTS',
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });
    if (denied.action !== 'delete_slots') {
      throw new Error('expected delete_slots result');
    }
    expect(denied.preview_only).toBe(true);
    expect(denied.deleted_count).toBe(0);
    const confirmPhrase = denied.confirmation_phrase;
    const intentId = denied.intent_id;
    expect(confirmPhrase).toContain('CONFIRM_DELETE_SLOTS:');
    expect(intentId).toBeTruthy();

    const confirmed = await executeContextLedgerMemory({
      action: 'delete_slots',
      slot_ids: [1],
      intent_id: intentId,
      confirm: true,
      user_authorized: true,
      user_confirmation: confirmPhrase,
      reason: 'user approved delete',
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });
    if (confirmed.action !== 'delete_slots') {
      throw new Error('expected delete_slots result');
    }
    expect(confirmed.preview_only).toBe(false);
    expect(confirmed.deleted_count).toBe(1);

    const queryAfter = await executeContextLedgerMemory({
      action: 'query',
      detail: true,
      _runtime_context: {
        root_dir: setup.rootDir,
        session_id: setup.sessionId,
        agent_id: setup.agentId,
        mode: setup.mode,
      },
    });
    if (queryAfter.action !== 'query') {
      throw new Error('expected query result');
    }
    expect(queryAfter.total).toBeGreaterThanOrEqual(2);
    const eventTypes = queryAfter.entries.map((entry) => entry.event_type);
    expect(eventTypes).toContain('ledger_slots_deleted');

    rmSync(setup.rootDir, { recursive: true, force: true });
  });
});
