/**
 * Team Status State Management
 * Shared agent status for team coordination
 */

import { existsSync, mkdirSync, readFileSync } from 'fs';
import { FINGER_PATHS } from '../core/finger-paths.js';
import { writeFileAtomicSync } from '../core/atomic-write.js';
import { logger } from '../core/logger.js';

const log = logger.module('team-status-state');
const TEAM_STATUS_VERSION = 1;

export type AgentRole = 'system' | 'project';
export type RuntimeStatus = 'idle' | 'running' | 'queued' | 'waiting_input' | 'paused' | 'failed' | 'stopped';

export interface PlanSummary {
  total: number;
  completed: number;
  inProgress: number;
  blocked: number;
  currentStep?: string;
  updatedAt: string;
}

export interface TaskLifecycle {
  active: boolean;
  status: string;
  taskId?: string;
  updatedAt: string;
}

export interface TeamAgentStatus {
  agentId: string;
  workerId?: string;
  sessionId?: string;
  projectId: string;
  projectPath: string;
  role: AgentRole;
  dispatchScopeKey?: string;

  // Runtime 状态（来自 runtime_view，只由 PeriodicCheckRunner 更新）
  runtimeStatus: RuntimeStatus;
  lastDispatchId?: string;
  lastTaskId?: string;
  lastTaskName?: string;

  // Plan 进度（来自 update_plan，agent 自己更新）
  planSummary?: PlanSummary;

  // Task 生命周期（来自 projectTaskState，只由 PeriodicCheckRunner 更新）
  taskLifecycle?: TaskLifecycle;

  updatedAt: string;
}

export interface TeamStatusStore {
  version: number;
  lastUpdate: string;
  agents: Record<string, TeamAgentStatus>;
}

/**
 * 加载 team status store，损坏时返回空 store
 */
export function loadTeamStatusStore(): TeamStatusStore {
  const file = FINGER_PATHS.system.teamStatusFile;
  try {
    if (!existsSync(file)) {
      log.debug('[loadTeamStatusStore] File not exists, returning empty store');
      return { version: TEAM_STATUS_VERSION, lastUpdate: new Date().toISOString(), agents: {} };
    }
    const raw = readFileSync(file, 'utf-8');
    if (!raw || raw.trim().length === 0) {
      return { version: TEAM_STATUS_VERSION, lastUpdate: new Date().toISOString(), agents: {} };
    }
    const parsed = JSON.parse(raw) as TeamStatusStore;
    if (!parsed.agents || typeof parsed.agents !== 'object') {
      log.warn('[loadTeamStatusStore] Invalid agents field, returning empty store');
      return { version: TEAM_STATUS_VERSION, lastUpdate: new Date().toISOString(), agents: {} };
    }
    return parsed;
  } catch (error) {
    log.warn('[loadTeamStatusStore] Failed to load team status, returning empty store', { error });
    return { version: TEAM_STATUS_VERSION, lastUpdate: new Date().toISOString(), agents: {} };
  }
}

/**
 * 持久化 team status store，使用原子写入避免并发冲突
 */
export function persistTeamStatusStore(store: TeamStatusStore): void {
  const file = FINGER_PATHS.system.teamStatusFile;
  const dir = FINGER_PATHS.system.dir;
  
  mkdirSync(dir, { recursive: true });
  
  store.lastUpdate = new Date().toISOString();
  const content = JSON.stringify(store, null, 2);
  
  writeFileAtomicSync(file, content);
  
  log.debug('[persistTeamStatusStore] Team status persisted', {
    agentCount: Object.keys(store.agents).length,
    file
  });
}

/**
 * Scope 可见性过滤
 * - System Agent 看到全部
 * - Project Agent 看到同 project 内的其他 agents + System Agent 的 runtimeStatus
 */
export function filterTeamStatusByScope(
  store: TeamStatusStore,
  viewerAgentId: string,
  viewerProjectPath: string,
  viewerRole: AgentRole,
  viewerScopeKey?: string
): TeamAgentStatus[] {
  const allAgents = Object.values(store.agents);
  
  if (viewerRole === 'system') {
    // System Agent 看到全部
    return allAgents;
  }
  
  // Project Agent：
  // 1. 看到同 project + 同 scope 内的其他 agents
  // 2. 看到 System Agent 的闲忙状态（只看 runtimeStatus）
  return allAgents.filter(agent => {
    if (agent.role === 'system') {
      return true; // System Agent 总可见
    }
    // 同 project，且 scope 匹配（如果有）
    if (agent.projectPath !== viewerProjectPath) return false;
    if (viewerScopeKey && agent.dispatchScopeKey && agent.dispatchScopeKey !== viewerScopeKey) {
      return false;
    }
    return true;
  }).map(agent => {
    if (agent.role === 'system') {
      // System Agent 只返回 runtimeStatus，不暴露 task/plan 详情
      return {
        agentId: agent.agentId,
        runtimeStatus: agent.runtimeStatus,
        updatedAt: agent.updatedAt,
      } as TeamAgentStatus;
    }
    return agent;
  });
}

/**
 * 更新单个 agent 的 status（合并更新）
 */
export function updateTeamAgentStatus(
  agentId: string,
  updates: Partial<TeamAgentStatus>
): TeamAgentStatus {
  const store = loadTeamStatusStore();
  const now = new Date().toISOString();
  
  const existing = store.agents[agentId] || {
    agentId,
    projectId: '',
    projectPath: '',
    role: 'project' as AgentRole,
    runtimeStatus: 'idle' as RuntimeStatus,
    updatedAt: now,
  };
  
  const updated: TeamAgentStatus = {
    ...existing,
    ...updates,
    updatedAt: now,
  };
  
  store.agents[agentId] = updated;
  persistTeamStatusStore(store);
  
  return updated;
}

/**
 * 同步 planSummary（由 update_plan 调用）
 */
export function syncTeamStatusFromPlan(
  agentId: string,
  projectPath: string,
  workerId: string | undefined,
  planSummary: PlanSummary
): void {
  const store = loadTeamStatusStore();
  const now = new Date().toISOString();
  
  const existing = store.agents[agentId];
  store.agents[agentId] = {
    ...existing,
    agentId,
    projectPath,
    workerId,
    planSummary: {
      ...planSummary,
      updatedAt: now,
    },
    updatedAt: now,
  };
  
  persistTeamStatusStore(store);
}

/**
 * 清理 agent 的 team status 记录（由 unregister 调用）
 */
export function cleanupTeamAgentStatus(agentId: string): void {
  const store = loadTeamStatusStore();
  if (store.agents[agentId]) {
    delete store.agents[agentId];
    persistTeamStatusStore(store);
    log.info('[cleanupTeamAgentStatus] Agent status cleaned', { agentId });
  }
}

/**
 * 获取所有 agent status（用于 PeriodicCheckRunner）
 */
export function getAllTeamAgentStatuses(): TeamAgentStatus[] {
  const store = loadTeamStatusStore();
  return Object.values(store.agents);
}
