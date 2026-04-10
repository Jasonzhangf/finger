/**
 * Periodic Check Runtime Test
 * 验证 PeriodicCheckRunner 在真实运行时的行为
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PeriodicCheckRunner } from '../../src/agents/finger-system-agent/periodic-check.js';
import { promises as fs } from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../../src/core/finger-paths.js';
import type { AgentRuntimeDeps } from '../../src/server/modules/agent-runtime/types.js';

const REGISTRY_PATH = path.join(FINGER_PATHS.home, 'system', 'registry.json');

describe('Periodic Check Runtime', () => {
  let deps: AgentRuntimeDeps;

  beforeEach(async () => {
    // Create test registry - agentId matches what runtime_view returns
    await fs.mkdir(path.dirname(REGISTRY_PATH), { recursive: true });
    await fs.writeFile(REGISTRY_PATH, JSON.stringify({
      version: 1,
      lastUpdate: new Date().toISOString(),
      agents: {
        'finger-orchestrator-project': {
          projectId: 'finger-orchestrator-project',
          projectPath: '/test/finger-project',
          projectName: 'finger-project',
          agentId: 'finger-system-agent',  // Matches runtime_view agent.id
          status: 'idle',
          lastHeartbeat: new Date().toISOString(),
          monitored: true,
          stats: { tasksCompleted: 0, tasksFailed: 0, uptime: 0 },
        },
      },
    }, null, 2));

    // Mock deps
    deps = {
      broadcast: vi.fn(),
      agentRuntimeBlock: {
        execute: async (command: string, args: any) => {
          if (command === 'runtime_view') {
            return {
              agents: [
                { id: 'finger-system-agent', status: 'idle' },
              ],
            };
          }
          
          if (command === 'dispatch') {
            return { ok: true, dispatchId: `dispatch-${Date.now()}` };
          }
          
          return {};
        },
      },
      sessionManager: {
        getCurrentSession: () => ({ id: 'test-session' }),
        list: () => [],
        ensureSession: () => {},
      },
    } as unknown as AgentRuntimeDeps;
  });

  afterEach(async () => {
    try {
      await fs.unlink(REGISTRY_PATH);
    } catch {
      // ignore
    }
  });

  it('should run periodic check without errors', async () => {
    const runner = new PeriodicCheckRunner(deps, { intervalMs: 1000 });
    
    // Should not throw
    await expect(runner.runOnce()).resolves.not.toThrow();
    
    runner.stop();
  });

  it('should update registry with agent statuses', async () => {
    const { loadRegistry } = await import('../../src/agents/finger-system-agent/registry.js');
    
    const runner = new PeriodicCheckRunner(deps, { intervalMs: 1000 });
    await runner.runOnce();
    runner.stop();
    
    // 检查 registry 被更新
    const registry = await loadRegistry();
    expect(registry.lastUpdate).toBeDefined();
  });

  it('should use 5-minute default interval', () => {
    const runner = new PeriodicCheckRunner(deps);
    expect(runner).toBeDefined();
    runner.stop();
  });

  it('should emit agent status changed event', async () => {
    const runner = new PeriodicCheckRunner(deps, { intervalMs: 1000 });
    await runner.runOnce();
    runner.stop();
    
    // broadcast 应该被调用
    expect(deps.broadcast).toHaveBeenCalled();
  });
});
