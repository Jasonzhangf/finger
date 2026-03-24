/**
 * Parity test: buildSessionView() (ledger-reader) vs buildContext() (context-builder)
 *
 * Purpose: Prove that context-builder loses fields that ledger-reader preserves.
 * Evidence from this test drives the decision: fix builder fields first, then plug into inference.
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import { buildContext } from '../../../src/runtime/context-builder.js';
import { buildSessionView } from '../../../src/runtime/ledger-reader.js';
import type { LedgerEntryFile } from '../../../src/runtime/context-ledger-memory-types.js';

interface ParityLedgerEntry {
  id: string;
  timestamp_ms: number;
  role: string;
  content: string;
  token_count?: number;
  event_type: string;
  metadata?: Record<string, unknown>;
  attachments?: unknown[];
  message_id?: string;
}

function setupParityLedger(tag: string, entries: ParityLedgerEntry[]) {
  const now = Date.now();
  const rootDir = join(tmpdir(), `finger-parity-${tag}-${now}`);
  const sessionId = 'parity-s1';
  const agentId = 'finger-system-agent';
  const mode = 'main';
  const dir = join(rootDir, sessionId, agentId, mode);
  mkdirSync(dir, { recursive: true });

  const ledgerPath = join(dir, 'context-ledger.jsonl');
  writeFileSync(
    ledgerPath,
    entries.map((e) => JSON.stringify({
      id: e.id,
      timestamp_ms: e.timestamp_ms,
      timestamp_iso: new Date(e.timestamp_ms).toISOString(),
      session_id: sessionId,
      agent_id: agentId,
      mode,
      event_type: e.event_type,
      payload: {
        role: e.role,
        content: e.content,
        token_count: e.token_count ?? 10,
        metadata: e.metadata,
        attachments: e.attachments,
        message_id: e.message_id,
      },
    } as LedgerEntryFile)).join('\n') + '\n',
    'utf-8',
  );

  return { rootDir, sessionId, agentId, mode, now };
}

describe('context-builder vs ledger-reader parity', () => {
  it('builder drops metadata that ledger-reader preserves', async () => {
    const setup = setupParityLedger('metadata-drop', [
      {
        id: 'msg-1',
        timestamp_ms: Date.now() - 1000,
        role: 'user',
        content: 'Fix the bug',
        token_count: 10,
        event_type: 'session_message',
        metadata: { reasoning: 'I need to check the login flow first', source: 'qqbot', sessionId: 'original-session' },
      },
    ]);
    try {
      // ledger-reader: preserves metadata
      const view = await buildSessionView(
        { rootDir: setup.rootDir, sessionId: setup.sessionId, agentId: setup.agentId, mode: setup.mode },
        { maxTokens: 1_000_000 },
      );
      expect(view.messages).toHaveLength(1);
      expect(view.messages[0].metadata).toBeDefined();
      expect(view.messages[0].metadata!.reasoning).toBe('I need to check the login flow first');

      // context-builder: drops metadata
      const built = await buildContext(
        { rootDir: setup.rootDir, sessionId: setup.sessionId, agentId: setup.agentId, mode: setup.mode },
        { targetBudget: 1_000_000, includeMemoryMd: false },
      );
      expect(built.messages).toHaveLength(1);
      // TaskMessage has NO metadata field at all — it is completely lost
      expect(built.messages[0]).not.toHaveProperty('metadata');
    } finally {
      rmSync(setup.rootDir, { recursive: true, force: true });
    }
  });

  it('builder drops attachments that ledger-reader preserves (history turn)', async () => {
    const setup = setupParityLedger('attachments-drop', [
      {
        id: 'msg-1',
        timestamp_ms: Date.now() - 2000,
        role: 'user',
        content: 'Look at this image',
        token_count: 10,
        event_type: 'session_message',
        attachments: [
          { type: 'image', url: 'https://example.com/img.png', filename: 'screenshot.png', mimeType: 'image/png' },
          { type: 'file', url: 'https://example.com/doc.pdf', filename: 'report.pdf', mimeType: 'application/pdf' },
        ],
      },
      {
        id: 'msg-2',
        timestamp_ms: Date.now() - 1000,
        role: 'assistant',
        content: 'I see the image. Here is my analysis.',
        token_count: 20,
        event_type: 'session_message',
      },
    ]);
    try {
      // ledger-reader: preserves attachments (as placeholder for history turns)
      const view = await buildSessionView(
        { rootDir: setup.rootDir, sessionId: setup.sessionId, agentId: setup.agentId, mode: setup.mode },
        { maxTokens: 1_000_000 },
      );
      expect(view.messages).toHaveLength(2);
      // msg-1 is a history turn (not last), so it should be a placeholder
      expect(view.messages[0].attachments).toBeDefined();
      // Placeholder has count and summary
      if (view.messages[0].attachments && typeof view.messages[0].attachments === 'object' && !Array.isArray(view.messages[0].attachments)) {
        expect(view.messages[0].attachments).toHaveProperty('count');
        expect(view.messages[0].attachments).toHaveProperty('summary');
      }

      // context-builder: drops attachments entirely
      const built = await buildContext(
        { rootDir: setup.rootDir, sessionId: setup.sessionId, agentId: setup.agentId, mode: setup.mode },
        { targetBudget: 1_000_000, includeMemoryMd: false },
      );
      expect(built.messages).toHaveLength(2);
      expect(built.messages[0]).not.toHaveProperty('attachments');
    } finally {
      rmSync(setup.rootDir, { recursive: true, force: true });
    }
  });

  it('builder drops messageId that ledger-reader preserves', async () => {
    const setup = setupParityLedger('messageid-drop', [
      {
        id: 'led-1',
        timestamp_ms: Date.now() - 1000,
        role: 'assistant',
        content: 'Here is my answer.',
        token_count: 15,
        event_type: 'session_message',
        message_id: 'msg-original-42',
      },
    ]);
    try {
      const view = await buildSessionView(
        { rootDir: setup.rootDir, sessionId: setup.sessionId, agentId: setup.agentId, mode: setup.mode },
        { maxTokens: 1_000_000 },
      );
      expect(view.messages[0].messageId).toBe('msg-original-42');

      const built = await buildContext(
        { rootDir: setup.rootDir, sessionId: setup.sessionId, agentId: setup.agentId, mode: setup.mode },
        { targetBudget: 1_000_000, includeMemoryMd: false },
      );
      // TaskMessage.id is the ledger entry id, NOT the original message_id
      expect(built.messages[0].id).toBe('led-1');
      expect(built.messages[0]).not.toHaveProperty('messageId');
    } finally {
      rmSync(setup.rootDir, { recursive: true, force: true });
    }
  });

  it('builder does not distinguish current-turn vs history for attachments', async () => {
    // ledger-reader: last message gets full attachments, history gets placeholder
    // context-builder: no concept of current-turn vs history at all
    const setup = setupParityLedger('current-turn-attach', [
      {
        id: 'msg-hist',
        timestamp_ms: Date.now() - 2000,
        role: 'user',
        content: 'Old image',
        token_count: 5,
        event_type: 'session_message',
        attachments: [{ type: 'image', url: 'https://old.com/img.png', filename: 'old.png' }],
      },
      {
        id: 'msg-cur',
        timestamp_ms: Date.now() - 100,
        role: 'user',
        content: 'New image',
        token_count: 5,
        event_type: 'session_message',
        attachments: [{ type: 'image', url: 'https://new.com/img.png', filename: 'new.png' }],
      },
    ]);
    try {
      const view = await buildSessionView(
        { rootDir: setup.rootDir, sessionId: setup.sessionId, agentId: setup.agentId, mode: setup.mode },
        { maxTokens: 1_000_000 },
      );
      // ledger-reader: history msg gets placeholder
      expect(view.messages[0].attachments).toBeDefined();
      // ledger-reader: current (last) msg gets full attachment array
      expect(Array.isArray(view.messages[1].attachments)).toBe(true);

      const built = await buildContext(
        { rootDir: setup.rootDir, sessionId: setup.sessionId, agentId: setup.agentId, mode: setup.mode },
        { targetBudget: 1_000_000, includeMemoryMd: false },
      );
      // context-builder: neither message has attachments
      expect(built.messages[0]).not.toHaveProperty('attachments');
      expect(built.messages[1]).not.toHaveProperty('attachments');
      // Only the last message's last entry is marked as currentTurn
      expect(built.messages[0].isCurrentTurn).toBeFalsy();
      expect(built.messages[1].isCurrentTurn).toBe(true);
    } finally {
      rmSync(setup.rootDir, { recursive: true, force: true });
    }
  });

  it('builder drops content-less entries that ledger-reader keeps', async () => {
    const setup = setupParityLedger('empty-content', [
      {
        id: 'msg-empty',
        timestamp_ms: Date.now() - 1000,
        role: 'assistant',
        content: '',
        token_count: 0,
        event_type: 'session_message',
        metadata: { toolName: 'context_ledger.memory', status: 'ok' },
      },
    ]);
    try {
      // ledger-reader: keeps the entry (even with empty content)
      const view = await buildSessionView(
        { rootDir: setup.rootDir, sessionId: setup.sessionId, agentId: setup.agentId, mode: setup.mode },
        { maxTokens: 1_000_000 },
      );
      // content is empty but message still present
      expect(view.messages).toHaveLength(1);
      expect(view.messages[0].content).toBe('');
      expect(view.messages[0].metadata).toBeDefined();

      // context-builder: filters out content-less entries in filter step
      // (the filter checks typeof payload.content === 'string' and the message
      //  passes, but task grouping might still include it)
      const built = await buildContext(
        { rootDir: setup.rootDir, sessionId: setup.sessionId, agentId: setup.agentId, mode: setup.mode },
        { targetBudget: 1_000_000, includeMemoryMd: false },
      );
      // Empty content messages ARE included by context-builder (not filtered)
      // but metadata is still lost
      expect(built.messages).toHaveLength(1);
      expect(built.messages[0].content).toBe('');
      expect(built.messages[0]).not.toHaveProperty('metadata');
    } finally {
      rmSync(setup.rootDir, { recursive: true, force: true });
    }
  });
});
