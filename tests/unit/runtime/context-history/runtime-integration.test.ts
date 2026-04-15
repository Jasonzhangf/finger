import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionManager } from '../../../../src/orchestration/session-manager.js';
import type { RuntimeEvent } from '../../../../src/runtime/events.js';
import { globalEventBus } from '../../../../src/runtime/event-bus.js';
import {
  applyPrecomputedContextHistoryRebuild,
  executeAndApplyContextHistoryRebuild,
  resolveContextHistoryBudgetInfo,
} from '../../../../src/runtime/context-history/index.js';

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
            request: '整理 context rebuild',
            summary: '统一 trigger / budget / event 真源',
            key_tools: ['patch'],
            key_reads: ['src/runtime/context-history/runtime-integration.ts'],
            key_writes: ['src/runtime/context-history/runtime-integration.ts'],
            tags: ['context', 'rebuild'],
            topic: 'context rebuild',
            tokenCount: 120,
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

describe('context-history runtime integration', () => {
  let rootDir = '';
  let sessionManager: SessionManager;
  let unsubscriber: (() => void) | undefined;
  const capturedEvents: RuntimeEvent[] = [];

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'finger-context-runtime-'));
    sessionManager = new SessionManager();
    capturedEvents.length = 0;
    unsubscriber = globalEventBus.subscribeAll((event) => {
      capturedEvents.push(event);
    });
  });

  afterEach(() => {
    unsubscriber?.();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('resolves rebuild budget from a single owner and clamps to context window', () => {
    const budget = resolveContextHistoryBudgetInfo(999999999);
    expect(budget.targetBudget).toBeLessThanOrEqual(budget.contextWindow);
    expect(budget.configuredHistoryBudget).toBeGreaterThan(0);
  });

  it('auto overflow rebuild applies snapshot and emits canonical rebuild events', async () => {
    const projectPath = join(rootDir, 'project');
    const session = sessionManager.createSession(projectPath, 'runtime integration');
    sessionManager.updateContext(session.id, { ownerAgentId: 'finger-system-agent' });
    const ledgerPath = writeLedger(rootDir, session.id, 'finger-system-agent');

    for (let index = 0; index < 20; index += 1) {
      await sessionManager.addMessage(
        session.id,
        index % 2 === 0 ? 'user' : 'assistant',
        `长消息 ${index} `.repeat(300),
      );
    }

    const currentMessages = sessionManager.getMessages(session.id, 0);
    const applied = await executeAndApplyContextHistoryRebuild({
      sessionManager,
      sessionId: session.id,
      agentId: 'finger-system-agent',
      mode: 'overflow',
      source: 'retry_overflow',
      currentMessages,
      requestedBudget: 20000,
      ledgerPath,
      userInput: '继续',
    });

    expect(applied.applied).toBe(true);
    expect(applied.result.totalTokens).toBeLessThanOrEqual(20000);
    const persistedMessages = sessionManager.getMessages(session.id, 0);
    expect(persistedMessages).toHaveLength(applied.result.messages.length);
    expect(persistedMessages.filter((message) => message.metadata?.compactDigest === true)).toHaveLength(applied.result.digestCount);
    expect(persistedMessages.some((message) => message.metadata?.contextHistoryMode === 'overflow')).toBe(true);

    const systemNotice = capturedEvents.find((event) => event.type === 'system_notice' && event.sessionId === session.id);
    expect(systemNotice).toBeTruthy();
    expect((systemNotice as RuntimeEvent & { payload: { source?: string } }).payload.source).toBe('auto_context_rebuild');
    expect(capturedEvents.some((event) => event.type === 'session_compressed' && event.sessionId === session.id)).toBe(true);
    expect(capturedEvents.some((event) => event.type === 'session_topic_shift' && event.sessionId === session.id)).toBe(true);
  });

  it('does not replace snapshot when applying a failed precomputed rebuild result', async () => {
    const projectPath = join(rootDir, 'project');
    const session = sessionManager.createSession(projectPath, 'failed precomputed');
    await sessionManager.addMessage(session.id, 'user', '保留原始消息');
    const currentMessages = sessionManager.getMessages(session.id, 0);

    const applied = await applyPrecomputedContextHistoryRebuild({
      sessionManager,
      sessionId: session.id,
      source: 'manual_topic',
      currentMessages,
      result: {
        ok: false,
        mode: 'topic',
        messages: [],
        digestCount: 0,
        rawMessageCount: 0,
        totalTokens: 0,
        error: 'no_keywords',
        metadata: { rebuildMode: 'topic' },
      },
    });

    expect(applied.applied).toBe(false);
    expect(sessionManager.getMessages(session.id, 0)).toHaveLength(currentMessages.length);
    expect(capturedEvents).toHaveLength(0);
  });
});
