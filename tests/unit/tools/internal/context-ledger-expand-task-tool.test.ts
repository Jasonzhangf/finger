import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { contextLedgerExpandTaskTool } from '../../../../src/tools/internal/context-ledger-expand-task-tool.js';

function writeLedger(rootDir: string): { sessionId: string; agentId: string; taskId: string } {
  const sessionId = 'ctx-expand-s1';
  const agentId = 'finger-system-agent';
  const mode = 'main';
  const dir = join(rootDir, sessionId, agentId, mode);
  mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const taskStartTs = now - 20_000;
  const entries = [
    // Task A: turn_start -> session_message(user) -> session_message(assistant) -> turn_complete
    {
      id: 'ts1',
      timestamp_ms: taskStartTs,
      timestamp_iso: new Date(taskStartTs).toISOString(),
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'turn_start',
      payload: { history_items_count: 0, items_count: 1 },
    },
    {
      id: 'm1',
      timestamp_ms: taskStartTs + 100,
      timestamp_iso: new Date(taskStartTs + 100).toISOString(),
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'session_message',
      payload: { role: 'user', content: '任务A：检查 mailbox', token_count: 8 },
    },
    {
      id: 'm2',
      timestamp_ms: taskStartTs + 500,
      timestamp_iso: new Date(taskStartTs + 500).toISOString(),
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'session_message',
      payload: { role: 'assistant', content: '任务A完成', token_count: 6 },
    },
    {
      id: 'tc1',
      timestamp_ms: taskStartTs + 800,
      timestamp_iso: new Date(taskStartTs + 800).toISOString(),
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'turn_complete',
      payload: { finish_reason: 'stop' },
    },
    // Task B: turn_start -> session_message(user) (incomplete)
    {
      id: 'ts2',
      timestamp_ms: taskStartTs + 5_000,
      timestamp_iso: new Date(taskStartTs + 5_000).toISOString(),
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'turn_start',
      payload: { history_items_count: 2, items_count: 1 },
    },
    {
      id: 'm3',
      timestamp_ms: taskStartTs + 5_100,
      timestamp_iso: new Date(taskStartTs + 5_100).toISOString(),
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'session_message',
      payload: { role: 'user', content: '任务B：继续处理', token_count: 7 },
    },
  ];

  writeFileSync(join(dir, 'context-ledger.jsonl'), `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf-8');
  return {
    sessionId,
    agentId,
    taskId: `task-${taskStartTs}`, // Task A's turn_start timestamp
  };
}

function writeLargeLedger(rootDir: string): { sessionId: string; agentId: string; oldestTaskId: string } {
  const sessionId = 'ctx-expand-large-s1';
  const agentId = 'finger-system-agent';
  const mode = 'main';
  const dir = join(rootDir, sessionId, agentId, mode);
  mkdirSync(dir, { recursive: true });

  const baseTs = Date.now() - 1_000_000;
  const entries: Array<Record<string, unknown>> = [];
  const taskCount = 520;
  for (let index = 0; index < taskCount; index += 1) {
    const userTs = baseTs + index * 1_000;
    const stopTs = userTs + 300;
    entries.push({
      id: `u-${index}`,
      timestamp_ms: userTs,
      timestamp_iso: new Date(userTs).toISOString(),
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'session_message',
      payload: { role: 'user', content: `task-${index} user`, token_count: 4 },
    });
    entries.push({
      id: `s-${index}`,
      timestamp_ms: stopTs,
      timestamp_iso: new Date(stopTs).toISOString(),
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'session_message',
      payload: {
        role: 'assistant',
        content: '调用工具: reasoning.stop',
        token_count: 6,
      },
    });
  }

  writeFileSync(join(dir, 'context-ledger.jsonl'), `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf-8');
  return {
    sessionId,
    agentId,
    oldestTaskId: `task-${baseTs}`,
  };
}

describe('context_ledger.expand_task tool', () => {
  it('expands with explicit slot_start/slot_end', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'finger-expand-task-tool-'));
    const { sessionId, agentId } = writeLedger(rootDir);

    try {
      const result = await contextLedgerExpandTaskTool.execute(
        {
          session_id: sessionId,
          agent_id: agentId,
          slot_start: 1,
          slot_end: 2,
          _runtime_context: { root_dir: rootDir },
        },
        {
          invocationId: 'tool-expand-1',
          cwd: process.cwd(),
          timestamp: new Date().toISOString(),
          sessionId,
          agentId,
        },
      );

      expect(result.ok).toBe(true);
      expect(result.action).toBe('expand_task');
      expect(result.slotStart).toBe(1);
      expect(result.slotEnd).toBe(2);
      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.slots.length).toBeGreaterThan(0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('resolves slot range by task_id and expands full detail', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'finger-expand-task-tool-'));
    const { sessionId, agentId, taskId } = writeLedger(rootDir);

    try {
      const result = await contextLedgerExpandTaskTool.execute(
        {
          session_id: sessionId,
          agent_id: agentId,
          task_id: taskId,
          _runtime_context: { root_dir: rootDir },
        },
        {
          invocationId: 'tool-expand-2',
          cwd: process.cwd(),
          timestamp: new Date().toISOString(),
          sessionId,
          agentId,
        },
      );

      expect(result.ok).toBe(true);
      expect(result.action).toBe('expand_task');
      expect(result.taskId).toBe(taskId);
      expect(result.slotStart).toBe(1);
      expect(result.slotEnd).toBe(4); // turn_start + m1 + m2 + turn_complete
      expect(result.entries.length).toBe(4);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('falls back to full-ledger lookup when task_id is outside search limit window', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'finger-expand-task-tool-'));
    const { sessionId, agentId, oldestTaskId } = writeLargeLedger(rootDir);

    try {
      const result = await contextLedgerExpandTaskTool.execute(
        {
          session_id: sessionId,
          agent_id: agentId,
          task_id: oldestTaskId,
          _runtime_context: { root_dir: rootDir },
        },
        {
          invocationId: 'tool-expand-3',
          cwd: process.cwd(),
          timestamp: new Date().toISOString(),
          sessionId,
          agentId,
        },
      );

      expect(result.ok).toBe(true);
      expect(result.taskId).toBe(oldestTaskId);
      expect(result.slotStart).toBe(1);
      expect(result.slotEnd).toBe(2);
      expect(result.entries.length).toBeGreaterThan(0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
