import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadOrchestrationConfig,
  saveOrchestrationConfig,
  validateOrchestrationConfig,
} from '../../../src/orchestration/orchestration-config.js';
function resolveHome(override?: string): string {
  return (override && override.trim().length > 0)
    ? override.trim()
    : join(process.env.HOME || '', '.finger');
}
describe('orchestration-config', () => {
  it('creates default orchestration.json when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finger-orch-'));
    const previousHome = process.env.FINGER_HOME;
    process.env.FINGER_HOME = dir;
    expect(resolveHome(process.env.FINGER_HOME)).toBe(dir);
    try {
      const loaded = loadOrchestrationConfig();
      expect(loaded.created).toBe(true);
      expect(loaded.path).toBe(join(resolveHome(process.env.FINGER_HOME), 'config', 'orchestration.json'));
      expect(loaded.config.activeProfileId).toBe('default');
      const active = loaded.config.profiles.find((item) => item.id === loaded.config.activeProfileId);
      expect(active?.agents.some((item) => item.role === 'orchestrator' && item.enabled !== false)).toBe(true);
      expect(active?.agents.some((item) => item.role === 'reviewer' && item.enabled !== false)).toBe(false);
      expect(active?.agents.some((item) => item.role === 'searcher' && item.enabled !== false)).toBe(true);
      expect(loaded.config.profiles.some((item) => item.id === 'full_mock')).toBe(true);
    } finally {
      if (previousHome === undefined) {
        delete process.env.FINGER_HOME;
      } else {
        process.env.FINGER_HOME = previousHome;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects config without enabled orchestrator', () => {
    expect(() => validateOrchestrationConfig({
      version: 1,
      activeProfileId: 'default',
      profiles: [
        {
          id: 'default',
          name: 'Default',
          agents: [{ targetAgentId: 'executor-loop', role: 'executor', enabled: true }],
        },
      ],
    })).toThrow('exactly one enabled orchestrator');
  });

  it('rejects config with multiple enabled orchestrators', () => {
    expect(() => validateOrchestrationConfig({
      version: 1,
      activeProfileId: 'default',
      profiles: [
        {
          id: 'default',
          name: 'Default',
          agents: [
            { targetAgentId: 'orchestrator-loop', role: 'orchestrator', enabled: true },
            { targetAgentId: 'orchestrator-b', role: 'orchestrator', enabled: true },
          ],
        },
      ],
    })).toThrow('exactly one enabled orchestrator');
  });

  it('saves and loads valid config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'finger-orch-'));
    const previousHome = process.env.FINGER_HOME;
    process.env.FINGER_HOME = dir;
    expect(resolveHome(process.env.FINGER_HOME)).toBe(dir);
    try {
      saveOrchestrationConfig({
        version: 1,
        activeProfileId: 'mock',
        profiles: [
          {
            id: 'default',
            name: 'Default',
            agents: [
              { targetAgentId: 'orchestrator-loop', role: 'orchestrator', enabled: true, instanceCount: 1 },
              { targetAgentId: 'executor-loop', role: 'executor', enabled: true, instanceCount: 1 },
            ],
          },
          {
            id: 'mock',
            name: 'Mock',
            agents: [
              { targetAgentId: 'orchestrator-loop', role: 'orchestrator', enabled: true, instanceCount: 1 },
              { targetAgentId: 'executor-debug-loop', role: 'executor', enabled: true, instanceCount: 1 },
            ],
          },
        ],
      });
      const loaded = loadOrchestrationConfig();
      expect(loaded.created).toBe(false);
      expect(loaded.path).toBe(join(resolveHome(process.env.FINGER_HOME), 'config', 'orchestration.json'));
      expect(loaded.config.activeProfileId).toBe('mock');
      expect(loaded.config.profiles).toHaveLength(2);
      expect(loaded.config.profiles[1].agents[1].targetAgentId).toBe('executor-debug-loop');
    } finally {
      if (previousHome === undefined) {
        delete process.env.FINGER_HOME;
      } else {
        process.env.FINGER_HOME = previousHome;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
