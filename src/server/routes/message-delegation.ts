/**
 * Message Delegation Helper
 *
 * Handles forced system route delegation to project orchestrator
 * when a project path is detected in the message content.
 */

import path from 'path';
import { isObjectRecord } from '../common/object.js';
import { logger } from '../../core/logger.js';
import { extractMessageTextForSession } from '../modules/message-session.js';
import { withMessageContent } from './message-helpers.js';
import type { MessageRouteDeps } from './message-types.js';

interface DelegationResult {
  updatedMessage: unknown;
  updatedTarget?: string;
}

/**
 * Detects project paths in system route messages and delegates to project orchestrator.
 * Returns updated message and optional target override.
 */
export async function handleSystemRouteDelegation(
  isSystemRoute: boolean,
  requestMessage: unknown,
  bodyTarget: string,
  deps: MessageRouteDeps,
): Promise<DelegationResult> {
  if (!isSystemRoute) return { updatedMessage: requestMessage };

  const content = extractMessageTextForSession(requestMessage) ?? '';
  const pathMatch = content.match(/(\/(Volumes|Users)\/[^\s]+|~\/[\w\-./]+)/);
  if (!pathMatch) return { updatedMessage: requestMessage };

  const projectPathHint = pathMatch[0];
  const delegationPrefix = `【系统强制委派】检测到项目路径：${projectPathHint}\n` +
    '必须执行：\n' +
    '1) system-registry-tool action=list 查找项目\n' +
    '2) 若未注册，project_tool action=create 使用绝对路径\n' +
    '3) agent.dispatch -> finger-orchestrator，使用返回的 sessionId\n' +
    '禁止执行开机检查/周期性检查，仅处理本用户任务。\n\n';

  let updatedMessage = withMessageContent(requestMessage, delegationPrefix + content);
  let updatedTarget: string | undefined;

  try {
    const registryTool = deps.toolRegistry.get('system-registry-tool');
    const projectTool = deps.toolRegistry.get('project_tool');
    if (registryTool && projectTool) {
      const homeDir = process.env.HOME || '';
      const resolvedPath = projectPathHint.startsWith('~/')
        ? path.join(homeDir, projectPathHint.slice(2))
        : projectPathHint;
      const normalizedPath = path.resolve(resolvedPath);

      const listResult = await deps.toolRegistry.execute('system-registry-tool', { action: 'list' }) as any;
      const agents = Array.isArray(listResult?.agents) ? listResult.agents : [];
      const matched = agents.find((agent: any) => {
        const agentPath = typeof agent?.projectPath === 'string' ? agent.projectPath : '';
        return agentPath && path.resolve(agentPath) === normalizedPath;
      });

      let projectSessionId: string | undefined;
      if (!matched) {
        const createResult = await deps.toolRegistry.execute('project_tool', {
          action: 'create',
          projectPath: normalizedPath,
        }) as any;
        if (typeof createResult?.sessionId === 'string') {
          projectSessionId = createResult.sessionId;
        }
      }

      if (!projectSessionId) {
        const sessions = deps.sessionManager.findSessionsByProjectPath(normalizedPath);
        sessions.sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime());
        projectSessionId = sessions[0]?.id;
      }

      if (projectSessionId) {
        const systemSessionId = deps.sessionManager.getOrCreateSystemSession().id;
        deps.sessionManager.addMessage(systemSessionId, 'system', `已委派 Project Agent 处理：${normalizedPath}\nsessionId: ${projectSessionId}`);

        if (isObjectRecord(updatedMessage)) {
          const metadata = isObjectRecord(updatedMessage.metadata) ? updatedMessage.metadata : {};
          updatedMessage = {
            ...updatedMessage,
            sessionId: projectSessionId,
            metadata: {
              ...metadata,
              delegatedBy: 'system-agent',
              projectPath: normalizedPath,
            },
          };
        }
        updatedTarget = 'finger-orchestrator';
      }
    }
  } catch (error) {
    logger.module('message-delegation').error('Forced project delegation failed', error instanceof Error ? error : undefined);
  }

  return { updatedMessage: updatedMessage, updatedTarget };
}
