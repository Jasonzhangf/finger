import { logger } from '../../core/logger.js';
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
import * as fs from 'fs';
import * as path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { normalizeProjectPathCanonical } from '../../common/path-normalize.js';

/**
 * 解析指定项目的最新 session
 */
function resolveLatestSession(sessionManager: SessionManager, projectPath: string): Session | null {
  const normalizedProjectPath = normalizeProjectPathCanonical(projectPath);
  const sessions = sessionManager.listSessions().filter(
    (s) => normalizeProjectPathCanonical(s.projectPath) === normalizedProjectPath,
  );
  if (sessions.length === 0) return null;

  const sorted = sessions.sort((a, b) =>
    new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
  );
  return sorted[0];
}

function summarizeMessage(content: string, maxChars = 100): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
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
  const snapshot = session ? sessionManager.getSessionMessageSnapshot(session.id, 0) : null;
  await eventBus.emit({
    type: 'session_changed',
    sessionId,
    timestamp: new Date().toISOString(),
    payload: {
      projectPath: session?.projectPath,
      messageCount: snapshot?.messageCount ?? 0,
    },
  });
}

/**
 * <##@cmd:list##> - 列出所有可用命令
 */
export async function handleCmdList(): Promise<string> {
  return `可用命令：
  <##@system##>                    - 切换到系统代理（project=~/.finger，最新 session）
  <##@system:progress:mode@dev##>  - 切换进度上下文显示为 DEV（详细分解）
  <##@system:progress:mode@release##> - 切换进度上下文显示为 RELEASE（精简）
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
  const normalizedResolvedPath = normalizeProjectPathCanonical(resolvedPath);

  const sessions = sessionManager.listSessions().filter(
    (s) => normalizeProjectPathCanonical(s.projectPath) === normalizedResolvedPath,
  );
  const sorted = sessions.slice().sort((a, b) =>
    new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
  );

  if (sorted.length === 0) {
    return `项目：${resolvedPath}\n\n该项目中没有会话。\n使用 <##@agent:new@${resolvedPath}##> 创建新会话。`;
  }

  const currentId = sessionManager.getCurrentSession()?.id;
  const lines = [`项目：${resolvedPath}\n会话列表：\n`];
  sorted.forEach((s, i) => {
    const snapshot = sessionManager.getSessionMessageSnapshot(s.id, 1);
    const lastMsg = snapshot.previewMessages[0];
    const summary = lastMsg ? summarizeMessage(lastMsg.content, 100) : '(空)';
    const date = new Date(s.lastAccessedAt).toLocaleString('zh-CN');
    const isCurrent = s.id === currentId ? ' [当前]' : '';
    lines.push(`  ${i + 1}. [${s.id}]${isCurrent} ${date} - "${summary}" (${snapshot.messageCount} 条消息)`);
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

  const messageCount = sessionManager.getSessionMessageSnapshot(session.id, 0).messageCount;
  return `✓ 已切换到会话：[${sessionId}]\n项目路径：${session.projectPath}\n\n加载会话历史... (${messageCount} 条消息)\n继续对话...`;
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

  const normalizedSystemProject = normalizeProjectPathCanonical(systemProject);
  const systemSessions = sessionManager.listSessions()
    .filter((s) => normalizeProjectPathCanonical(s.projectPath) === normalizedSystemProject)
    .sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime())
    .slice(0, 3);

  const lines = [
    `系统目录：${systemProject}`,
    ``,
    `最近 3 条 System Agent 会话：`,
  ];

  systemSessions.forEach((s, i) => {
    const snapshot = sessionManager.getSessionMessageSnapshot(s.id, 1);
    const lastMsg = snapshot.previewMessages[0];
    const summary = lastMsg ? summarizeMessage(lastMsg.content, 100) : '(空)';
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

  const messageCount = sessionManager.getSessionMessageSnapshot(session.id, 0).messageCount;
  return `✓ 已切换到项目：${resolvedPath}\n\n当前会话：[${session.id}]\n${messageCount} 条消息\n\n继续对话...`;
}

/**
 * Load provider config from ~/.finger/config/config.json
 */
function loadProviderConfig(): { providers: Record<string, any>; current: string | null } {
  const configPath = path.join(FINGER_PATHS.config.dir, 'config.json');
  try {
    if (!fs.existsSync(configPath)) {
      return { providers: {}, current: null };
    }
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as any;
    const kernel = config?.kernel || {};
    return {
      providers: kernel.providers || {},
      current: kernel.provider || null,
    };
  } catch {
    return { providers: {}, current: null };
  }
}

/**
 * Save provider config to ~/.finger/config/config.json
 */
function saveProviderConfig(providerId: string): boolean {
  const configPath = path.join(FINGER_PATHS.config.dir, 'config.json');
  try {
    let config: any = {};
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(content);
    }
    if (!config.kernel) config.kernel = {};
    config.kernel.provider = providerId;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (err) {
    logger.module('messagehub-command-handler').error('Failed to save provider config', err instanceof Error ? err : undefined);
    return false;
  }
}

/**
 * <##@system:progress:mode@dev|release##>
 */
export async function handleSystemProgressMode(modeRaw: string): Promise<string> {
  const mode = modeRaw.trim().toLowerCase();
  if (mode !== 'dev' && mode !== 'release') {
    return '❌ 无效模式。请使用：<##@system:progress:mode@dev##> 或 <##@system:progress:mode@release##>';
  }

  const configPath = path.join(FINGER_PATHS.config.dir, 'progress-monitor.json');
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      existing = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
    }
    const next = {
      ...existing,
      contextBreakdownMode: mode,
    };
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf-8');
    return mode === 'dev'
      ? '✓ 已切换进度上下文模式为 DEV（详细分解）'
      : '✓ 已切换进度上下文模式为 RELEASE（精简视图）';
  } catch (error) {
    return `❌ 设置失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * <##@system:provider:list##> - List all AI providers
 */
export async function handleProviderList(): Promise<string> {
  const { providers, current } = loadProviderConfig();
  const lines = ['可用 AI Provider：\n'];

  Object.entries(providers).forEach(([id, cfg]: [string, any]) => {
    const isCurrent = id === current;
    const marker = isCurrent ? ' [当前]' : '';
    const baseUrl = cfg?.base_url || 'unknown';
    const model = cfg?.model || 'unknown';
    lines.push(`  - ${id}${marker}: ${model} @ ${baseUrl}`);
  });

  lines.push('\n使用 <##@system:provider:switch@id##> 切换 provider');
  return lines.join('\n');
}

/**
 * <##@system:provider:switch@id##> - Switch AI provider
 */
export async function handleProviderSwitch(providerId: string): Promise<string> {
  const { providers } = loadProviderConfig();

  if (!providers[providerId]) {
    return `❌ Provider 不存在：${providerId}\n\n使用 <##@system:provider:list##> 查看可用 providers`;
  }

  const success = saveProviderConfig(providerId);
  if (!success) {
    return `❌ 切换失败：无法保存配置`;
  }

  const cfg = providers[providerId];
  return `✓ 已切换到 provider：${providerId}\n  Model: ${cfg?.model || 'unknown'}\n  URL: ${cfg?.base_url || 'unknown'}\n\n重启 agent 后生效`;
}
