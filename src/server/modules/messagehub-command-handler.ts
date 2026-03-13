/**
 * MessageHub Command Handler
 *
 * 处理所有超级命令的业务逻辑
 */

import type { SessionManager, Session } from '../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import {
  loadFingerConfig,
  resolveHomePath,
  resolveDefaultProject,
  type FingerConfig,
} from '../../core/config/channel-config.js';

/**
 * 解析指定项目的最新 session
 */
function resolveLatestSession(sessionManager: SessionManager, projectPath: string): Session | null {
  const sessions = sessionManager.listSessions().filter(s => s.projectPath === projectPath);
  if (sessions.length === 0) return null;

  const sorted = sessions.sort((a, b) =>
    new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
  );
  return sorted[0];
}

/**
 * 辅助函数：触发 session_changed 事件
 */
async function emitSessionChanged(
  sessionManager: SessionManager,
  sessionId: string,
  eventBus?: UnifiedEventBus
): Promise<void> {
  if (!eventBus) return;
  const session = sessionManager.getSession(sessionId);
  await eventBus.emit({
    type: 'session_changed',
    sessionId,
    timestamp: new Date().toISOString(),
    payload: {
      projectPath: session?.projectPath,
      messageCount: session?.messages.length ?? 0,
    },
  });
}

/**
 * <##@cmd:list##> - 列出所有可用命令
 */
export async function handleCmdList(): Promise<string> {
  return `可用命令：
  <##@system##>                    - 切换到系统代理（project=~/.finger，最新 session）
  <##@agent:list##>                 - 列出当前项目的会话
  <##@agent:list@/path/to/proj##>   - 列出指定项目的会话
  <##@agent:new##>                  - 在当前项目创建新会话
  <##@agent:new@/path/to/proj##>    - 在指定项目创建新会话
  <##@agent:switch@session-id##>   - 切换到指定会话
  <##@agent:delete@session-id##>   - 删除会话
  <##@project:list##>              - 列出所有项目
  <##@project:switch@/path##>      - 切换项目路径（使用最新 session）
  /resume                           - 列出当前项目会话（等同 <##@agent:list##>）
  /resume session-id                - 直接切换会话（等同 <##@agent:switch@...##>）
  <##@cmd:list##>                  - 显示此帮助`;
}

/**
 * <##@agent:list##> 或 <##@agent:list@/path##>
 */
export async function handleAgentList(
  sessionManager: SessionManager,
  projectPath?: string
): Promise<string> {
  const config = await loadFingerConfig();
  const resolvedPath = projectPath
    ? resolveHomePath(projectPath)
    : resolveDefaultProject(config, sessionManager.getCurrentSession()?.projectPath || null);

  const sessions = sessionManager.listSessions().filter(s => s.projectPath === resolvedPath);
  const sorted = sessions.slice().sort((a, b) =>
    new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
  );

  if (sorted.length === 0) {
    return `项目：${resolvedPath}\n\n该项目中没有会话。\n使用 <##@agent:new@${resolvedPath}##> 创建新会话。`;
  }

  const currentId = sessionManager.getCurrentSession()?.id;
  const lines = [`项目：${resolvedPath}\n会话列表：\n`];
  sorted.forEach((s, i) => {
    const lastMsg = s.messages[s.messages.length - 1];
    const summary = lastMsg ? lastMsg.content.substring(0, 100) : '(空)';
    const date = new Date(s.lastAccessedAt).toLocaleString('zh-CN');
    const isCurrent = s.id === currentId ? ' [当前]' : '';
    lines.push(`  ${i + 1}. [${s.id}]${isCurrent} ${date} - "${summary}" (${s.messages.length} 条消息)`);
  });

  lines.push('\n使用 <##@agent:switch@session-id##> 切换会话');
  return lines.join('\n');
}

/**
 * <##@agent:new##> 或 <##@agent:new@/path##>
 */
export async function handleAgentNew(
  sessionManager: SessionManager,
  projectPath?: string,
  eventBus?: UnifiedEventBus
): Promise<string> {
  const config = await loadFingerConfig();
  const resolvedPath = projectPath
    ? resolveHomePath(projectPath)
    : resolveDefaultProject(config, sessionManager.getCurrentSession()?.projectPath || null);

  const session = sessionManager.createSession(resolvedPath);
  sessionManager.setCurrentSession(session.id);
  await emitSessionChanged(sessionManager, session.id, eventBus);

  return `✓ 已创建新会话：[${session.id}]\n项目路径：${resolvedPath}\n\n开始新对话...`;
}

/**
 * <##@agent:switch@session-id##>
 */
export async function handleAgentSwitch(
  sessionManager: SessionManager,
  sessionId: string,
  eventBus?: UnifiedEventBus
): Promise<string> {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return `❌ 会话不存在：[${sessionId}]`;
  }

  const success = sessionManager.setCurrentSession(sessionId);
  if (!success) {
    return `❌ 切换失败：[${sessionId}]`;
  }

  await emitSessionChanged(sessionManager, sessionId, eventBus);

  const messageCount = session.messages.length;
  return `✓ 已切换到会话：[${sessionId}]\n项目路径：${session.projectPath}\n\n加载会话历史... (${messageCount} ��消息)\n继续对话...`;
}

/**
 * <##@agent:delete@session-id##>
 */
export async function handleAgentDelete(
  sessionManager: SessionManager,
  sessionId: string,
  eventBus?: UnifiedEventBus
): Promise<string> {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return `❌ 会话不存在：[${sessionId}]`;
  }

  const isCurrent = session.id === sessionManager.getCurrentSession()?.id;
  const projectPath = session.projectPath;

  const deleted = sessionManager.deleteSession(sessionId);
  if (!deleted) {
    return `❌ 删除失败：[${sessionId}]`;
  }

  if (isCurrent && projectPath) {
    const latestSession = resolveLatestSession(sessionManager, projectPath);
    if (latestSession) {
      sessionManager.setCurrentSession(latestSession.id);
      await emitSessionChanged(sessionManager, latestSession.id, eventBus);
      return `✓ 已删除会话：[${sessionId}]\n\n已切换到：[${latestSession.id}]`;
    }
  }

  return `✓ 已删除会话：[${sessionId}]`;
}

/**
 * <##@system##>
 */
export async function handleSystemCommand(
  sessionManager: SessionManager,
  eventBus?: UnifiedEventBus
): Promise<string> {
  const systemProject = resolveHomePath('~/.finger');
  let session = resolveLatestSession(sessionManager, systemProject);

  if (!session) {
    session = sessionManager.createSession(systemProject, 'system-main');
  }

  sessionManager.setCurrentSession(session.id);
  await emitSessionChanged(sessionManager, session.id, eventBus);

  const systemSessions = sessionManager.listSessions()
    .filter(s => s.projectPath === systemProject)
    .sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime())
    .slice(0, 3);

  const lines = [
    `系统目录：${systemProject}`,
    ``,
    `最近 3 条 System Agent 会话：`,
  ];

  systemSessions.forEach((s, i) => {
    const lastMsg = s.messages[s.messages.length - 1];
    const summary = lastMsg ? lastMsg.content.substring(0, 100) : '(空)';
    const date = new Date(s.lastAccessedAt).toLocaleString('zh-CN');
    lines.push(`  ${i + 1}. [${s.id}] ${date} - "${summary}"`);
  });

  lines.push(`\n已自动切换到最新会话：[${session.id}]\n\n输入系统命令或问题...`);
  return lines.join('\n');
}

/**
 * <##@project:list##>
 */
export async function handleProjectList(sessionManager: SessionManager): Promise<string> {
  const sessions = sessionManager.listSessions();
  const projectMap = new Map<string, { lastAccess: Date; sessionCount: number }>();

  sessions.forEach(s => {
    if (s.projectPath) {
      const lastAccess = new Date(s.lastAccessedAt);
      const existing = projectMap.get(s.projectPath);
      if (existing) {
        if (lastAccess > existing.lastAccess) {
          projectMap.set(s.projectPath, { lastAccess, sessionCount: existing.sessionCount + 1 });
        } else {
          projectMap.set(s.projectPath, { lastAccess: existing.lastAccess, sessionCount: existing.sessionCount + 1 });
        }
      } else {
        projectMap.set(s.projectPath, { lastAccess, sessionCount: 1 });
      }
    }
  });

  const sortedProjects = Array.from(projectMap.entries())
    .sort((a, b) => b[1].lastAccess.getTime() - a[1].lastAccess.getTime());

  if (sortedProjects.length === 0) {
    return `没有找到任何项目会话。\n使用 <##@agent:new@/path/to/project##> 在指定项目创建会话。`;
  }

  const lines = ['所有项目（按最近访问时间排序）：\n'];
  sortedProjects.forEach(([projectPath, info], i) => {
    lines.push(`  ${i + 1}. ${projectPath} (${info.sessionCount} 个会话)`);
  });

  lines.push('\n使用 <##@project:switch@/path##> 切换项目（自动使用最新 session）');
  return lines.join('\n');
}

/**
 * <##@project:switch@/path##>
 */
export async function handleProjectSwitch(
  sessionManager: SessionManager,
  projectPath: string,
  eventBus?: UnifiedEventBus
): Promise<string> {
  const resolvedPath = resolveHomePath(projectPath);

  let session = resolveLatestSession(sessionManager, resolvedPath);
  if (!session) {
    session = sessionManager.createSession(resolvedPath);
  }

  sessionManager.setCurrentSession(session.id);
  await emitSessionChanged(sessionManager, session.id, eventBus);

  return `✓ 已切换到项目：${resolvedPath}\n\n当前会话：[${session.id}]\n${session.messages.length} 条消息\n\n继续对话...`;
}
