import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { needsCompression, compressSession } from '../../../src/runtime/session-compressor.js';
import { Session } from '../../../src/orchestration/session-manager.js';
import { readJsonLines } from '../../../src/runtime/context-ledger-memory-helpers.js';
import { resolveLedgerPath, resolveBaseDir, resolveCompactMemoryPath } from '../../../src/runtime/context-ledger-memory-helpers.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Session Compressor 单元测试
 * 
 * 设计目标：
 * 1. compressSession 只写入 compact-memory.jsonl（compact_block 事件）
 * 2. context_compact 事件由 RuntimeFacade.executeContextLedgerMemory 写入（不在 compressSession 职责内）
 * 3. 指针更新：latestCompactIndex + originalStartIndex + totalTokens
 */
describe('Session Compressor', () => {
  describe('needsCompression', () => {
    it('should return false when totalTokens <= threshold', () => {
      const session = { id: 'test-session', totalTokens: 50000, latestCompactIndex: 0, originalStartIndex: 0, originalEndIndex: 100 } as Session;
      const result = needsCompression(session, 100000);
      expect(result).toBe(false);
    });

    it('should return true when totalTokens > threshold', () => {
      const session = { id: 'test-session', totalTokens: 150000, latestCompactIndex: 0, originalStartIndex: 0, originalEndIndex: 100 } as Session;
      const result = needsCompression(session, 100000);
      expect(result).toBe(true);
    });
  });

  describe('compressSession', () => {
    const testRootDir = path.join(process.env.HOME || '/tmp', '.finger', 'sessions', '_test_compress_unit');
    const testSessionId = 'test-compress-session';
    const testAgentId = 'test-agent';
    const testMode = 'main';

    beforeEach(async () => {
      const baseDir = resolveBaseDir(testRootDir, testSessionId, testAgentId, testMode);
      await fs.mkdir(baseDir, { recursive: true });

      const ledgerPath = resolveLedgerPath(testRootDir, testSessionId, testAgentId, testMode);
      const mockEntries = [
        { id: 'led-1', timestamp_ms: Date.now(), session_id: testSessionId, agent_id: testAgentId, mode: testMode, event_type: 'session_message', payload: { role: 'user', content: 'Test message 1' } },
        { id: 'led-2', timestamp_ms: Date.now() + 1000, session_id: testSessionId, agent_id: testAgentId, mode: testMode, event_type: 'session_message', payload: { role: 'assistant', content: 'Response 1' } },
        { id: 'led-3', timestamp_ms: Date.now() + 2000, session_id: testSessionId, agent_id: testAgentId, mode: testMode, event_type: 'session_message', payload: { role: 'user', content: 'Test message 2' } },
        { id: 'led-4', timestamp_ms: Date.now() + 3000, session_id: testSessionId, agent_id: testAgentId, mode: testMode, event_type: 'session_message', payload: { role: 'assistant', content: 'Response 2' } },
      ];
      const lines = mockEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
      await fs.writeFile(ledgerPath, lines, 'utf-8');
    });

    afterEach(async () => {
      try { await fs.rm(testRootDir, { recursive: true, force: true }); } catch {}
    });

    it('should return compressed=false when totalTokens <= threshold', async () => {
      const session = { id: testSessionId, totalTokens: 500, latestCompactIndex: 0, originalStartIndex: 0, originalEndIndex: 3 } as Session;
      const result = await compressSession(session, { rootDir: testRootDir, agentId: testAgentId, mode: testMode, compressTokenThreshold: 10000 });
      expect(result.compressed).toBe(false);
      expect(result.reason).toContain('totalTokens');
    });

    it('should return compressed=false when no entries in pointer range', async () => {
      const session = { id: testSessionId, totalTokens: 50000, latestCompactIndex: 0, originalStartIndex: 100, originalEndIndex: 200 } as Session;
      const result = await compressSession(session, { rootDir: testRootDir, agentId: testAgentId, mode: testMode, compressTokenThreshold: 1000 });
      expect(result.compressed).toBe(false);
      expect(result.reason).toContain('No session_message entries');
    });

    it('should successfully compress and write compact_block to compact-memory.jsonl', async () => {
      const session = { id: testSessionId, totalTokens: 50000, latestCompactIndex: 0, originalStartIndex: 0, originalEndIndex: 3 } as Session;
      const result = await compressSession(session, { rootDir: testRootDir, agentId: testAgentId, mode: testMode, compressTokenThreshold: 1000 });

      expect(result.compressed).toBe(true);
      expect(result.result?.summary).toBeDefined();
      expect(result.newCompactIndex).toBe(0);

      const compactPath = resolveCompactMemoryPath(testRootDir, testSessionId, testAgentId, testMode);
      const compactEntries = await readJsonLines(compactPath);
      expect(compactEntries.length).toBe(1);
      expect(compactEntries[0].event_type).toBe('compact_block');
      expect(compactEntries[0].payload.summary).toBeDefined();
    });

    it('should update pointers correctly after compression', async () => {
      const session = { id: testSessionId, totalTokens: 50000, latestCompactIndex: -1, originalStartIndex: 0, originalEndIndex: 3 } as Session;
      const result = await compressSession(session, { rootDir: testRootDir, agentId: testAgentId, mode: testMode, compressTokenThreshold: 1000 });

      expect(result.pointers.latestCompactIndex).toBe(0);
      expect(result.pointers.originalStartIndex).toBe(4);
      expect(result.pointers.totalTokens).toBeGreaterThan(0);
    });

    it('should NOT write context_compact to ledger (RuntimeFacade responsibility)', async () => {
      const session = { id: testSessionId, totalTokens: 50000, latestCompactIndex: 0, originalStartIndex: 0, originalEndIndex: 3 } as Session;
      await compressSession(session, { rootDir: testRootDir, agentId: testAgentId, mode: testMode, compressTokenThreshold: 1000 });

      const ledgerPath = resolveLedgerPath(testRootDir, testSessionId, testAgentId, testMode);
      const entries = await readJsonLines(ledgerPath);
      const contextCompactEvent = entries.find(e => e.event_type === 'context_compact');
      expect(contextCompactEvent).toBeUndefined();
    });
  });
});
