/**
 * Dispatch Tracker & Cascade Interrupt Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DispatchTracker, resetGlobalDispatchTracker } from '../../src/server/modules/agent-runtime/dispatch-tracker.js';
import { tmpdir } from 'os';
import path from 'path';

describe('DispatchTracker', () => {
  let tracker: DispatchTracker;

  beforeEach(() => {
    const testFile = path.join(
      tmpdir(),
      `dispatch-tracker-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    );
    tracker = new DispatchTracker(testFile);
    resetGlobalDispatchTracker();
  });

  it('should track a dispatch relationship', () => {
    tracker.track({
      dispatchId: 'dispatch-1',
      parentSessionId: 'session-parent',
      childSessionId: 'session-child',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'project:/some/path',
    });

    const children = tracker.getActiveChildSessionIds('session-parent');
    expect(children).toEqual(['session-child']);
  });

  it('should return empty array for unknown parent', () => {
    const children = tracker.getActiveChildSessionIds('unknown-session');
    expect(children).toEqual([]);
  });

  it('should track multiple dispatches from same parent', () => {
    tracker.track({
      dispatchId: 'dispatch-1',
      parentSessionId: 'session-parent',
      childSessionId: 'session-child-1',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'project:/path1',
    });
    tracker.track({
      dispatchId: 'dispatch-2',
      parentSessionId: 'session-parent',
      childSessionId: 'session-child-2',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'project:/path2',
    });

    const children = tracker.getActiveChildSessionIds('session-parent');
    expect(children).toEqual(['session-child-1', 'session-child-2']);
  });

  it('should exclude completed dispatches from active children', () => {
    tracker.track({
      dispatchId: 'dispatch-1',
      parentSessionId: 'session-parent',
      childSessionId: 'session-child-1',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'project:/path1',
    });
    tracker.track({
      dispatchId: 'dispatch-2',
      parentSessionId: 'session-parent',
      childSessionId: 'session-child-2',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'project:/path2',
    });

    tracker.complete('dispatch-1');

    const children = tracker.getActiveChildSessionIds('session-parent');
    expect(children).toEqual(['session-child-2']);
  });

  it('should return parent session ID for a child', () => {
    tracker.track({
      dispatchId: 'dispatch-1',
      parentSessionId: 'session-parent',
      childSessionId: 'session-child',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'project:/path',
    });

    expect(tracker.getParentSessionId('session-child')).toBe('session-parent');
    expect(tracker.getParentSessionId('unknown-child')).toBeUndefined();
  });

  it('should report hasActiveChildren correctly', () => {
    tracker.track({
      dispatchId: 'dispatch-1',
      parentSessionId: 'session-parent',
      childSessionId: 'session-child',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'project:/path',
    });

    expect(tracker.hasActiveChildren('session-parent')).toBe(true);
    expect(tracker.hasActiveChildren('session-child')).toBe(false);
    expect(tracker.hasActiveChildren('unknown')).toBe(false);

    tracker.complete('dispatch-1');
    expect(tracker.hasActiveChildren('session-parent')).toBe(false);
  });

  it('should return session stats correctly', () => {
    tracker.track({
      dispatchId: 'dispatch-1',
      parentSessionId: 'session-parent',
      childSessionId: 'session-child-1',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'project:/path1',
    });
    tracker.track({
      dispatchId: 'dispatch-2',
      parentSessionId: 'session-parent',
      childSessionId: 'session-child-2',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'project:/path2',
    });

    expect(tracker.getSessionStats('session-parent')).toEqual({ active: 2, completed: 0, total: 2 });

    tracker.complete('dispatch-1');
    expect(tracker.getSessionStats('session-parent')).toEqual({ active: 1, completed: 1, total: 2 });
  });

  it('should cleanup old completed records', () => {
    tracker.track({
      dispatchId: 'dispatch-1',
      parentSessionId: 'session-parent',
      childSessionId: 'session-child',
      sourceAgentId: 'finger-system-agent',
      targetAgentId: 'project:/path',
    });

    tracker.complete('dispatch-1');

    // Manually set completedAt to a very old time
    const records = tracker.getAllRecords();
    records[0].completedAt = Date.now() - 7200000; // 2 hours ago

    const removed = tracker.cleanup(3600000); // 1 hour max age
    expect(removed).toBe(1);
    expect(tracker.getAllRecords()).toHaveLength(0);
  });
});

describe("getGlobalDispatchTracker", () => {
  it("should return the same instance", async () => {
    const mod = await import("../../src/server/modules/agent-runtime/dispatch-tracker.js");
    const a = mod.getGlobalDispatchTracker();
    const b = mod.getGlobalDispatchTracker();
    expect(a).toBe(b);
    mod.resetGlobalDispatchTracker();
  });
});
