import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { needsCompression, compressSession, syncSessionTokens } from '../../../src/runtime/session-compressor.js';
import { appendSessionMessage } from '../../../src/runtime/ledger-writer.js';
import { resolveCompactMemoryPath } from '../../../src/runtime/context-ledger-memory-helpers.js';
import type { Session } from '../../../src/orchestration/session-types.js';
import type { LedgerEntryFile } from '../../../src/runtime/context-ledger-memory-types.js';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session-123',
    name: 'Test Session',
    projectPath: '/test/project',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    lastAccessedAt: '2026-01-01T00:00:00Z',
    messages: [],
    activeWorkflows: [],
    context: {},
    ledgerPath: '',
    latestCompactIndex: -1,
    originalStartIndex: 0,
    originalEndIndex: 5,
    totalTokens: 300000,
    ...overrides,
  };
}

describe('session-compressor', () => {
  let tmpDir: string;
  let session: Session;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finger-compressor-test-'));
    session = makeSession();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('needsCompression', () => {
    it('should return true when totalTokens exceeds threshold', () => {
      const result = needsCompression(session, 200000);
      expect(result).toBe(true);
    });

    it('should return false when totalTokens is below threshold', () => {
      const lowSession = makeSession({ totalTokens: 100000 });
      const result = needsCompression(lowSession, 200000);
      expect(result).toBe(false);
    });

    it('should return false when totalTokens equals threshold', () => {
      const eqSession = makeSession({ totalTokens: 200000 });
      const result = needsCompression(eqSession, 200000);
      expect(result).toBe(false);
    });
  });

  describe('compressSession', () => {
    it('should skip compression when totalTokens below threshold', async () => {
      const lowSession = makeSession({ totalTokens: 1000 });
      const result = await compressSession(lowSession, {
        rootDir: tmpDir,
        compressTokenThreshold: 200000,
      });

      expect(result.compressed).toBe(false);
      expect(result.reason).toContain('totalTokens');
      expect(result.pointers.totalTokens).toBe(1000);
    });

    it('should skip compression when no entries in pointer range', async () => {
      const emptySession = makeSession({
        totalTokens: 300000,
        originalStartIndex: 100,
        originalEndIndex: 99,
      });
      const result = await compressSession(emptySession, {
        rootDir: tmpDir,
        compressTokenThreshold: 200000,
      });

      expect(result.compressed).toBe(false);
      expect(result.reason).toContain('No session_message entries');
    });

    it('should compress with custom summarizer when entries exist', async () => {
      // Seed ledger with messages
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'user', content: 'Hello world, this is a test message for compression.' },
      );
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'assistant', content: 'I understand, this is a test response.' },
      );
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'user', content: 'Another user message.' },
      );
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'assistant', content: 'Another assistant response.' },
      );
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'user', content: 'Third user message for good measure.' },
      );
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'assistant', content: 'Third response.' },
      );

      const customSummarizer = async (_entries: LedgerEntryFile[]): Promise<CompressResult> => ({
        summary: '用户问了3个问题，助手回答了3次',
        userPreferencePatch: '用户偏好：简洁回复',
        tokenCount: 50,
      });

      const result = await compressSession(session, {
        rootDir: tmpDir,
        agentId: 'test-agent',
        mode: 'main',
        compressTokenThreshold: 200000,
        summarizer: customSummarizer,
      });

      expect(result.compressed).toBe(true);
      expect(result.newCompactIndex).toBe(0);
      expect(result.pointers.latestCompactIndex).toBe(0);
      expect(result.pointers.originalStartIndex).toBe(6); // endIndex(5) + 1
      expect(result.result?.summary).toBe('用户问了3个问题，助手回答了3次');
      expect(result.result?.userPreferencePatch).toBe('用户偏好：简洁回复');
      expect(result.result?.tokenCount).toBe(50);
    });

    it('should write compact block to compact-memory.jsonl', async () => {
      // Seed ledger
      for (let i = 0; i < 6; i++) {
        await appendSessionMessage(
          { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
          { role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}` },
        );
      }

      const result = await compressSession(session, {
        rootDir: tmpDir,
        agentId: 'test-agent',
        mode: 'main',
        compressTokenThreshold: 200000,
      });

      expect(result.compressed).toBe(true);

      // Verify compact file was created and contains the block
      const compactPath = resolveCompactMemoryPath(tmpDir, 'test-session-123', 'test-agent', 'main');
      expect(fs.existsSync(compactPath)).toBe(true);
      const compactContent = fs.readFileSync(compactPath, 'utf-8').trim();
      const lines = compactContent.split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(1);

      const compactEntry = JSON.parse(lines[0]);
      expect(compactEntry.event_type).toBe('compact_block');
      expect(compactEntry.payload.source_range.start).toBe(0);
      expect(compactEntry.payload.source_range.end).toBe(5);
    });

    it('should use default heuristic summarizer when no custom one provided', async () => {
      // Seed ledger with user messages
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'user', content: 'Please help me with task ABC', metadata: { task_id: 'task-1' } },
      );
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'assistant', content: 'Sure, I can help with that.' },
      );
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'user', content: 'Also fix issue XYZ', metadata: { task_id: 'task-2' } },
      );
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'assistant', content: 'Done.' },
      );
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'user', content: 'One more thing' },
      );
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'assistant', content: 'OK' },
      );

      const result = await compressSession(session, {
        rootDir: tmpDir,
        agentId: 'test-agent',
        mode: 'main',
        compressTokenThreshold: 200000,
      });

      expect(result.compressed).toBe(true);
      expect(result.result?.summary).toContain('用户请求');
      expect(result.result?.summary).toContain('助手响应');
      expect(result.result?.tokenCount).toBeGreaterThan(0);
    });

    it('should handle multiple compression rounds (increment compact index)', async () => {
      // Seed ledger
      for (let i = 0; i < 6; i++) {
        await appendSessionMessage(
          { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
          { role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}` },
        );
      }

      const customSummarizer = async (_entries: LedgerEntryFile[]): Promise<CompressResult> => ({
        summary: 'Compressed block',
        userPreferencePatch: '',
        tokenCount: 10,
      });

      // First compression
      const result1 = await compressSession(session, {
        rootDir: tmpDir,
        agentId: 'test-agent',
        mode: 'main',
        compressTokenThreshold: 200000,
        summarizer: customSummarizer,
      });

      expect(result1.compressed).toBe(true);
      expect(result1.newCompactIndex).toBe(0);

      // Add more messages and update session for second round
      for (let i = 6; i < 10; i++) {
        await appendSessionMessage(
          { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
          { role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}` },
        );
      }

      const updatedSession = makeSession({
        latestCompactIndex: 0,
        originalStartIndex: 6,
        originalEndIndex: 9,
        totalTokens: 300000,
      });

      // Second compression
      const result2 = await compressSession(updatedSession, {
        rootDir: tmpDir,
        agentId: 'test-agent',
        mode: 'main',
        compressTokenThreshold: 200000,
        summarizer: customSummarizer,
      });

      expect(result2.compressed).toBe(true);
      expect(result2.newCompactIndex).toBe(1);
      expect(result2.pointers.latestCompactIndex).toBe(1);

      // Verify two compact blocks in file
      const compactPath = resolveCompactMemoryPath(tmpDir, 'test-session-123', 'test-agent', 'main');
      const compactContent = fs.readFileSync(compactPath, 'utf-8').trim();
      const lines = compactContent.split('\n').filter(l => l.length > 0);
      expect(lines.length).toBe(2);
    });
  });

  describe('syncSessionTokens', () => {
    it('should count tokens from ledger entries', async () => {
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'user', content: 'Hello world test message' },
      );
      await appendSessionMessage(
        { rootDir: tmpDir, sessionId: 'test-session-123', agentId: 'test-agent', mode: 'main' },
        { role: 'assistant', content: 'Response test message' },
      );

      const syncSession = makeSession({ totalTokens: 0 });
      const totalTokens = await syncSessionTokens(syncSession, {
        rootDir: tmpDir,
        agentId: 'test-agent',
        mode: 'main',
      });

      expect(totalTokens).toBeGreaterThan(0);
      expect(syncSession.totalTokens).toBe(totalTokens);
    });

    it('should return 0 for empty ledger', async () => {
      const syncSession = makeSession({ totalTokens: 999 });
      const totalTokens = await syncSessionTokens(syncSession, {
        rootDir: tmpDir,
        agentId: 'test-agent',
        mode: 'main',
      });

      expect(totalTokens).toBe(0);
      expect(syncSession.totalTokens).toBe(0);
    });
  });
});
