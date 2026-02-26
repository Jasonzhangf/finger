import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { IflowSessionMapStore } from '../../../src/agents/sdk/iflow-session-map.js';

describe('iflow-session-map', () => {
  it('stores and reads bindings', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'iflow-map-'));
    const filePath = path.join(dir, 'map.json');
    const store = new IflowSessionMapStore(filePath);

    const binding = store.set('finger-1', 'iflow-1');
    const loaded = store.get('finger-1');

    expect(binding.fingerSessionId).toBe('finger-1');
    expect(binding.agentId).toBe('iflow-default');
    expect(binding.provider).toBe('iflow');
    expect(binding.iflowSessionId).toBe('iflow-1');
    expect(loaded).toEqual(binding);

    rmSync(dir, { recursive: true, force: true });
  });

  it('removes bindings and supports listing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'iflow-map-'));
    const filePath = path.join(dir, 'map.json');
    const store = new IflowSessionMapStore(filePath);

    store.set('finger-1', 'iflow-1');
    store.set('finger-2', 'iflow-2');
    expect(store.list().length).toBe(2);

    expect(store.remove('finger-1')).toBe(true);
    expect(store.get('finger-1')).toBeNull();
    expect(store.list().length).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it('isolates mappings by agent scope under the same finger session', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'iflow-map-'));
    const filePath = path.join(dir, 'map.json');
    const orchestratorStore = new IflowSessionMapStore(filePath, { agentId: 'orchestrator' });
    const reviewerStore = new IflowSessionMapStore(filePath, { agentId: 'reviewer' });

    orchestratorStore.set('finger-1', 'iflow-orchestrator');
    reviewerStore.set('finger-1', 'iflow-reviewer');

    expect(orchestratorStore.get('finger-1')?.iflowSessionId).toBe('iflow-orchestrator');
    expect(reviewerStore.get('finger-1')?.iflowSessionId).toBe('iflow-reviewer');
    expect(orchestratorStore.list()).toHaveLength(1);
    expect(reviewerStore.list()).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true });
  });
});
