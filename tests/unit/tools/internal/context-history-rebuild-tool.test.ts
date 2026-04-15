import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { contextHistoryRebuildTool } from '../../../../src/tools/internal/context-history-rebuild-tool.js';

function writeLedger(rootDir: string): { sessionId: string; agentId: string } {
  const sessionId = `ctx-rebuild-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const agentId = 'finger-system-agent';
  const mode = 'main';
  const dir = join(rootDir, sessionId, agentId, mode);
  mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const entries = [
    {
      event_type: 'context_compact',
      timestamp_ms: now - 10000,
      timestamp_iso: new Date(now - 10000).toISOString(),
      payload: {
        replacement_history: [
          {
            request: '修复 mailbox 通知逻辑',
            summary: '已分析 mailbox 路由和通知发送',
            key_tools: ['read_file'],
            key_reads: ['src/server/routes/message-route-execution.ts'],
            key_writes: [],
            tags: ['mailbox', 'notification'],
            topic: 'mailbox notification',
            tokenCount: 120,
            key_entities: ['mailbox', 'notification'],
          },
        ],
      },
    },
  ];

  writeFileSync(join(dir, 'context-ledger.jsonl'), entries.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf-8');
  return { sessionId, agentId };
}

describe('context_history.rebuild tool', () => {
  it('rebuilds context through the single context-history executor and returns rebuilt messages', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'finger-context-rebuild-tool-'));
    const { sessionId, agentId } = writeLedger(rootDir);

    try {
      const result = await contextHistoryRebuildTool.execute(
        {
          session_id: sessionId,
          agent_id: agentId,
          current_prompt: 'mailbox notification',
          include_messages: true,
          message_limit: 5,
          _runtime_context: {
            root_dir: rootDir,
            session_messages: [
              {
                id: 'ss1',
                role: 'user',
                content: '先处理 mailbox 通知问题',
                timestamp: new Date(Date.now() - 5000).toISOString(),
              },
            ],
          },
        },
        {
          invocationId: 'tool-ctx-rebuild-1',
          cwd: process.cwd(),
          timestamp: new Date().toISOString(),
          sessionId,
          agentId,
        },
      );

      expect(result.ok).toBe(true);
      expect(result.action).toBe('rebuild');
      expect(result.appliesNextTurn).toBe(true);
      expect(result.sessionId).toBe(sessionId);
      expect(result.agentId).toBe(agentId);
      expect(result.selectedBlockIds.length).toBeGreaterThan(0);
      expect(result.metadata?.targetBudget).toBe(20000);
      expect(result.__rebuiltMessages?.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.__rebuiltMessages)).toContain('mailbox');
      expect((result.messages ?? []).length).toBeGreaterThan(0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('prefers rebuild_budget over other budget aliases', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'finger-context-rebuild-tool-'));
    const { sessionId, agentId } = writeLedger(rootDir);

    try {
      const result = await contextHistoryRebuildTool.execute(
        {
          session_id: sessionId,
          agent_id: agentId,
          current_prompt: 'mailbox notification',
          rebuild_budget: 50000,
          budget_tokens: 60000,
          target_budget: 70000,
          _runtime_context: {
            root_dir: rootDir,
            session_messages: [
              {
                id: 'ss1',
                role: 'user',
                content: 'mailbox notification',
                timestamp: new Date().toISOString(),
              },
            ],
          },
        },
        {
          invocationId: 'tool-ctx-rebuild-2',
          cwd: process.cwd(),
          timestamp: new Date().toISOString(),
          sessionId,
          agentId,
        },
      );

      expect(result.ok).toBe(true);
      expect(result.targetBudget).toBe(50000);
      expect(result.metadata?.targetBudget).toBe(50000);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
