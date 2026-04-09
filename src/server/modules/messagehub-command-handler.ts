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
import { normalizeProjectPathCanonical } from '../../common/path-normalize.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import { logger } from '../../core/logger.js';
export { handleDisplayCommand } from './messagehub-display-command.js';
export {
  handleSystemProgressMode,
  handleProviderList,
  handleProviderSwitch,
} from './messagehub-system-config-commands.js';

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
  <##@system:stopall##>            - 强制停止所有 Agent 当前推理（中断所有 active turns）
  <##@system:progress:reset##>     - 重置当前会话的进度监控状态（清除疑似卡住态）
  <##@system:compact##>            - 返回 Rust kernel-owned compact 提示（TS 手动 compact 已移除）
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
  <##display:"show"##>              - 查看当前渠道 display 完整配置
  <##display:"ctx:on|off|simple|verbose"##> - 当前渠道上下文显示复杂度
  <##display:"mode:progress|command|both"##> - 渠道更新模式（进度/命令/两者）
  <##display:"reasoning:on|off"##> - 推理流显示开关
  <##display:"body:on|off"##>      - 正文增量显示开关
  <##display:"status:on|off"##>    - 状态更新显示开关
  <##display:"toolcall:on|off"##>  - 工具调用显示开关
  <##display:"step:on|off"##>      - step 更新显示开关
  <##display:"stepbatch:1-50"##>   - step 批量发送大小
  <##display:"progress:on|off"##>  - 每分钟进度更新显示开关
  <##display:"heartbeat:on|off"##> - 心跳类更新显示开关
  发送微博/小红书链接（QQ/微信）        - 自动触发链接解析与详情流程（channel auto detail）
  /resume                           - 列出当前项目会话（等同 <##@agent:list##>）
  /resume session-id                - 直接切换会话（等同 <##@agent:switch@...##>）
  <##@cmd:list##>                  - 显示此帮助`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

interface RuntimeSessionState {
  sessionId: string;
  providerId?: string;
  hasActiveTurn: boolean;
  activeTurnId?: string;
}

function parseRuntimeSessionsFromControlStatus(raw: unknown): RuntimeSessionState[] {
  const payload = isObjectRecord(raw) ? raw : {};
  const result = isObjectRecord(payload.result) ? payload.result : {};
  const runtimeView = isObjectRecord(result.result) ? result.result : result;
  const candidates = Array.isArray(runtimeView.chatCodexSessions)
    ? runtimeView.chatCodexSessions
    : Array.isArray(result.chatCodexSessions)
      ? result.chatCodexSessions
      : Array.isArray(payload.chatCodexSessions)
        ? payload.chatCodexSessions
        : [];

  const dedup = new Map<string, RuntimeSessionState>();
  for (const item of candidates) {
    if (!isObjectRecord(item)) continue;
    const sessionId = asNonEmptyString(item.sessionId);
    if (!sessionId) continue;
    const providerId = asNonEmptyString(item.providerId);
    const hasActiveTurn = item.hasActiveTurn === true;
    const activeTurnId = asNonEmptyString(item.activeTurnId);
    const key = `${sessionId}::${providerId ?? ''}`;
    dedup.set(key, {
      sessionId,
      ...(providerId ? { providerId } : {}),
      hasActiveTurn,
      ...(activeTurnId ? { activeTurnId } : {}),
    });
  }
  return Array.from(dedup.values());
}

function parseInterruptCount(raw: unknown): number {
  if (!isObjectRecord(raw)) return 0;
  const result = isObjectRecord(raw.result) ? raw.result : {};
  const nested = isObjectRecord(result.result) ? result.result : result;
  const directCount = nested.interruptedCount;
  if (typeof directCount === 'number' && Number.isFinite(directCount)) {
    return Math.max(0, Math.floor(directCount));
  }
  const sessions = Array.isArray(nested.sessions) ? nested.sessions : [];
  const count = sessions.reduce((sum, item) => {
    if (!isObjectRecord(item)) return sum;
    return sum + (item.interrupted === true ? 1 : 0);
  }, 0);
  return Math.max(0, count);
}

export async function handleSystemStopAllReasoning(runtime: RuntimeFacade): Promise<string> {
  const systemAgentId = 'finger-system-agent';
  let statusResult: unknown;
  try {
    statusResult = await runtime.callTool(systemAgentId, 'agent.control', { action: 'status' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `❌ 强制停止失败：无法读取运行中会话状态（${message}）`;
  }

  const sessions = parseRuntimeSessionsFromControlStatus(statusResult);
  const activeSessions = sessions.filter((item) => item.hasActiveTurn);
  if (activeSessions.length === 0) {
    return '✅ 已执行强制停止：当前没有运行中的 Agent 推理（0 active turns）。';
  }

  let interruptedTurns = 0;
  const stoppedSessions: string[] = [];
  const failedSessions: Array<{ sessionId: string; providerId?: string; error: string }> = [];
  for (const item of activeSessions) {
    try {
      const interruptResult = await runtime.callTool(systemAgentId, 'agent.control', {
        action: 'interrupt',
        session_id: item.sessionId,
        ...(item.providerId ? { provider_id: item.providerId } : {}),
      });
      const interrupted = parseInterruptCount(interruptResult);
      interruptedTurns += interrupted;
      if (interrupted > 0) {
        stoppedSessions.push(item.providerId ? `${item.sessionId}@${item.providerId}` : item.sessionId);
      } else {
        failedSessions.push({
          sessionId: item.sessionId,
          ...(item.providerId ? { providerId: item.providerId } : {}),
          error: 'no active turn interrupted',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedSessions.push({
        sessionId: item.sessionId,
        ...(item.providerId ? { providerId: item.providerId } : {}),
        error: message,
      });
    }
  }

  const lines: string[] = [];
  lines.push(`🛑 已执行强制停止：扫描 ${activeSessions.length} 个 active session，成功中断 ${interruptedTurns} 个推理回合。`);
  if (stoppedSessions.length > 0) {
    lines.push(`✅ 已中断: ${stoppedSessions.slice(0, 12).join(', ')}${stoppedSessions.length > 12 ? ' …' : ''}`);
  }
  if (failedSessions.length > 0) {
    const failedDetail = failedSessions
      .slice(0, 8)
      .map((item) => `${item.providerId ? `${item.sessionId}@${item.providerId}` : item.sessionId}: ${item.error}`)
      .join(' | ');
    lines.push(`⚠️ 未中断: ${failedSessions.length} 个 (${failedDetail})`);
  }
  return lines.join('\n');
}

export async function handleSystemProgressReset(
  progressMonitor: {
    resetProgressState: (options?: { sessionId?: string; reason?: string }) => {
      scope: 'all' | 'session';
      sessionId?: string;
      clearedEntries: number;
      clearedSessions: number;
    };
  } | undefined,
  sessionId?: string,
): Promise<string> {
  if (!progressMonitor || typeof progressMonitor.resetProgressState !== 'function') {
    return '❌ 进度重置失败：progress monitor 不可用。';
  }
  const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim().length > 0
    ? sessionId.trim()
    : undefined;
  const result = progressMonitor.resetProgressState({
    ...(normalizedSessionId ? { sessionId: normalizedSessionId } : {}),
    reason: 'system_progress_reset',
  });
  if (result.scope === 'session') {
    return `✅ 已重置进度状态（session=${result.sessionId ?? normalizedSessionId ?? 'unknown'}，清理 ${result.clearedEntries} 条运行记录）。`;
  }
  return `✅ 已重置全局进度状态（清理 ${result.clearedEntries} 条运行记录，${result.clearedSessions} 个会话）。`;
}


/**
 * <##@system:compact##> - 手动触发上下文压缩
 */
export async function handleSystemCompact(
  runtime: RuntimeFacade | undefined,
  sessionId: string,
): Promise<string> {
  if (!runtime || typeof runtime.compressContext !== 'function') {
    return '❌ 上下文压缩失败：runtime facade 不可用。';
  }
  try {
    const log = logger.module('messagehub-command-handler');
    log.info('[handleSystemCompact] Manual compact rejected: kernel-owned', { sessionId });
    await runtime.compressContext(sessionId, { trigger: 'manual' });
    return '❌ 上下文压缩失败：unexpected manual compact success';
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return `❌ 上下文压缩失败：${errorMsg}`;
  }
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
