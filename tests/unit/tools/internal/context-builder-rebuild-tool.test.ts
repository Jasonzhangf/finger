import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { contextBuilderRebuildTool } from '../../../../src/tools/internal/context-builder-rebuild-tool.js';
import { consumeContextBuilderOnDemandView, peekContextBuilderOnDemandView } from '../../../../src/runtime/context-builder-on-demand-state.js';

function writeLedger(rootDir: string): { sessionId: string; agentId: string } {
  const sessionId = 'ctx-rebuild-s1';
  const agentId = 'finger-system-agent';
  const mode = 'main';
  const dir = join(rootDir, sessionId, agentId, mode);
  mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const entries = [
    {
      id: 'm1',
      timestamp_ms: now - 10_000,
      timestamp_iso: new Date(now - 10_000).toISOString(),
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'session_message',
      payload: { role: 'user', content: '修复 mailbox 通知逻辑', token_count: 12 },
    },
    {
      id: 'm2',
      timestamp_ms: now - 9_000,
      timestamp_iso: new Date(now - 9_000).toISOString(),
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'session_message',
      payload: {
        role: 'assistant',
        content: '已分析 mailbox 流程',
        token_count: 14,
        metadata: { tags: ['mailbox', 'notification'], topic: 'mailbox' },
      },
    },
    {
      id: 'm3',
      timestamp_ms: now - 2_000,
      timestamp_iso: new Date(now - 2_000).toISOString(),
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'session_message',
      payload: { role: 'user', content: '现在处理 context builder 相关问题', token_count: 16 },
    },
  ];

  writeFileSync(join(dir, 'context-ledger.jsonl'), `${entries.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf-8');
  return { sessionId, agentId };
}

describe('context_builder.rebuild tool', () => {
  it('rebuilds context and returns metadata + selected blocks', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'finger-context-rebuild-tool-'));
    const { sessionId, agentId } = writeLedger(rootDir);

    try {
      const result = await contextBuilderRebuildTool.execute(
        {
          session_id: sessionId,
          agent_id: agentId,
          current_prompt: 'context builder',
          include_messages: true,
          message_limit: 5,
          _runtime_context: { root_dir: rootDir },
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
      expect(Array.isArray(result.selectedBlockIds)).toBe(true);
      expect(result.selectedBlockIds.length).toBeGreaterThan(0);
      expect(result.metadata).toEqual(expect.objectContaining({
        rawTaskBlockCount: expect.any(Number),
        targetBudget: expect.any(Number),
      }));
      expect(result.messages).toBeDefined();
      expect((result.messages ?? []).length).toBeGreaterThan(0);

      const staged = peekContextBuilderOnDemandView(sessionId, agentId);
      expect(staged).toBeDefined();
      expect(staged?.sessionId).toBe(sessionId);
      expect(staged?.agentId).toBe(agentId);
      expect(staged?.selectedBlockIds.length).toBeGreaterThan(0);

      const consumed = consumeContextBuilderOnDemandView(sessionId, agentId);
      expect(consumed).toBeDefined();
      const consumedAgain = consumeContextBuilderOnDemandView(sessionId, agentId);
      expect(consumedAgain).toBeUndefined();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
