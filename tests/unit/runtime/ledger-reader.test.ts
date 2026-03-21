import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendSessionMessage } from '../../../src/runtime/ledger-writer.js';
import { buildSessionView } from '../../../src/runtime/ledger-reader.js';
import { resolveCompactMemoryPath } from '../../../src/runtime/context-ledger-memory-helpers.js';
import { promises as fs } from 'fs';

describe('ledger-reader', () => {
  it('builds session view with latest messages and optional summary', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ledger-reader-'));
    const context = { rootDir, sessionId: 'session-1', agentId: 'agent-1', mode: 'main' };

    await appendSessionMessage(context, { role: 'user', content: '你好' });
    await appendSessionMessage(context, { role: 'assistant', content: '好的' });

    // Write a compact summary entry
    const compactPath = resolveCompactMemoryPath(rootDir, context.sessionId, context.agentId, context.mode);
    await fs.mkdir(join(rootDir, context.sessionId, context.agentId, context.mode), { recursive: true });
    await fs.appendFile(compactPath, `${JSON.stringify({
      id: 'cpt-1',
      timestamp_ms: Date.now(),
      timestamp_iso: new Date().toISOString(),
      session_id: context.sessionId,
      agent_id: context.agentId,
      mode: context.mode,
      payload: { summary: '压缩摘要内容' },
    })}\n`, 'utf-8');

    const view = await buildSessionView(context, { maxTokens: 100, includeSummary: true });
    expect(view.compressedSummary).toBe('压缩摘要内容');
    expect(view.messages.length).toBe(2);
    expect(view.messages[0].role).toBe('user');
    expect(view.messages[1].role).toBe('assistant');
  });

  it('respects maxTokens by returning only latest messages', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'ledger-reader-'));
    const context = { rootDir, sessionId: 'session-2', agentId: 'agent-2', mode: 'main' };

    await appendSessionMessage(context, { role: 'user', content: 'abcd' });
    await appendSessionMessage(context, { role: 'assistant', content: 'efgh' });
    await appendSessionMessage(context, { role: 'user', content: 'ijkl' });

    const view = await buildSessionView(context, { maxTokens: 1, includeSummary: false });
    expect(view.messages.length).toBe(1);
    expect(view.messages[0].content).toBe('ijkl');
  });
});
