import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readJsonLines } from '../../../src/runtime/context-ledger-memory-helpers.js';
import { appendLedgerEventEntry, appendSessionMessage } from '../../../src/runtime/ledger-writer.js';

describe('ledger-writer', () => {
  it('appends session messages to context-ledger.jsonl with token_count', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ledger-writer-'));
    const context = { rootDir, sessionId: 'session-1', agentId: 'agent-1', mode: 'main' };

    await appendSessionMessage(context, {
      role: 'user',
      content: '你好abcd',
      messageId: 'msg-1',
    });

    const ledgerPath = join(rootDir, 'session-1', 'agent-1', 'main', 'context-ledger.jsonl');
    const entries = await readJsonLines<any>(ledgerPath);
    expect(entries.length).toBe(1);
    expect(entries[0].event_type).toBe('session_message');
    expect(entries[0].payload.role).toBe('user');
    expect(entries[0].payload.message_id).toBe('msg-1');
    expect(entries[0].payload.token_count).toBeGreaterThan(0);
  });

  it('appends custom ledger events', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ledger-writer-'));
    const context = { rootDir, sessionId: 'session-2', agentId: 'agent-2', mode: 'main' };

    await appendLedgerEventEntry(context, 'custom_event', { ok: true, value: 42 });

    const ledgerPath = join(rootDir, 'session-2', 'agent-2', 'main', 'context-ledger.jsonl');
    const entries = await readJsonLines<any>(ledgerPath);
    expect(entries.length).toBe(1);
    expect(entries[0].event_type).toBe('custom_event');
    expect(entries[0].payload.ok).toBe(true);
    expect(entries[0].payload.value).toBe(42);
  });
});
