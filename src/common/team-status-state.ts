/**
 * Team Status Shared State
 * 
 * Shared agent status across system and project agents.
 * Unique truth source: ~/.finger/system/team-status.json
 */

import { readFileSync } from 'fs';
import { existsSync } from 'fs';
import { writeFileAtomicSync } from '../core/atomic-write.js';
import { FINGER_HOME } from '../core/finger-paths.js';
import { join } from 'path';
import { logger } from '../core/logger.js';

const log = logger.module('team-status-state');

// === Types ===

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
  workerId?: string;  // 区分同一 agent 的不同执行实例
  sessionId?: string; // 当前活跃的 session
  projectId?: string;
  projectPath: string;
  role: AgentRole;
  dispatchScopeKey?: string; // 用于更精确的 scope 过滤
  
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

// === Constants ===

const TEAM_STATUS_FILE = join(FINGER_HOME, 'system', 'team-status.json');
const DEFAULT_RUNTIME_STATUS: RuntimeStatus = 'idle';

// === Load & Save ===

export function loadTeamStatusStore(): TeamStatusStore {
  try {
    if (!existsSync(TEAM_STATUS_FILE)) {
      return {
        version: 1,
        lastUpdate: new Date().toISOString(),
        agents: {},
      };
    }
    const content = readFileSync(TEAM_STATUS_FILE, 'utf-8');
    const data = JSON.parse(content) as TeamStatusStore;
    return data;
  } catch (error) {
    log.warn('[loadTeamStatusStore] Failed to load, returning empty store', { error });
    return {
      version: 1,
      lastUpdate: new Date().toISOString(),
      agents: {},
    };
  }
}

export function saveTeamStatusStore(store: TeamStatusStore): void {
  try {
    store.lastUpdate = new Date().toISOString();
    writeFileAtomicSync(TEAM_STATUS_FILE, JSON.stringify(store, null, 2));
    log.debug('[saveTeamStatusStore] Saved', { agentCount: Object.keys(store.agents).length });
  } catch (error) {
    log.error('[saveTeamStatusStore] Failed to save', error as Error);
  }
}

// === Update Functions ===

export interface UpdateTeamAgentStatusInput {
  agentId: string;
  projectPath: string;
  workerId?: string;
  sessionId?: string;
  projectId?: string;
  dispatchScopeKey?: string;
  role?: AgentRole;
  planSummary?: PlanSummary;
}

export function updateTeamAgentStatus(
  agentId: string,
  input: UpdateTeamAgentStatusInput
): TeamAgentStatus {
  const store = loadTeamStatusStore();
  
  const existing = store.agents[agentId] || {
    agentId,
    projectPath: input.projectPath,
    role: inferRole(agentId),
    runtimeStatus: DEFAULT_RUNTIME_STATUS,
    updatedAt: new Date().toISOString(),
  };
  
  const updated: TeamAgentStatus = {
    ...existing,
    projectPath: input.projectPath,
    workerId: input.workerId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    dispatchScopeKey: input.dispatchScopeKey,
    role: input.role || existing.role,
    updatedAt: new Date().toISOString(),
  };
  
  // Only update planSummary if provided
  if (input.planSummary) {
    updated.planSummary = input.planSummary;
  }
  
  store.agents[agentId] = updated;
  saveTeamStatusStore(store);
  
  log.info('[updateTeamAgentStatus] Updated', { agentId, runtimeStatus: updated.runtimeStatus });
  return updated;
}

export interface UpdateRuntimeStatusInput {
  agentId: string;
  runtimeStatus: RuntimeStatus;
  lastDispatchId?: string;
  lastTaskId?: string;
  lastTaskName?: string;
}

export function updateRuntimeStatus(input: UpdateRuntimeStatusInput): TeamAgentStatus | null {
  const store = loadTeamStatusStore();
  const existing = store.agents[input.agentId];
  
  if (!existing) {
    log.warn('[updateRuntimeStatus] Agent not found', { agentId: input.agentId });
    return null;
  }
  
  existing.runtimeStatus = input.runtimeStatus;
  existing.lastDispatchId = input.lastDispatchId;
  existing.lastTaskId = input.lastTaskId;
  existing.lastTaskName = input.lastTaskName;
  existing.updatedAt = new Date().toISOString();
  
  saveTeamStatusStore(store);
  log.info('[updateRuntimeStatus] Updated', { agentId: input.agentId, runtimeStatus: input.runtimeStatus });
  return existing;
}

export function removeTeamAgentStatus(agentId: string): boolean {
  const store = loadTeamStatusStore();
  if (!store.agents[agentId]) {
    return false;
  }
  delete store.agents[agentId];
  saveTeamStatusStore(store);
  log.info('[removeTeamAgentStatus] Removed', { agentId });
  return true;
}

// === Scope Filtering ===

export function filterTeamStatusByScope(
  store: TeamStatusStore,
  viewerAgentId: string,
  viewerProjectPath: string,
  viewerRole: AgentRole,
  viewerScopeKey?: string
): TeamAgentStatus[] {
  const allAgents = Object.values(store.agents);
  
  if (viewerRole === 'system') {
    // System Agent sees all
    return allAgents;
  }
  
  // Project Agent:
  // 1. See same-project + same-scope peers
  // 2. See System Agent's runtimeStatus only (no task/plan details)
  return allAgents
    .filter(agent => {
      // System Agent always visible
      if (agent.role === 'system') {
        return true;
      }
      // Same project
      if (agent.projectPath !== viewerProjectPath) {
        return false;
      }
      // Scope match (if applicable)
      if (viewerScopeKey && agent.dispatchScopeKey && agent.dispatchScopeKey !== viewerScopeKey) {
        return false;
      }
      return true;
    })
    .map(agent => {
      // For System Agent, only return runtimeStatus
      if (agent.role === 'system') {
        return {
          agentId: agent.agentId,
          role: agent.role,
          runtimeStatus: agent.runtimeStatus,
          updatedAt: agent.updatedAt,
        } as TeamAgentStatus;
      }
      return agent;
    });
}

// === Helpers ===

function inferRole(agentId: string): AgentRole {
  if (agentId === 'finger-system-agent' || agentId.startsWith('system-')) {
    return 'system';
  }
  return 'project';
}

// === Sync from Plan ===

export function syncTeamStatusFromPlan(
  agentId: string,
  projectPath: string,
  workerId: string | undefined,
  planSummary: PlanSummary
): void {
  updateTeamAgentStatus(agentId, {
    agentId,
    projectPath,
    workerId,
    planSummary,
  });
  log.info('[syncTeamStatusFromPlan] Synced', { agentId, total: planSummary.total, completed: planSummary.completed });
}
