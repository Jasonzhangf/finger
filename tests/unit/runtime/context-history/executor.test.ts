import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { checkRebuildNeeded, executeRebuild, forceRebuild } from '../../../../src/runtime/context-history/index.js';
import type { SessionMessage } from '../../../../src/runtime/context-history/index.js';

function createTempLedgerDir(): string {
  return mkdtempSync(join(tmpdir(), 'finger-context-history-'));
}

function writeLedger(rootDir: string, sessionId: string, agentId: string): string {
  const dir = join(rootDir, sessionId, agentId, 'main');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const entries = [
    {
      event_type: 'context_compact',
      timestamp_ms: now - 60000,
      timestamp_iso: new Date(now - 60000).toISOString(),
      payload: {
        replacement_history: [
          {
            request: '修复 mailbox 通知逻辑',
            summary: '已定位到 dispatch retry 行为',
            key_tools: ['read_file'],
            key_reads: ['src/server/routes/message-route-execution.ts'],
            key_writes: [],
            tags: ['mailbox', 'retry'],
            topic: 'mailbox retry',
            tokenCount: 120,
            key_entities: ['mailbox', 'retry'],
          },
          {
            request: '整理 context rebuild 流程',
            summary: '需要把 overflow 和 topic rebuild 合并到单点',
            key_tools: ['apply_patch'],
            key_reads: ['src/runtime/context-history/rebuild.ts'],
            key_writes: ['src/runtime/context-history/rebuild.ts'],
            tags: ['context', 'rebuild'],
            topic: 'context rebuild',
            tokenCount: 140,
            key_entities: ['context', 'rebuild'],
          },
        ],
      },
    },
  ];
  const ledgerPath = join(dir, 'context-ledger.jsonl');
  writeFileSync(ledgerPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n', 'utf-8');
  return ledgerPath;
}

function createConversation(messageCount: number, repeat: string): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    messages.push({
      id: 'msg-' + String(index + 1),
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: repeat + ' #' + String(index + 1),
      timestamp: new Date(Date.now() - (messageCount - index) * 1000).toISOString(),
    });
  }
  return messages;
}

describe('context-history executor', () => {
  let rootDir = '';
  let ledgerPath = '';
  const sessionId = 'ctx-session';
  const agentId = 'finger-system-agent';

  beforeEach(() => {
    rootDir = createTempLedgerDir();
    ledgerPath = writeLedger(rootDir, sessionId, agentId);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('detects overflow and rebuilds into digest plus working set', async () => {
    const messages = createConversation(40, '这是一段很长的历史消息内容 '.repeat(50));
    const decision = checkRebuildNeeded(sessionId, messages, '继续处理当前任务', undefined, undefined, 20000);
    expect(decision.shouldRebuild).toBe(true);
    expect(decision.mode).toBe('overflow');

    const executed = await executeRebuild(sessionId, ledgerPath, messages, '继续处理当前任务', undefined, undefined, { budgetTokens: 20000 });
    expect(executed.result?.ok).toBe(true);
    expect(executed.result?.mode).toBe('overflow');
    expect((executed.result?.messages ?? []).some((message) => message.metadata?.compactDigest === true)).toBe(true);
    expect((executed.result?.messages ?? []).some((message) => message.metadata?.contextZone === 'working_set')).toBe(true);
  });

  it('force topic rebuild recalls matched digest history only', async () => {
    const currentMessages = createConversation(4, '近期会话');
    const result = await forceRebuild(sessionId, ledgerPath, 'topic', '请处理 context rebuild', ['context', 'rebuild'], 20000, currentMessages);
    expect(result.ok).toBe(true);
    expect(result.mode).toBe('topic');
    expect(result.digestCount).toBeGreaterThan(0);
    expect(result.rawMessageCount).toBe(0);
    expect(result.messages.every((message) => message.metadata?.compactDigest === true)).toBe(true);
    expect(JSON.stringify(result.messages)).toContain('context rebuild');
  });

  it('returns no action when history is below budget and no topic signal exists', async () => {
    const messages = createConversation(4, '短消息');
    const executed = await executeRebuild(sessionId, ledgerPath, messages, '继续', undefined, undefined, { budgetTokens: 20000 });
    expect(executed.decision.shouldRebuild).toBe(false);
    expect(executed.result).toBeNull();
  });
});
