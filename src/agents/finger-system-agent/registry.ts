/**
 * System Agent Registry
 *
 * 管理 Project Agents 的注册表，存储在 ~/.finger/system/registry.json
 */

import { promises as fs } from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';

export type AgentStatus = 'idle' | 'busy' | 'stopped' | 'crashed';

export interface AgentInfo {
  projectId: string;
  projectPath: string;
  projectName: string;
  agentId: string;
  status: AgentStatus;
  lastHeartbeat: string;
  lastSessionId?: string;
  stats: {
    tasksCompleted: number;
    tasksFailed: number;
    uptime: number;
  };
}

export interface AgentRegistry {
  version: number;
  lastUpdate: string;
  agents: Record<string, AgentInfo>;
}

const REGISTRY_VERSION = 1;
const REGISTRY_PATH = path.join(FINGER_PATHS.home, 'system', 'registry.json');

/**
 * 加载 Agent 注册表
 */
export async function loadRegistry(): Promise<AgentRegistry> {
  try {
    const content = await fs.readFile(REGISTRY_PATH, 'utf-8');
    const registry = JSON.parse(content) as AgentRegistry;
    
    // 版本检查
    if (registry.version !== REGISTRY_VERSION) {
      console.warn(`Registry version mismatch: expected ${REGISTRY_VERSION}, got ${registry.version}`);
    }
    
    return registry;
  } catch (error) {
    if ((error as any).code === 'ENOENT') {
      // 注册表不存在，返回空的注册表
      return createEmptyRegistry();
    }
    throw error;
  }
}

/**
 * 保存 Agent 注册表
 */
export async function saveRegistry(registry: AgentRegistry): Promise<void> {
  registry.lastUpdate = new Date().toISOString();
  await fs.mkdir(path.dirname(REGISTRY_PATH), { recursive: true });
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

/**
 * 创建空的注册表
 */
function createEmptyRegistry(): AgentRegistry {
  return {
    version: REGISTRY_VERSION,
    lastUpdate: new Date().toISOString(),
    agents: {},
  };
}

/**
 * 注册 Agent
 */
export async function registerAgent(agentInfo: AgentInfo): Promise<void> {
  const registry = await loadRegistry();
  registry.agents[agentInfo.projectId] = {
    ...agentInfo,
    lastHeartbeat: new Date().toISOString(),
    stats: {
      tasksCompleted: 0,
      tasksFailed: 0,
      uptime: 0,
      ...agentInfo.stats,
    },
  };
  await saveRegistry(registry);
}

/**
 * 注销 Agent
 */
export async function unregisterAgent(projectId: string): Promise<void> {
  const registry = await loadRegistry();
  delete registry.agents[projectId];
  await saveRegistry(registry);
}

/**
 * 更新 Agent 信息
 */
export async function updateAgent(projectId: string, updates: Partial<AgentInfo>): Promise<void> {
  const registry = await loadRegistry();
  const agent = registry.agents[projectId];
  
  if (!agent) {
    throw new Error(`Agent not found: ${projectId}`);
  }
  
  registry.agents[projectId] = {
    ...agent,
    ...updates,
    lastHeartbeat: new Date().toISOString(),
  };
  
  await saveRegistry(registry);
}

/**
 * 列出所有 Agents
 */
export async function listAgents(): Promise<AgentInfo[]> {
  const registry = await loadRegistry();
  return Object.values(registry.agents);
}

/**
 * 获取 Agent 状态
 */
export async function getAgentStatus(projectId: string): Promise<AgentInfo | null> {
  const registry = await loadRegistry();
  return registry.agents[projectId] || null;
}

/**
 * 更新 Agent 心跳
 */
export async function updateHeartbeat(projectId: string): Promise<void> {
  await updateAgent(projectId, {
    lastHeartbeat: new Date().toISOString(),
  });
}

/**
 * 更新 Agent 状态
 */
export async function updateAgentStatus(projectId: string, status: AgentStatus): Promise<void> {
  await updateAgent(projectId, { status });
}

/**
 * 更新 Agent 统计信息
 */
export async function updateAgentStats(
  projectId: string,
  updates: Partial<AgentInfo['stats']>
): Promise<void> {
  const registry = await loadRegistry();
  const agent = registry.agents[projectId];
  
  if (!agent) {
    throw new Error(`Agent not found: ${projectId}`);
  }
  
  registry.agents[projectId] = {
    ...agent,
    stats: {
      ...agent.stats,
      ...updates,
    },
  };
  
  await saveRegistry(registry);
}

/**
 * 清理长时间未心跳的 Agents
 */
export async function cleanupStaleAgents(timeoutMs: number = 24 * 60 * 60 * 1000): Promise<void> {
  const registry = await loadRegistry();
  const now = Date.now();
  const staleProjectIds: string[] = [];
  
  for (const [projectId, agent] of Object.entries(registry.agents)) {
    const lastHeartbeat = new Date(agent.lastHeartbeat).getTime();
    if (now - lastHeartbeat > timeoutMs) {
      staleProjectIds.push(projectId);
    }
  }
  
  for (const projectId of staleProjectIds) {
    delete registry.agents[projectId];
  }
  
  if (staleProjectIds.length > 0) {
    await saveRegistry(registry);
  }
  
  return;
}
