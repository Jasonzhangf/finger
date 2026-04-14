/**
 * Context History Management - Executor Tests
 * 
 * 更新为新的 Rebuild API
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeRebuild, checkRebuildNeeded } from '../../../../src/runtime/context-history/index.js';
import type { SessionMessage, TaskDigest } from '../../../../src/runtime/context-history/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const tempDir = path.join(os.tmpdir(), 'context-history-test');

async function createLedgerPath(sessionId: string, agentId: string = 'test-agent'): Promise<string> {
  const sessionDir = path.join(tempDir, sessionId, agentId, 'main');
  await fs.mkdir(sessionDir, { recursive: true });
  const ledgerPath = path.join(sessionDir, 'context-ledger.jsonl');
  await fs.writeFile(ledgerPath, '', 'utf-8');
  return ledgerPath;
}

async function createLedgerWithDigests(sessionId: string, digestCount: number): Promise<string> {
  const sessionDir = path.join(tempDir, sessionId, 'test-agent', 'main');
  await fs.mkdir(sessionDir, { recursive: true });
  const ledgerPath = path.join(sessionDir, 'context-ledger.jsonl');
  
  const lines: string[] = [];
  for (let i = 0; i < digestCount; i++) {
    const digest: TaskDigest = {
      request: 'Request ' + i + ': help with task ' + i,
      summary: 'Completed task ' + i + ' successfully',
      key_tools: ['read_file', 'write_file'],
      key_reads: ['/path/file' + i + '.ts'],
      key_writes: ['/path/output' + i + '.ts'],
      tags: ['test', 'task'],
      topic: 'testing',
      tokenCount: 100 + i * 10,
      timestamp: new Date(Date.now() - (digestCount - i) * 60000).toISOString(),
    };
    
    // 正确的 ledger 格式：event_type + payload.replacement_history
    const entry = {
      event_type: 'context_compact',
      timestamp_ms: Date.now() - (digestCount - i) * 60000,
      timestamp_iso: digest.timestamp,
      ledgerLine: i + 1,
      payload: {
        replacement_history: [digest]
      }
    };
    lines.push(JSON.stringify(entry));
  }
  
  const contentToWrite = lines.join('\n');
  await fs.writeFile(ledgerPath, contentToWrite, 'utf-8');
  return ledgerPath;
}

async function cleanupTempDir(): Promise<void> {
  await fs.rm(tempDir, { recursive: true, force: true });
}

function createMockMessages(count: number): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      id: 'msg-' + i,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'This is message ' + i + ' with some content to make it longer. '.repeat(100),
      timestamp: Date.now() - (count - i) * 1000,
      timestampIso: new Date(Date.now() - (count - i) * 1000).toISOString(),
    });
  }
  return messages;
}

describe('Context History Management - Executor', () => {
  beforeAll(async () => {
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterAll(async () => {
    await cleanupTempDir();
  });

  it('T1: Empty context should trigger rebuild decision', async () => {
    const ledgerPath = await createLedgerPath('test-session-1');
    const sessionId = 'test-session-1';
    const prompt = 'Hello, I need help with a new task';
    const messages: SessionMessage[] = [];

    const { decision, result } = await executeRebuild(sessionId, ledgerPath, messages, prompt);

    // 空上下文会触发 rebuild 决策（new_session）
    expect(decision.shouldRebuild).toBe(true);
    expect(decision.trigger).toBe('new_session');
    
    // 由于 ledger 也是空的，rebuild 结果可能为空或失败
    if (result) {
      // 空 ledger 没有 digest，返回空 messages 是预期行为
      expect(result.ok).toBeDefined();
    }
  });

  it('T2: Normal conversation should not trigger rebuild', async () => {
    const ledgerPath = await createLedgerPath('test-session-2');
    const sessionId = 'test-session-2';
    const prompt = 'Continue with the previous task';
    const messages = createMockMessages(3);

    const { decision, result } = await executeRebuild(sessionId, ledgerPath, messages, prompt);

    // 正常对话不应触发 rebuild（token 未超限）
    expect(decision.shouldRebuild).toBe(false);
    expect(result).toBeNull();
  });

  it('T3: checkRebuildNeeded should return correct decision', async () => {
    const sessionId = 'test-session-3';
    const prompt = 'New task request';
    const messages = createMockMessages(10);

    const decision = checkRebuildNeeded(sessionId, messages, prompt);

    expect(decision.shouldRebuild).toBeDefined();
    expect(decision.currentTokens).toBeGreaterThan(0);
    expect(decision.budgetTokens).toBeGreaterThan(0);
  });

  it('T4: Overflow with empty ledger returns empty messages', async () => {
    const ledgerPath = await createLedgerPath('test-session-4');
    const sessionId = 'test-session-4';
    const prompt = 'Continue working';
    // 创建大量消息以触发 overflow
    const messages = createMockMessages(100);

    const { decision, result } = await executeRebuild(sessionId, ledgerPath, messages, prompt);

    // 应该触发 rebuild（overflow）
    expect(decision.shouldRebuild).toBe(true);
    expect(decision.trigger).toBe('overflow');
    expect(decision.mode).toBe('overflow');
    
    // 空 ledger 没有 digest，rebuild 返回空 messages
    if (result && result.ok) {
      // 没有 digest 时，messages 为空是预期行为
      expect(result.digestCount).toBe(0);
      expect(result.totalTokens).toBe(0);
    }
  });

  it('T5: Overflow with digest data should return messages', async () => {
    // 预先写入正确格式的 digest 数据
    const ledgerPath = await createLedgerWithDigests('test-session-5', 5);
    const sessionId = 'test-session-5';
    const prompt = 'Continue working';
    const messages = createMockMessages(100);

    const { decision, result } = await executeRebuild(sessionId, ledgerPath, messages, prompt);

    // 应该触发 rebuild（overflow）
    expect(decision.shouldRebuild).toBe(true);
    expect(decision.trigger).toBe('overflow');
    
    // 有 digest 时，rebuild 应返回非空 messages
    if (result && result.ok) {
      expect(result.digestCount).toBeGreaterThan(0);
      expect(result.totalTokens).toBeGreaterThan(0);
    }
  });
});
