import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RuntimeFacade } from '../../../src/runtime/runtime-facade.js';
import { SessionManager } from '../../../src/orchestration/session-manager.js';
import { EventBus } from '../../../src/runtime/event-bus.js';
import { readJsonLines } from '../../../src/runtime/context-ledger-memory-helpers.js';
import { resolveLedgerPath, resolveBaseDir, resolveCompactMemoryPath } from '../../../src/runtime/context-ledger-memory-helpers.js';
import fs from 'fs/promises';
import path from 'path';

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
  const testRootDir = path.join(process.env.HOME || '/tmp', '.finger', 'sessions', '_test_compress_integration');
  const testSessionId = 'test-integration-session';
  const testAgentId = 'finger-project-agent';
  const testMode = 'main';

  let sessionManager: SessionManager;
  let runtimeFacade: RuntimeFacade;
  let eventBus: EventBus;

  beforeEach(async () => {
    // Setup test directory
    const baseDir = resolveBaseDir(testRootDir, testSessionId, testAgentId, testMode);
    await fs.mkdir(baseDir, { recursive: true });

    // Create mock ledger with session_message entries
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

    // Create SessionManager with test rootDir
    sessionManager = new SessionManager({ rootDir: testRootDir });
    eventBus = new EventBus();
    runtimeFacade = new RuntimeFacade({ sessionManager, eventBus });

    // Create test session with high token count (trigger compression)
    sessionManager.createSession(testSessionId, 'finger-project-agent');
    const session = sessionManager.getSession(testSessionId)!;
    session.totalTokens = 50000; // High enough to trigger compression
    session.originalStartIndex = 0;
    session.originalEndIndex = 49;
    session.latestCompactIndex = -1;
    sessionManager.saveSession(session);
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
