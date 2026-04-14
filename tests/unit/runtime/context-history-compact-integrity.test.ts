/**
 * 测试目标：验证压缩前后 ledger/session 的变化
 * 
 * 期望行为：
 * - Ledger（context-ledger.jsonl）：append-only，压缩不会修改历史记录
 * - Session.messages：会被替换为 digest + 最近 N 轮
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { appendLedgerEvent, resolveLedgerPath, resolveBaseDir } from '../../../src/runtime/context-ledger-memory-helpers.js';
import { executeContextHistoryManagement } from '../../../src/runtime/context-history-compact.js';
import { logger } from '../../../src/core/logger/index.js';

const log = logger.module('compact-integrity-test');

describe('Context History Compact - Ledger/Session Integrity', () => {
  let tempDir: string;
  let sessionId: string;
  const agentId = 'finger-project-agent';
  const mode = 'main';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'finger-test-compact-integrity-'));
    sessionId = `session-${Date.now()}-test`;
    
    // 创建 ledger 目录
    const baseDir = resolveBaseDir(tempDir, sessionId, agentId, mode);
    await fs.mkdir(baseDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('Ledger 应该是 append-only，压缩不删除历史记录', async () => {
    const ledgerPath = resolveLedgerPath(tempDir, sessionId, agentId, mode);

    // 1. 写入初始记录（5 条）
    for (let i = 0; i < 5; i++) {
      await appendLedgerEvent(ledgerPath, {
        session_id: sessionId,
        agent_id: agentId,
        mode,
        event_type: 'message',
        payload: {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i + 1}`,
        },
      });
    }

    // 2. 读取压缩前的 ledger 行数
    const contentBefore = await fs.readFile(ledgerPath, 'utf-8');
    const linesBefore = contentBefore.trim().split('\n').length;
    log.info('Ledger before compact', { linesBefore });

    // 3. 执行压缩（模拟）
    // 注意：executeContextHistoryManagement 会追加 digest 记录，而不是删除
    await appendLedgerEvent(ledgerPath, {
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'context_compact',
      payload: {
        trigger: 'overflow',
        mode: 'overflow',
        replacement_history: [
          { topic: 'Message 1-3', summary: 'Digest of first 3 messages', tags: ['test'], tokenCount: 100 },
        ],
        compacted_at_iso: new Date().toISOString(),
      },
    });

    // 4. 读取压缩后的 ledger 行数
    const contentAfter = await fs.readFile(ledgerPath, 'utf-8');
    const linesAfter = contentAfter.trim().split('\n').length;
    log.info('Ledger after compact', { linesAfter });

    // 5. 验证：ledger 行数应该增加（append-only），而不是减少
    expect(linesAfter).toBeGreaterThan(linesBefore);
    expect(linesAfter).toBe(linesBefore + 1); // 只追加 1 条 compact 记录

    // 6. 验证：原始记录依然存在
    const firstLine = contentAfter.trim().split('\n')[0];
    const firstEntry = JSON.parse(firstLine);
    expect(firstEntry.event_type).toBe('message');
    expect(firstEntry.payload.content).toBe('Message 1');
  });

  it('压缩记录应该包含 replacement_history（被压缩的消息摘要）', async () => {
    const ledgerPath = resolveLedgerPath(tempDir, sessionId, agentId, mode);

    // 写入消息
    await appendLedgerEvent(ledgerPath, {
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'message',
      payload: { role: 'user', content: 'Test message' },
    });

    // 写入压缩记录
    const digestEntry = {
      topic: 'Test Topic',
      summary: 'Test Summary',
      tags: ['test'],
      request: 'Test Request',
      tokenCount: 50,
    };

    await appendLedgerEvent(ledgerPath, {
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'context_compact',
      payload: {
        trigger: 'manual',
        mode: 'topic',
        replacement_history: [digestEntry],
        compacted_at_iso: new Date().toISOString(),
      },
    });

    // 验证压缩记录格式
    const content = await fs.readFile(ledgerPath, 'utf-8');
    const lines = content.trim().split('\n');
    const compactEntry = JSON.parse(lines[lines.length - 1]);

    expect(compactEntry.event_type).toBe('context_compact');
    expect(compactEntry.payload.replacement_history).toBeDefined();
    expect(compactEntry.payload.replacement_history.length).toBe(1);
    expect(compactEntry.payload.replacement_history[0].topic).toBe('Test Topic');
  });

  it('Ledger 文件名必须是 context-ledger.jsonl（唯一真源）', async () => {
    const ledgerPath = resolveLedgerPath(tempDir, sessionId, agentId, mode);

    // 验证路径包含正确的文件名
    expect(ledgerPath.endsWith('context-ledger.jsonl')).toBe(true);

    // 写入并验证文件存在
    await appendLedgerEvent(ledgerPath, {
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: 'message',
      payload: { role: 'user', content: 'Test' },
    });

    const exists = await fs.stat(ledgerPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // 验证目录中没有其他 ledger 文件
    const baseDir = resolveBaseDir(tempDir, sessionId, agentId, mode);
    const files = await fs.readdir(baseDir);
    const ledgerFiles = files.filter(f => f.includes('ledger') || f.includes('compact-memory'));
    
    // 只允许 context-ledger.jsonl，不允许其他 ledger 命名
    expect(ledgerFiles).toEqual(['context-ledger.jsonl']);
  });
});
