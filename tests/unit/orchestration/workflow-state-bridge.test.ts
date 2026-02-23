/**
 * Workflow State Bridge 单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  stateSnapshotManager,
  getStateSnapshot,
  getAllStateSnapshots,
  type StateSnapshot,
} from '../../../src/orchestration/workflow-state-bridge.js';

describe('StateSnapshotManager', () => {
  beforeEach(() => {
    // 清空快照
    (stateSnapshotManager as any).snapshots.clear();
  });

  it('should update and get snapshot', () => {
    const snapshot: StateSnapshot = {
      workflowId: 'wf-1',
      sessionId: 'session-1',
      fsmState: 'execution',
      simplifiedStatus: 'executing',
      tasks: [
        { id: 't1', fsmState: 'running', simplifiedStatus: 'in_progress', assignee: 'agent-1' },
      ],
      agents: [
        { id: 'agent-1', fsmState: 'running', simplifiedStatus: 'running' },
      ],
      timestamp: new Date().toISOString(),
    };

    stateSnapshotManager.update(snapshot);

    const retrieved = stateSnapshotManager.get('wf-1');
    expect(retrieved).toBeDefined();
    expect(retrieved?.workflowId).toBe('wf-1');
    expect(retrieved?.fsmState).toBe('execution');
  });

  it('should return undefined for non-existent snapshot', () => {
    const retrieved = stateSnapshotManager.get('non-existent');
    expect(retrieved).toBeUndefined();
  });

  it('should get all snapshots', () => {
    const snapshot1: StateSnapshot = {
      workflowId: 'wf-1',
      sessionId: 'session-1',
      fsmState: 'execution',
      simplifiedStatus: 'executing',
      tasks: [],
      agents: [],
      timestamp: new Date().toISOString(),
    };

    const snapshot2: StateSnapshot = {
      workflowId: 'wf-2',
      sessionId: 'session-2',
      fsmState: 'plan_loop',
      simplifiedStatus: 'planning',
      tasks: [],
      agents: [],
      timestamp: new Date().toISOString(),
    };

    stateSnapshotManager.update(snapshot1);
    stateSnapshotManager.update(snapshot2);

    const all = stateSnapshotManager.getAll();
    expect(all.length).toBe(2);
    expect(all.map(s => s.workflowId)).toContain('wf-1');
    expect(all.map(s => s.workflowId)).toContain('wf-2');
  });

  it('should clear snapshot', () => {
    const snapshot: StateSnapshot = {
      workflowId: 'wf-1',
      sessionId: 'session-1',
      fsmState: 'execution',
      simplifiedStatus: 'executing',
      tasks: [],
      agents: [],
      timestamp: new Date().toISOString(),
    };

    stateSnapshotManager.update(snapshot);
    expect(stateSnapshotManager.get('wf-1')).toBeDefined();

    stateSnapshotManager.clear('wf-1');
    expect(stateSnapshotManager.get('wf-1')).toBeUndefined();
  });

  it('should overwrite existing snapshot', () => {
    const snapshot1: StateSnapshot = {
      workflowId: 'wf-1',
      sessionId: 'session-1',
      fsmState: 'plan_loop',
      simplifiedStatus: 'planning',
      tasks: [],
      agents: [],
      timestamp: new Date().toISOString(),
    };

    const snapshot2: StateSnapshot = {
      workflowId: 'wf-1',
      sessionId: 'session-1',
      fsmState: 'execution',
      simplifiedStatus: 'executing',
      tasks: [],
      agents: [],
      timestamp: new Date().toISOString(),
    };

    stateSnapshotManager.update(snapshot1);
    expect(stateSnapshotManager.get('wf-1')?.fsmState).toBe('plan_loop');

    stateSnapshotManager.update(snapshot2);
    expect(stateSnapshotManager.get('wf-1')?.fsmState).toBe('execution');
  });
});

describe('getStateSnapshot helper', () => {
  beforeEach(() => {
    (stateSnapshotManager as any).snapshots.clear();
  });

  it('should get snapshot via helper function', () => {
    const snapshot: StateSnapshot = {
      workflowId: 'wf-1',
      sessionId: 'session-1',
      fsmState: 'review',
      simplifiedStatus: 'executing',
      tasks: [],
      agents: [],
      timestamp: new Date().toISOString(),
    };

    stateSnapshotManager.update(snapshot);

    const retrieved = getStateSnapshot('wf-1');
    expect(retrieved).toBeDefined();
    expect(retrieved?.fsmState).toBe('review');
  });

  it('should return undefined via helper function', () => {
    const retrieved = getStateSnapshot('non-existent');
    expect(retrieved).toBeUndefined();
  });
});

describe('getAllStateSnapshots helper', () => {
  beforeEach(() => {
    (stateSnapshotManager as any).snapshots.clear();
  });

  it('should get all snapshots via helper function', () => {
    const snapshot1: StateSnapshot = {
      workflowId: 'wf-1',
      sessionId: 'session-1',
      fsmState: 'execution',
      simplifiedStatus: 'executing',
      tasks: [],
      agents: [],
      timestamp: new Date().toISOString(),
    };

    const snapshot2: StateSnapshot = {
      workflowId: 'wf-2',
      sessionId: 'session-2',
      fsmState: 'completed',
      simplifiedStatus: 'completed',
      tasks: [],
      agents: [],
      timestamp: new Date().toISOString(),
    };

    stateSnapshotManager.update(snapshot1);
    stateSnapshotManager.update(snapshot2);

    const all = getAllStateSnapshots();
    expect(all.length).toBe(2);
  });

  it('should return empty array when no snapshots', () => {
    const all = getAllStateSnapshots();
    expect(all).toEqual([]);
  });
});
