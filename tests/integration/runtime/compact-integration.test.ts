import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RuntimeFacade } from '../../../src/runtime/runtime-facade.js';
import { SessionManager } from '../../../src/orchestration/session-manager.js';
import { UnifiedEventBus } from '../../../src/runtime/event-bus.js';
import type { EventBus } from '../../../src/runtime/event-bus.js';
import { globalToolRegistry } from '../../../src/runtime/tool-registry.js';
import { readJsonLines } from '../../../src/runtime/context-ledger-memory-helpers.js';
import { resolveLedgerPath, resolveBaseDir, resolveCompactMemoryPath } from '../../../src/runtime/context-ledger-memory-helpers.js';
import fs from 'fs/promises';
import path from 'path';

// Mock ledger-cli to avoid timeout waiting for real binary
vi.mock('../../../src/runtime/context-ledger-memory-helpers.js', async (importOriginal) => {
  const original = await importOriginal() as any;
  return {
    ...original,
    runLedgerCliCompact: vi.fn().mockResolvedValue({
      tasks: [{ id: 'task-1', summary: 'Mocked compact task' }],
      tokensUsed: 1000,
    }),
  };
});

/**
 * Compact 集成测试
 * 
 * 验证完整 compact 流程：
 * 1. RuntimeFacade.compressContext 调用 SessionManager.compressContext
 * 2. SessionManager.compressContext 调用 compressSession（写入 compact-memory.jsonl）
 * 3. RuntimeFacade 调用 executeContextLedgerMemory（写入 context_compact 事件到 ledger）
 * 4. EventBus emit session_compressed 事件
 */
describe('Compact Integration', () => {
  const testRootDir = path.join(process.env.HOME || '/tmp', '.finger', 'sessions', '_test_compact_int_' + Date.now());
  const testAgentId = 'finger-project-agent';
  const testMode = 'main';

  let testSessionId: string;
  let sessionManager: SessionManager;
  let runtimeFacade: RuntimeFacade;
  let eventBus: EventBus;

  beforeEach(async () => {
    // Clean up test directory first
    try { await fs.rm(testRootDir, { recursive: true, force: true }); } catch {}
    
    // Create fresh test directory
    await fs.mkdir(testRootDir, { recursive: true });

    // Create SessionManager with test rootDir (no existing sessions to reuse)
    sessionManager = new SessionManager({ rootDir: testRootDir });
    eventBus = new UnifiedEventBus();
    runtimeFacade = new RuntimeFacade(eventBus, sessionManager, globalToolRegistry);

    // Create test session - use unique project path to avoid reuse
    const uniqueProjectPath = `/test-project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = sessionManager.createSession(uniqueProjectPath, 'test-compact-session', { allowReuse: false });
    testSessionId = session.id;
    
    // Set high token count to trigger compression
    session.totalTokens = 50000;
    session.originalStartIndex = 0;
    session.originalEndIndex = 49;
    session.latestCompactIndex = -1;
    sessionManager.saveSession(session);

    // Create mock ledger with session_message entries
    const baseDir = resolveBaseDir(testRootDir, testSessionId, testAgentId, testMode);
    await fs.mkdir(baseDir, { recursive: true });
    
    const ledgerPath = resolveLedgerPath(testRootDir, testSessionId, testAgentId, testMode);
    const mockEntries = [];
    for (let i = 0; i < 50; i++) {
      mockEntries.push({
        id: `led-${i}`,
        timestamp_ms: Date.now() + i * 1000,
        session_id: testSessionId,
        agent_id: testAgentId,
        mode: testMode,
        event_type: 'session_message',
        payload: { role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i} with enough content to reach token threshold` },
      });
    }
    const lines = mockEntries.map(e => JSON.stringify(e)).join('\n') + '\n';
    await fs.writeFile(ledgerPath, lines, 'utf-8');
  });

  afterEach(async () => {
    try { await fs.rm(testRootDir, { recursive: true, force: true }); } catch {}
  });

  it('should compress session and write compact_block to compact-memory.jsonl', async () => {
    const summary = await runtimeFacade.compressContext(testSessionId, { trigger: 'manual' });

    expect(summary).toBeDefined();
    expect(summary.length).toBeGreaterThan(0);

    const compactPath = resolveCompactMemoryPath(testRootDir, testSessionId, testAgentId, testMode);
    const compactEntries = await readJsonLines(compactPath);
    expect(compactEntries.length).toBeGreaterThan(0);
    expect(compactEntries[0].event_type).toBe('compact_block');
  });

  it('should emit session_compressed event to EventBus', async () => {
    const eventReceived = new Promise((resolve) => {
      eventBus.subscribe((event) => {
        if (event.type === 'session_compressed' && event.sessionId === testSessionId) {
          resolve(event);
        }
      });
    });

    await runtimeFacade.compressContext(testSessionId, { trigger: 'manual' });

    const event = await eventReceived as any;
    expect(event.payload.trigger).toBe('manual');
    expect(event.payload.summary).toBeDefined();
  });

  it('should write context_compact event to ledger via executeContextLedgerMemory', async () => {
    await runtimeFacade.compressContext(testSessionId, { trigger: 'manual' });

    const ledgerPath = resolveLedgerPath(testRootDir, testSessionId, testAgentId, testMode);
    const entries = await readJsonLines(ledgerPath);

    const contextCompactEvent = entries.find(e => e.event_type === 'context_compact');
    expect(contextCompactEvent).toBeDefined();
    expect(contextCompactEvent?.payload?.summary).toBeDefined();
    expect(contextCompactEvent?.payload?.trigger).toBe('manual');
  });

  it('should update session pointers after compression', async () => {
    await runtimeFacade.compressContext(testSessionId, { trigger: 'manual' });

    const session = sessionManager.getSession(testSessionId)!;
    expect(session.latestCompactIndex).toBeGreaterThan(-1);
    expect(session.originalStartIndex).toBeGreaterThan(0);
    expect(session.totalTokens).toBeGreaterThan(0);
  });
});
