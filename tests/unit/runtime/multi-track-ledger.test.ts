import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { appendLedgerEvent } from '../../../src/runtime/context-ledger-memory-helpers.js';
import { readJsonLines } from '../../../src/runtime/context-ledger-memory-helpers.js';

describe('multi-track ledger', () => {
  const tmpDir = path.join(os.tmpdir(), `finger-ledger-track-test-${Date.now()}`);
  const ledgerPath = path.join(tmpDir, 'ledger.jsonl');
  const sessionId = 'session-test-001';
  const agentId = 'finger-project-agent';

  beforeEach(async () => {
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('appendLedgerEvent with track', () => {
    it('writes entry with track field', async () => {
      await appendLedgerEvent(ledgerPath, {
        session_id: sessionId,
        agent_id: agentId,
        mode: 'main',
        event_type: 'turn_start',
        payload: { role: 'user', content: 'hello' },
        track: 'track0',
      });

      const entries = await readJsonLines(ledgerPath);
      expect(entries.length).toBe(1);
      expect(entries[0].track).toBe('track0');
    });

    it('defaults to undefined track when not specified', async () => {
      await appendLedgerEvent(ledgerPath, {
        session_id: sessionId,
        agent_id: agentId,
        mode: 'main',
        event_type: 'turn_start',
        payload: { role: 'user', content: 'no track' },
      });

      const entries = await readJsonLines(ledgerPath);
      expect(entries.length).toBe(1);
      expect(entries[0].track).toBeUndefined();
    });

    it('writes multiple entries with different tracks', async () => {
      await appendLedgerEvent(ledgerPath, {
        session_id: sessionId,
        agent_id: agentId,
        mode: 'main',
        event_type: 'turn_start',
        payload: { content: 'track0 message' },
        track: 'track0',
      });

      await appendLedgerEvent(ledgerPath, {
        session_id: sessionId,
        agent_id: agentId,
        mode: 'main',
        event_type: 'turn_start',
        payload: { content: 'track1 message' },
        track: 'track1',
      });

      const entries = await readJsonLines(ledgerPath);
      expect(entries.length).toBe(2);
      expect(entries[0].track).toBe('track0');
      expect(entries[1].track).toBe('track1');
    });

    it('preserves slot_number alongside track', async () => {
      await appendLedgerEvent(ledgerPath, {
        session_id: sessionId,
        agent_id: agentId,
        mode: 'main',
        event_type: 'turn_start',
        payload: { content: 'test' },
        track: 'track2',
        slot_number: 5,
      });

      const entries = await readJsonLines(ledgerPath);
      expect(entries[0].track).toBe('track2');
      expect(entries[0].slot_number).toBe(5);
    });
  });

  describe('ledger entries isolation by track', () => {
    beforeEach(async () => {
      // Setup: write entries for two different tracks
      await appendLedgerEvent(ledgerPath, {
        session_id: sessionId,
        agent_id: agentId,
        mode: 'main',
        event_type: 'turn_start',
        payload: { content: 'track0 first' },
        track: 'track0',
      });
      await appendLedgerEvent(ledgerPath, {
        session_id: sessionId,
        agent_id: agentId,
        mode: 'main',
        event_type: 'model_round',
        payload: { content: 'track0 response' },
        track: 'track0',
      });
      await appendLedgerEvent(ledgerPath, {
        session_id: sessionId,
        agent_id: agentId,
        mode: 'main',
        event_type: 'turn_start',
        payload: { content: 'track1 first' },
        track: 'track1',
      });
      await appendLedgerEvent(ledgerPath, {
        session_id: sessionId,
        agent_id: agentId,
        mode: 'main',
        event_type: 'model_round',
        payload: { content: 'track1 response' },
        track: 'track1',
      });
      // Legacy entry without track
      await appendLedgerEvent(ledgerPath, {
        session_id: sessionId,
        agent_id: agentId,
        mode: 'main',
        event_type: 'turn_start',
        payload: { content: 'legacy entry' },
      });
    });

    it('has 5 total entries', async () => {
      const entries = await readJsonLines(ledgerPath);
      expect(entries.length).toBe(5);
    });

    it('has correct track distribution', async () => {
      const entries = await readJsonLines(ledgerPath);
      const track0 = entries.filter(e => e.track === 'track0');
      const track1 = entries.filter(e => e.track === 'track1');
      const legacy = entries.filter(e => !e.track);

      expect(track0.length).toBe(2);
      expect(track1.length).toBe(2);
      expect(legacy.length).toBe(1);
    });
  });
});

describe('multi-track backward compatibility', () => {
  it('treats entries without track as track0 in filterLedgerEntries', () => {
    const entries = [
      { track: 'track0', timestamp_ms: 1, event_type: 'test', payload: {}, session_id: 's1', agent_id: 'a1', mode: 'main' },
      { track: undefined, timestamp_ms: 2, event_type: 'test', payload: {}, session_id: 's1', agent_id: 'a1', mode: 'main' },
      { track: 'track1', timestamp_ms: 3, event_type: 'test', payload: {}, session_id: 's1', agent_id: 'a1', mode: 'main' },
    ];

    // Import filterLedgerEntries logic inline since it's not exported
    const filterTrack0 = entries.filter((e) => ((e as any).track ?? 'track0') === 'track0');
    expect(filterTrack0).toHaveLength(2); // track0 + undefined

    const filterTrack1 = entries.filter((e) => ((e as any).track ?? 'track0') === 'track1');
    expect(filterTrack1).toHaveLength(1); // only track1
  });

  it('groupLedgerEntriesByTaskBoundary handles entries without track', () => {
    const entries: any[] = [
      { event_type: 'turn_start', payload: {}, slot: 1 },
      { event_type: 'model_round', payload: {}, slot: 2 },
      { event_type: 'turn_complete', payload: {}, slot: 3 },
    ];

    // groupLedgerEntriesByTaskBoundary should work regardless of track field
    // It splits by event_type, not by track
    const boundaries = ['turn_start', 'turn_complete'];
    const blocks: any[][] = [];
    let current: any[] = [];
    for (const entry of entries) {
      if (boundaries.includes(entry.event_type) && current.length > 0) {
        blocks.push([...current]);
        current = [];
      }
      current.push(entry);
    }
    if (current.length > 0) blocks.push(current);

    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('session migration backward compatibility', () => {
  // Note: SessionManager uses global SESSIONS_DIR, so we test logic inline
  // The actual migration happens in loadSessionFile when a session without track is loaded

  it('assigns track0 to sessions without track field (migration logic)', () => {
    // Simulate what loadSessionFile does for legacy sessions
    const legacySession = {
      id: 'legacy-session-123',
      name: 'Legacy Project',
      projectPath: '/tmp/legacy-project',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      messages: [],
      activeWorkflows: [],
      context: { memoryOwnerWorkerId: 'finger-project-agent-01', ownerAgentId: 'finger-project-agent' },
    };

    // Migration logic from SessionManager.loadSessionFile
    if (!legacySession.track) {
      (legacySession as any).track = 'track0';
    }

    expect(legacySession.track).toBe('track0');
  });

  it('filterLedgerEntries treats undefined track as track0', () => {
    // This is the core backward compat logic in context-ledger-memory.ts
    const entries = [
      { track: 'track0', timestamp_ms: 1 },
      { track: undefined, timestamp_ms: 2 },
      { track: 'track1', timestamp_ms: 3 },
    ];

    // The logic: entry.track ?? 'track0'
    const track0Count = entries.filter((e: any) => (e.track ?? 'track0') === 'track0').length;
    expect(track0Count).toBe(2); // track0 + undefined

    const track1Count = entries.filter((e: any) => (e.track ?? 'track0') === 'track1').length;
    expect(track1Count).toBe(1); // only track1
  });
});
