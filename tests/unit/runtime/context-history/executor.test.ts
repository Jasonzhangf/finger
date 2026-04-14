/**
 * Context History Management - Executor Tests
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { executeContextHistoryManagement } from '../../../../src/runtime/context-history/executor.js';
import { makeTriggerDecision } from '../../../../src/runtime/context-history/decision.js';
import { executeCompact } from '../../../../src/runtime/context-history/compact.js';
import type { SessionMessage } from '../../../../src/runtime/context-history/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const tempDir = path.join(os.tmpdir(), 'context-history-test');

async function createMemoryDir(): Promise<string> {
  const dir = path.join(tempDir, `test-${Date.now()}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'compact-memory.jsonl'), '', 'utf-8');
  return dir;
}

async function cleanupMemoryDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

function createMockMessages(count: number): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      id: `msg-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `This is message ${i} with some content to make it longer. `.repeat(100),
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
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('T1: Empty context should trigger rebuild', async () => {
    const memoryDir = await createMemoryDir();
    const sessionId = 'test-session-1';
    const prompt = 'Hello, I need help with a new task';
    const currentHistory: SessionMessage[] = [];

    const result = await executeContextHistoryManagement(sessionId, prompt, memoryDir, currentHistory);

    expect(result.decision.shouldAct).toBe(true);
    expect(result.decision.actionType).toBe('rebuild');
    expect(result.decision.reason).toBe('empty_context');
    // rebuild without mempalace returns ok=false with search_unavailable
    // this is expected: no search backend available
    expect(result.error).toBe('search_unavailable');

    await cleanupMemoryDir(memoryDir);
  });

  it('T2: Normal conversation should not trigger action', async () => {
    const memoryDir = await createMemoryDir();
    const sessionId = 'test-session-2';
    const prompt = 'Continue with the previous task';
    const currentHistory = createMockMessages(3);

    const result = await executeContextHistoryManagement(sessionId, prompt, memoryDir, currentHistory);

    expect(result.ok).toBe(true);
    expect(result.decision.shouldAct).toBe(false);
    expect(result.decision.actionType).toBe('none');

    await cleanupMemoryDir(memoryDir);
  });

  it('T4: Overflow should trigger compact', async () => {
    const memoryDir = await createMemoryDir();
    const sessionId = 'test-session-4';
    const prompt = 'Continue working';
    const currentHistory = createMockMessages(50);

    const result = await executeContextHistoryManagement(sessionId, prompt, memoryDir, currentHistory);

    expect(result.ok).toBe(true);
    expect(result.decision.shouldAct).toBe(true);
    expect(result.decision.actionType).toBe('compact');
    expect(result.historyDigests.length).toBeGreaterThan(0);

    const compactPath = path.join(memoryDir, 'compact-memory.jsonl');
    const content = await fs.readFile(compactPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);

    await cleanupMemoryDir(memoryDir);
  });
});
