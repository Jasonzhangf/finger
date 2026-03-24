/**
 * Project Tool - 创建新项目并分派编排者 agent
 * 
 * 专为 System Agent 设计，确保跨项目操作通过分派而非直接操作
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import type { ToolRegistry } from '../../../runtime/tool-registry.js';
import type { AgentRuntimeDeps } from '../../../server/modules/agent-runtime/types.js';

export interface ProjectToolInput {
  action: 'create';
  projectPath: string;
  projectName?: string;
  description?: string;
}

export interface ProjectToolOutput {
  ok: boolean;
  action: string;
  projectId?: string;
  sessionId?: string;
  dispatchId?: string;
  orchestratorAgentId?: string;
  error?: string;
}

/**
 * 注册 project_tool 到工具注册表
 */
export function registerProjectTool(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps
): void {
  toolRegistry.register({
    name: 'project_tool',
    description: '创建新项目并自动分派编排者 agent (仅 System Agent 可用)',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create'],
          description: '操作类型'
        },
        projectPath: {
          type: 'string',
          description: '项目路径（绝对路径）'
        },
        projectName: {
          type: 'string',
          description: '项目名称（可选，默认使用目录名）'
        },
        description: {
          type: 'string',
          description: '项目描述（可选）'
        }
      },
      required: ['action', 'projectPath']
    },
    policy: 'allow',
    handler: async (input: unknown) => {
      const params = input as ProjectToolInput;
      const deps = getAgentRuntimeDeps();

      if (params.action !== 'create') {
        return { ok: false, action: params.action, error: 'Unsupported action' };
      }

      const normalizedPath = path.resolve(params.projectPath);
      const projectName = params.projectName || path.basename(normalizedPath);

      try {
        // 1. 创建项目目录
        await fs.mkdir(normalizedPath, { recursive: true });

        // 2. 初始化 MEMORY.md
        const memoryPath = path.join(normalizedPath, 'MEMORY.md');
        const timestamp = new Date().toISOString();
        const memoryContent = `# ${projectName} 项目记忆\n\n项目创建时间: ${timestamp}\n项目路径: ${normalizedPath}\n\nTags: project\n\n---\n`;
        await fs.writeFile(memoryPath, memoryContent);

        // 3. 创建 session
        const session = deps.sessionManager.createSession(normalizedPath, projectName);

        // 4. 分派编排者 agent（如果 dispatchTaskToAgent 可用）
        let dispatchId: string | undefined;
        if (deps.dispatchTaskToAgent) {
          const dispatchRequest = {
            sourceAgentId: 'finger-system-agent',
            targetAgentId: 'finger-project-agent',
            task: {
              prompt: `项目已创建：${projectName}\n路径：${normalizedPath}\n${params.description || ''}`,
            },
            sessionId: session.id,
            metadata: {
              source: 'system',
              role: 'system',
              projectCreated: true,
            },
            blocking: false,
          };
          const result = await deps.dispatchTaskToAgent(deps, dispatchRequest);
          dispatchId = result.dispatchId;
        }

        return {
          ok: true,
          action: 'create',
          projectId: normalizedPath,
          sessionId: session.id,
          dispatchId,
          orchestratorAgentId: 'finger-project-agent',
        };
      } catch (err) {
        return {
          ok: false,
          action: 'create',
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }
  });
}
