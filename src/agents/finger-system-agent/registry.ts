/**
 * System Agent Registry
 *
 * 管理 Project Agents 的注册表，存储在 ~/.finger/system/registry.json
 */

import { promises as fs } from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { logger } from '../../core/logger.js';

const log = logger.module('projectId');

export type AgentStatus = 'idle' | 'busy' | 'stopped' | 'crashed' | 'completed';

export interface AgentStats {
  tasksCompleted: number;
  tasksFailed: number;
  uptime: number;
}

export interface AgentInfo {
  projectId: string;
  projectPath: string;
  projectName: string;
  agentId: string;
  status: AgentStatus;
  lastHeartbeat: string;
  lastSessionId?: string;
  monitored?: boolean;
  monitorUpdatedAt?: string;
  stats: AgentStats;
}

export interface AgentRegistry {
  version: number;
  lastUpdate: string;
  agents: Record<string, AgentInfo>;
}

const REGISTRY_VERSION = 1;
const REGISTRY_PATH = path.join(FINGER_PATHS.home, 'system', 'registry.json');

export function normalizeProjectPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function projectIdFromPath(projectPath: string): string {
  return normalizeProjectPath(projectPath);
}

function deriveProjectName(projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized || 'unknown-project';
}

/**
 * 加载 Agent 注册表
 */
export async function loadRegistry(): Promise<AgentRegistry> {
  try {
    const content = await fs.readFile(REGISTRY_PATH, 'utf-8');
    
    // Handle empty file
    if (!content || content.trim() === '') {
      log.warn('Registry file is empty, creating new one');
      return createEmptyRegistry();
    }
    
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
    if ((error as any) instanceof SyntaxError) {
      // JSON parse error (empty or corrupted file)
      log.warn('Failed to parse registry file, creating new one');
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
  const existing = registry.agents[agentInfo.projectId];
  const projectPath = agentInfo.projectPath?.trim() || existing?.projectPath || '';
  const projectName = agentInfo.projectName || existing?.projectName || deriveProjectName(projectPath);
  const mergedStats: AgentStats = {
    tasksCompleted: agentInfo.stats?.tasksCompleted ?? existing?.stats?.tasksCompleted ?? 0,
    tasksFailed: agentInfo.stats?.tasksFailed ?? existing?.stats?.tasksFailed ?? 0,
    uptime: agentInfo.stats?.uptime ?? existing?.stats?.uptime ?? 0,
  };
  registry.agents[agentInfo.projectId] = {
    ...existing,
    ...agentInfo,
    projectPath,
    projectName,
    monitored: existing?.monitored ?? agentInfo.monitored,
    monitorUpdatedAt: existing?.monitorUpdatedAt ?? agentInfo.monitorUpdatedAt,
    lastHeartbeat: new Date().toISOString(),
    stats: mergedStats,
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
  
  const nextProjectPath = typeof updates.projectPath === 'string'
    ? updates.projectPath.trim()
    : agent.projectPath;
  registry.agents[projectId] = {
    ...agent,
    ...updates,
    projectPath: nextProjectPath,
    projectName: updates.projectName || agent.projectName || deriveProjectName(nextProjectPath),
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
 * 更新项目的系统监控状态
 */
export async function setMonitorStatus(projectPath: string, enabled: boolean): Promise<AgentInfo> {
  const trimmedPath = projectPath.trim();
  if (!trimmedPath) {
    throw new Error('projectPath is required');
  }

  const projectId = projectIdFromPath(trimmedPath);
  const registry = await loadRegistry();
  const existing = registry.agents[projectId];
  const now = new Date().toISOString();

  const base: AgentInfo = existing || {
    projectId,
    projectPath: trimmedPath,
    projectName: deriveProjectName(trimmedPath),
    agentId: `project:${projectId}`,
    status: 'idle',
    lastHeartbeat: now,
    stats: {
      tasksCompleted: 0,
      tasksFailed: 0,
      uptime: 0,
    },
  };

  const next: AgentInfo = {
    ...base,
    projectPath: trimmedPath || base.projectPath,
    projectName: base.projectName || deriveProjectName(trimmedPath),
    monitored: enabled,
    monitorUpdatedAt: now,
  };

  registry.agents[projectId] = next;
  await saveRegistry(registry);
  return next;
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
