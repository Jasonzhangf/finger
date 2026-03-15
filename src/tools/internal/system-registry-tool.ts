/**
 * System Registry Tool
 *
 * 管理 System Agent 的 Agent 注册表
 * 仅 System Agent 可用 (policy: 'allow')
 */

import type { ToolRegistry } from '../../../runtime/tool-registry.js';
import type { AgentRuntimeDeps } from '../../../server/modules/agent-runtime/types.js';
import * as registry from '../../agents/finger-system-agent/registry.js';
import type { AgentStatus } from '../../agents/finger-system-agent/registry.js';

export interface RegistryToolInput {
  action: 'register' | 'unregister' | 'update' | 'list' | 'get_status' | 'heartbeat' | 'cleanup' | 'monitor';
  projectId?: string;
  projectPath?: string;
  projectName?: string;
  agentId?: string;
  status?: AgentStatus;
  monitored?: boolean;
  updates?: Partial<registry.AgentInfo>;
  timeoutMs?: number;
}

export interface RegistryToolOutput {
  ok: boolean;
  action: string;
  agent?: registry.AgentInfo;
  agents?: registry.AgentInfo[];
  error?: string;
}

/**
 * 注册 system-registry-tool 到工具注册表
 */
export function registerSystemRegistryTool(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps
): void {
  toolRegistry.register({
    name: 'system-registry-tool',
    description: '管理 System Agent 的 Agent 注册表（仅 System Agent 可用）',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['register', 'unregister', 'update', 'list', 'get_status', 'heartbeat', 'cleanup', 'monitor'],
          description: '操作类型'
        },
        projectId: { type: 'string', description: '项目 ID' },
        projectPath: { type: 'string', description: '项目路径' },
        projectName: { type: 'string', description: '项目名称' },
        agentId: { type: 'string', description: 'Agent ID' },
        status: { type: 'string', enum: ['idle', 'busy', 'stopped', 'crashed'], description: 'Agent 状态' },
        monitored: { type: 'boolean', description: '是否系统监控' },
        updates: { type: 'object', description: '更新内容' },
        timeoutMs: { type: 'number', description: '超时时间（毫秒）' },
      },
      required: ['action'],
    },
    policy: 'allow', // 仅 System Agent 可用
    handler: async (input: unknown): Promise<RegistryToolOutput> => {
      const params = input as RegistryToolInput;

      try {
        switch (params.action) {
          case 'register': {
            if (!params.projectId || !params.projectPath || !params.agentId) {
              return {
                ok: false,
                action: 'register',
                error: 'projectId, projectPath, and agentId are required for register action',
              };
            }

            await registry.registerAgent({
              projectId: params.projectId,
              projectPath: params.projectPath,
              projectName: params.projectName || params.projectId,
              agentId: params.agentId,
              status: params.status || 'idle',
              lastHeartbeat: new Date().toISOString(),
              stats: {
                tasksCompleted: 0,
                tasksFailed: 0,
                uptime: 0,
              },
            });

            const agent = await registry.getAgentStatus(params.projectId);
            return {
              ok: true,
              action: 'register',
              agent: agent || undefined,
            };
          }

          case 'unregister': {
            if (!params.projectId) {
              return {
                ok: false,
                action: 'unregister',
                error: 'projectId is required for unregister action',
              };
            }

            await registry.unregisterAgent(params.projectId);
            return {
              ok: true,
              action: 'unregister',
            };
          }

          case 'update': {
            if (!params.projectId) {
              return {
                ok: false,
                action: 'update',
                error: 'projectId is required for update action',
              };
            }

            await registry.updateAgent(params.projectId, params.updates || {});
            const agent = await registry.getAgentStatus(params.projectId);
            return {
              ok: true,
              action: 'update',
              agent: agent || undefined,
            };
          }

          case 'list': {
            const agents = await registry.listAgents();
            return {
              ok: true,
              action: 'list',
              agents,
            };
          }

          case 'get_status': {
            if (!params.projectId) {
              return {
                ok: false,
                action: 'get_status',
                error: 'projectId is required for get_status action',
              };
            }

            const agent = await registry.getAgentStatus(params.projectId);
            if (!agent) {
              return {
                ok: false,
                action: 'get_status',
                error: `Agent not found: ${params.projectId}`,
              };
            }

            return {
              ok: true,
              action: 'get_status',
              agent,
            };
          }

          case 'heartbeat': {
            if (!params.projectId) {
              return {
                ok: false,
                action: 'heartbeat',
                error: 'projectId is required for heartbeat action',
              };
            }

            await registry.updateHeartbeat(params.projectId);
            return {
              ok: true,
              action: 'heartbeat',
            };
          }

          case 'cleanup': {
            await registry.cleanupStaleAgents(params.timeoutMs);
            return {
              ok: true,
              action: 'cleanup',
            };
          }

          case 'monitor': {
            if (!params.projectPath || typeof params.monitored !== 'boolean') {
              return {
                ok: false,
                action: 'monitor',
                error: 'projectPath and monitored are required for monitor action',
              };
            }
            const agent = await registry.setMonitorStatus(params.projectPath, params.monitored);
            return {
              ok: true,
              action: 'monitor',
              agent,
            };
          }

          default:
            return {
              ok: false,
              action: params.action,
              error: `Unknown action: ${params.action}`,
            };
        }
      } catch (error) {
        return {
          ok: false,
          action: params.action,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  });
}
