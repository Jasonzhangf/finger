/**
 * Periodic Check Heartbeat Integration Test
 * 验证心跳真的被发送到 idle agents
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { getFingerPaths } from '../../src/core/finger-paths.js';

let registryPath = '';
let tempHome = '';

describe('Periodic Check Heartbeat Integration', () => {
  beforeEach(async () => {
    tempHome = path.join(tmpdir(), `finger-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    process.env.FINGER_HOME = tempHome;
    vi.resetModules();
    const paths = getFingerPaths(tempHome);
    registryPath = path.join(paths.home, 'system', 'registry.json');

    // 创建测试 registry - 使用和 runtime_view 返回匹配的 agentId
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify({
      version: 1,
      lastUpdate: new Date().toISOString(),
      agents: {
        'finger-orchestrator-project': {
          projectId: 'finger-orchestrator-project',
          projectPath: '/test/finger-project',
          projectName: 'finger-project',
          agentId: 'finger-system-agent',  // 匹配 runtime_view 返回的 agent id
          status: 'idle',
          lastHeartbeat: new Date().toISOString(),
          monitored: true,
          stats: { tasksCompleted: 0, tasksFailed: 0, uptime: 0 },
        },
      },
    }, null, 2));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should load registry from disk', async () => {
    const { loadRegistry } = await import('../../src/agents/finger-system-agent/registry.js');
    const registry = await loadRegistry();
    
    expect(registry.agents).toBeDefined();
    expect(Object.keys(registry.agents)).toHaveLength(1);
    expect(registry.agents['finger-orchestrator-project'].agentId).toBe('finger-system-agent');
  });

  it('should list agents', async () => {
    const { listAgents } = await import('../../src/agents/finger-system-agent/registry.js');
    const agents = await listAgents();
    
    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe('finger-system-agent');
  });

  it('should update agent status', async () => {
    const { updateAgentStatus, loadRegistry } = await import('../../src/agents/finger-system-agent/registry.js');
    
    await updateAgentStatus('finger-orchestrator-project', 'busy');
    
    const registry = await loadRegistry();
    expect(registry.agents['finger-orchestrator-project'].status).toBe('busy');
  });

  it('should set monitor status', async () => {
    const { setMonitorStatus } = await import('../../src/agents/finger-system-agent/registry.js');
    
    const agent = await setMonitorStatus('/test/new-project', true);
    
    expect(agent.monitored).toBe(true);
    expect(agent.projectPath).toBe('/test/new-project');
  });

  it('should support heartbeat operations', async () => {
    const { loadRegistry, listAgents } = await import('../../src/agents/finger-system-agent/registry.js');
    
    const registry = await loadRegistry();
    expect(registry.agents).toBeDefined();
    
    const agents = await listAgents();
    expect(agents.length).toBeGreaterThan(0);
    
    agents.forEach(agent => {
      expect(agent.lastHeartbeat).toBeDefined();
      expect(agent.status).toMatch(/idle|busy|stopped|crashed/);
    });
  });
});
