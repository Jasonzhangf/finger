import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { DispatchTracker, cascadeInterrupt } from '../../../src/server/modules/agent-runtime/dispatch-tracker.js';

describe('dispatch-tracker persistence', () => {
  it('loads parent-child dispatch graph from persisted file across tracker instances', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dispatch-tracker-'));
    const filePath = path.join(dir, 'dispatch-graph.json');

    const trackerA = new DispatchTracker(filePath);
    trackerA.track({
      dispatchId: 'dispatch-1',
      parentSessionId: 'parent-1',
      childSessionId: 'child-1',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
    });

    const trackerB = new DispatchTracker(filePath);
    expect(trackerB.getActiveChildSessionIds('parent-1')).toEqual(['child-1']);
  });

  it('cascade interrupt can use persisted dispatch graph after restart-like reload', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dispatch-tracker-cascade-'));
    const filePath = path.join(dir, 'dispatch-graph.json');

    const trackerA = new DispatchTracker(filePath);
    trackerA.track({
      dispatchId: 'dispatch-cascade-1',
      parentSessionId: 'system-root',
      childSessionId: 'project-child',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'finger-project-agent',
    });

    const trackerReloaded = new DispatchTracker(filePath);
    const interruptSession = vi.fn((sessionId: string) => [{ interrupted: true, sessionId }]);
    const result = await cascadeInterrupt({
      sessionManager: {
        listSessions: vi.fn(() => []),
      } as any,
      chatCodexRunner: {
        listSessionStates: vi.fn(() => []),
        interruptSession,
      },
      dispatchTracker: trackerReloaded,
    }, 'system-root');

    expect(result.errors).toEqual([]);
    expect(result.interruptedSessions).toEqual(expect.arrayContaining(['system-root', 'project-child']));
    expect(interruptSession).toHaveBeenCalledWith('project-child', undefined);
  });
});
