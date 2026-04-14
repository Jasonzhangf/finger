/**
 * team.status Internal Tool
 * Query and update shared team agent status
 */

import { InternalTool, ToolExecutionContext } from './types.js';
import { InternalToolRegistry } from './registry.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import {
  loadTeamStatusStore,
  filterTeamStatusByScope,
  updateTeamAgentStatus,
  AgentRole,
  TeamAgentStatus,
  PlanSummary,
} from '../../common/team-status-state.js';
import { logger } from '../../core/logger.js';

const log = logger.module('team-status-tool');

export interface TeamStatusToolInput {
  action: 'status' | 'update';
  agentId?: string;
  planSummary?: {
    total: number;
    completed: number;
    inProgress: number;
    blocked: number;
    currentStep?: string;
  };
}

export interface TeamStatusToolOutput {
  ok: boolean;
  action: 'status' | 'update';
  scope: 'system' | 'project';
  viewerAgentId: string;
  agents?: TeamAgentStatus[];
  self?: TeamAgentStatus;
  error?: string;
}

/**
 * team.status tool
 * - status: 查询可见范围内的 team status
 * - update: 更新自己的 planSummary（需校验 agentId === context.agentId）
 */
export const teamStatusTool: InternalTool<TeamStatusToolInput, TeamStatusToolOutput> = {
  name: 'team.status',
  description: 'Query or update team agent status. System agents see all; project agents see scope.',
  executionModel: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'update'] },
      agentId: { type: 'string' },
      planSummary: {
        type: 'object',
        properties: {
          total: { type: 'number' },
          completed: { type: 'number' },
          inProgress: { type: 'number' },
          blocked: { type: 'number' },
          currentStep: { type: 'string' },
        },
      },
    },
    required: ['action'],
  },

  async execute(
    input: TeamStatusToolInput,
    context: ToolExecutionContext
  ): Promise<TeamStatusToolOutput> {
    const viewerAgentId = context.agentId || 'unknown';
    const viewerProjectPath = context.cwd || '';
    const viewerRole: AgentRole = context.agentId === 'finger-system-agent' ? 'system' : 'project';

    log.info('[team.status] Tool called', {
      action: input.action,
      viewerAgentId,
      viewerRole,
      viewerProjectPath,
    });

    if (input.action === 'update') {
      return executeUpdate(input, context, viewerAgentId, viewerProjectPath);
    }

    // action === 'status'
    return executeStatus(viewerAgentId, viewerProjectPath, viewerRole);
  },
};

/**
 * status action: 查询可见范围内的 team status
 */
function executeStatus(
  viewerAgentId: string,
  viewerProjectPath: string,
  viewerRole: AgentRole,
): TeamStatusToolOutput {
  const store = loadTeamStatusStore();
  const agents = filterTeamStatusByScope(
    store,
    viewerAgentId,
    viewerProjectPath,
    viewerRole,
  );

  log.debug('[team.status/status] Returned agents', {
    count: agents.length,
    viewerRole,
  });

  return {
    ok: true,
    action: 'status',
    scope: viewerRole,
    viewerAgentId,
    agents,
  };
}

/**
 * update action: 更新自己的 planSummary
 * 权限校验：input.agentId 必须等于 context.agentId
 */
function executeUpdate(
  input: TeamStatusToolInput,
  _context: ToolExecutionContext,
  viewerAgentId: string,
  viewerProjectPath: string
): TeamStatusToolOutput {
  // 权限校验：只能更新自己
  const targetAgentId = input.agentId || viewerAgentId;
  if (targetAgentId !== viewerAgentId) {
    log.warn('[team.status/update] Permission denied', {
      targetAgentId,
      viewerAgentId,
    });
    return {
      ok: false,
      action: 'update',
      scope: 'project',
      viewerAgentId,
      error: 'permission_denied: can only update own status',
    };
  }

  if (!input.planSummary) {
    return {
      ok: false,
      action: 'update',
      scope: 'project',
      viewerAgentId,
      error: 'missing planSummary in update request',
    };
  }

  const planSummary: PlanSummary = {
    ...input.planSummary,
    updatedAt: new Date().toISOString(),
  };

  const updated = updateTeamAgentStatus(viewerAgentId, {
    agentId: viewerAgentId,
    projectPath: viewerProjectPath,
    planSummary,
  });

  log.info('[team.status/update] Status updated', {
    agentId: viewerAgentId,
    planTotal: planSummary.total,
    planCompleted: planSummary.completed,
  });

  return {
    ok: true,
    action: 'update',
    scope: 'project',
    viewerAgentId,
    self: updated,
  };
}

/**
 * Tool info for registration
 */
export const teamStatusToolInfo = {
  name: 'team.status',
  description: teamStatusTool.description,
  executionModel: teamStatusTool.executionModel,
  inputSchema: teamStatusTool.inputSchema,
};

/**
 * 注册 team.status 工具到 ToolRegistry
 */
export function registerTeamStatusTool(toolRegistry: ToolRegistry): void {
  toolRegistry.register({
    name: teamStatusTool.name,
    description: teamStatusTool.description,
    inputSchema: teamStatusTool.inputSchema,
    policy: 'allow',
    handler: async (input: unknown): Promise<TeamStatusToolOutput> => {
      const registry = new InternalToolRegistry();
      registry.register(teamStatusTool as InternalTool<unknown, unknown>);
      return registry.execute(teamStatusTool.name, input) as Promise<TeamStatusToolOutput>;
    },
  });
}
