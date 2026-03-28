import { describe, expect, it } from 'vitest';
import {
  buildContextBuilderHistoryIndex,
  buildIndexedHistoryFromSnapshot,
  buildNextIndexedHistoryIndex,
  readPersistedContextBuilderHistoryIndex,
} from '../../../src/server/modules/context-builder-history-index.js';

describe('context-builder-history-index', () => {
  it('buildContextBuilderHistoryIndex splits historical/current zones and keeps message order', () => {
    const index = buildContextBuilderHistoryIndex(
      'context_builder_bootstrap',
      'moderate',
      100000,
      ['block-a', 'block-b'],
      [
        {
          id: 'm-h1',
          role: 'user',
          content: 'history 1',
          timestampIso: '2026-03-28T00:00:00.000Z',
          contextZone: 'historical_memory',
        },
        {
          id: 'm-h2',
          role: 'assistant',
          content: 'history 2',
          timestampIso: '2026-03-28T00:00:01.000Z',
          contextZone: 'historical_memory',
        },
        {
          id: 'm-c1',
          role: 'user',
          content: 'current 1',
          timestampIso: '2026-03-28T00:00:02.000Z',
          contextZone: 'working_set',
        },
      ],
      {
        pinnedMessageIds: ['m-pin-1'],
        currentContextMaxItems: 20,
      },
    );

    expect(index.historySelectedMessageIds).toEqual(['m-h1', 'm-h2']);
    expect(index.currentContextMessageIds).toEqual(['m-c1']);
    expect(index.selectedMessageIds).toEqual(['m-h1', 'm-h2', 'm-c1']);
    expect(index.pinnedMessageIds).toEqual(['m-pin-1']);
    expect(index.currentContextMaxItems).toBe(20);
    expect(index.anchorMessageId).toBe('m-c1');
    expect(index.anchorTimestamp).toBe('2026-03-28T00:00:02.000Z');
  });

  it('buildIndexedHistoryFromSnapshot preserves recent turns and delta when limit is tight', () => {
    const result = buildIndexedHistoryFromSnapshot(
      [
        { id: 'm1', role: 'system', content: 'sys', timestamp: '2026-03-28T00:00:00.000Z' },
        { id: 'm2', role: 'user', content: 'history-a', timestamp: '2026-03-28T00:00:01.000Z' },
        { id: 'm3', role: 'assistant', content: 'history-b', timestamp: '2026-03-28T00:00:02.000Z' },
        { id: 'm4', role: 'user', content: 'current-a', timestamp: '2026-03-28T00:00:03.000Z' },
        { id: 'm5', role: 'assistant', content: 'delta-a', timestamp: '2026-03-28T00:00:04.000Z' },
        { id: 'm6', role: 'user', content: 'delta-b', timestamp: '2026-03-28T00:00:05.000Z' },
      ],
      {
        version: 1,
        source: 'context_builder_bootstrap',
        buildMode: 'moderate',
        targetBudget: 100000,
        selectedBlockIds: ['b1'],
        selectedMessageIds: ['m2', 'm3', 'm4'],
        historySelectedMessageIds: ['m2', 'm3'],
        currentContextMessageIds: ['m4'],
        pinnedMessageIds: ['m1'],
        currentContextMaxItems: 10,
        anchorMessageId: 'm4',
        anchorTimestamp: '2026-03-28T00:00:03.000Z',
        updatedAt: '2026-03-28T00:00:03.000Z',
      },
      4,
    );

    expect(result).not.toBeNull();
    expect(result?.messages.map((m) => m.id)).toEqual(['m3', 'm4', 'm5', 'm6']);
    expect(result?.selectedCount).toBe(4);
    expect(result?.deltaCount).toBe(2);
  });

  it('buildNextIndexedHistoryIndex keeps historical ids and rolls current context by max window', () => {
    const next = buildNextIndexedHistoryIndex(
      {
        version: 1,
        source: 'context_builder_indexed',
        buildMode: 'aggressive',
        targetBudget: 100000,
        selectedBlockIds: ['b1'],
        selectedMessageIds: ['m-h1', 'm-h2', 'm-c1'],
        historySelectedMessageIds: ['m-h1', 'm-h2'],
        currentContextMessageIds: ['m-c1'],
        currentContextMaxItems: 2,
        anchorMessageId: 'm-c1',
        anchorTimestamp: '2026-03-28T00:00:02.000Z',
        updatedAt: '2026-03-28T00:00:02.000Z',
      },
      [
        { id: 'm-h1', timestamp: '2026-03-28T00:00:00.000Z' },
        { id: 'm-h2', timestamp: '2026-03-28T00:00:01.000Z' },
        { id: 'm-c1', timestamp: '2026-03-28T00:00:02.000Z' },
        { id: 'm-c2', timestamp: '2026-03-28T00:00:03.000Z' },
        { id: 'm-c3', timestamp: '2026-03-28T00:00:04.000Z' },
      ],
    );

    expect(next.historySelectedMessageIds).toEqual(['m-h1', 'm-h2']);
    expect(next.currentContextMessageIds).toEqual(['m-c2', 'm-c3']);
    expect(next.selectedMessageIds).toEqual(['m-h1', 'm-h2', 'm-c2', 'm-c3']);
    expect(next.anchorMessageId).toBe('m-c3');
    expect(next.anchorTimestamp).toBe('2026-03-28T00:00:04.000Z');
  });

  it('readPersistedContextBuilderHistoryIndex returns null for invalid payloads', () => {
    expect(readPersistedContextBuilderHistoryIndex(undefined)).toBeNull();
    expect(readPersistedContextBuilderHistoryIndex({})).toBeNull();
    expect(
      readPersistedContextBuilderHistoryIndex({
        contextBuilderHistoryIndex: {
          selectedMessageIds: [],
        },
      }),
    ).toBeNull();
  });
});
