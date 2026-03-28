import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve as resolvePath, sep as pathSep } from 'node:path';
import type { ChannelAttachment, ChannelMessage } from '../../bridges/types.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { SYSTEM_PROJECT_PATH } from '../../agents/finger-system-agent/index.js';
import { logger } from '../../core/logger.js';

const log = logger.module('ChannelBridgeHubRouteHelpers');
const processedMessages = new Map<string, number>();
const DEDUP_TTL_MS = 60_000;

export function toKernelHistoryItems(
  history: Array<{ role: string; content: string }>,
): Array<Record<string, unknown>> {
  return history
    .filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
    .map((item) => {
      const role = item.role === 'assistant' ? 'assistant' : 'user';
      return {
        role,
        content: [
          {
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text: item.content,
          },
        ],
      };
    });
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

function toImageDataUrl(localPath: string): string | null {
  try {
    const bytes = readFileSync(localPath);
    const mime = IMAGE_MIME_BY_EXT[extname(localPath).toLowerCase()] ?? 'application/octet-stream';
    if (!mime.startsWith('image/')) return null;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  }
}

export function toKernelInputItemsFromAttachments(message: ChannelMessage): Array<Record<string, unknown>> {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const imageAttachments = attachments.filter((a) => a?.type === 'image' && typeof a.url === 'string' && a.url.trim().length > 0);
  if (imageAttachments.length === 0) return [];

  const items: Array<Record<string, unknown>> = [];
  for (const att of imageAttachments) {
    const rawUrl = att.url.trim();
    if (!rawUrl) continue;

    if (rawUrl.startsWith('data:image/')) {
      items.push({ type: 'image', image_url: rawUrl });
      continue;
    }

    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) {
      items.push({ type: 'image', image_url: rawUrl });
      continue;
    }

    const localPath = rawUrl.startsWith('file://')
      ? (() => {
          try {
            return decodeURIComponent(rawUrl.replace(/^file:\/\//, ''));
          } catch {
            return rawUrl.replace(/^file:\/\//, '');
          }
        })()
      : rawUrl;
    if (existsSync(localPath)) {
      const dataUrl = toImageDataUrl(localPath);
      if (dataUrl) {
        items.push({ type: 'image', image_url: dataUrl });
      }
      continue;
    }

    items.push({ type: 'image', image_url: rawUrl });
  }

  return items;
}

export function sanitizePromptForInjectedImages(content: string): string {
  if (!content || content.trim().length === 0) return content;
  const localImagePathPattern = /(?:file:\/\/)?(?:\/Users\/|\/home\/|[A-Za-z]:[\\/])[^\s<>"']+\.(?:png|jpe?g|gif|webp|bmp|svg|tiff?)/gi;
  return content.replace(localImagePathPattern, '[local-image]');
}

export function isAttachmentMarkerText(content: string): boolean {
  return /^【附件消息】/u.test((content || '').trim());
}

export function buildNonImageAttachmentPrompt(attachments: ChannelAttachment[]): string {
  const lines = ['我刚发送了附件，请先读取附件内容再回答。', '附件列表：'];
  const maxItems = Math.min(attachments.length, 6);
  for (let i = 0; i < maxItems; i += 1) {
    const att = attachments[i];
    const type = typeof att.type === 'string' ? att.type : 'file';
    const name = typeof att.name === 'string'
      ? att.name
      : (typeof att.filename === 'string' ? att.filename : '');
    const url = typeof att.url === 'string' ? att.url.trim() : '';
    const displayName = name || (url ? url.split('/').pop() || 'attachment' : `attachment-${i + 1}`);
    lines.push(`- [${type}] ${displayName}${url ? ` | ${url}` : ''}`);
  }
  if (attachments.length > maxItems) {
    lines.push(`- ... 另外 ${attachments.length - maxItems} 个附件`);
  }
  return lines.join('\n');
}

export function looksLikeCurrentTurnMediaRequest(content: string): boolean {
  const text = (content || '').trim().toLowerCase();
  if (!text) return false;
  const zh = /(图片|图像|照片|截图|识图|看图|附件|文档|pdf|文件)/u;
  const en = /\b(image|picture|photo|screenshot|attachment|file|pdf|document)\b/u;
  return zh.test(text) || en.test(text);
}

export function isDuplicateMessage(msgId: string): boolean {
  const now = Date.now();
  if (processedMessages.has(msgId)) {
    const existing = processedMessages.get(msgId)!;
    if (now - existing < DEDUP_TTL_MS) {
      log.debug('Duplicate message detected, skipping', { msgId });
      return true;
    }
  }
  processedMessages.set(msgId, now);
  if (processedMessages.size > 500) {
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL_MS) processedMessages.delete(id);
    }
  }
  return false;
}

export function addAgentPrefix(content: string, agentId?: string): string {
  const time = String(new Date().getHours()).padStart(2, '0') + ':' + String(new Date().getMinutes()).padStart(2, '0');
  const agentName = agentId?.replace(/^finger-/, '').replace(/-/g, ' ') || 'orchestrator';
  return `[${time}] ${content}`;
}

export function resolveSessionForChannelTarget(params: {
  sessionManager: SessionManager;
  channelContextManager: import('../../orchestration/channel-context-manager.js').ChannelContextManager;
  targetAgentId: string;
  channelId: string;
  channelContext?: { projectPath?: string };
}): { sessionId: string; projectPath: string } {
  const { sessionManager, channelContextManager, targetAgentId, channelId, channelContext } = params;
  if (targetAgentId === 'finger-system-agent') {
    const systemSession = sessionManager.getOrCreateSystemSession();
    sessionManager.ensureSession(systemSession.id, SYSTEM_PROJECT_PATH, `channel:${channelId}`);
    channelContextManager.pinSession(channelId, targetAgentId, systemSession.id);
    return { sessionId: systemSession.id, projectPath: SYSTEM_PROJECT_PATH };
  }

  const preferredProjectPath = channelContext?.projectPath?.trim();
  const projectPath = preferredProjectPath && preferredProjectPath.length > 0
    ? preferredProjectPath
    : (() => {
        const getCurrentSession = (sessionManager as unknown as {
          getCurrentSession?: () => { projectPath?: string } | null;
        }).getCurrentSession;
        const current = typeof getCurrentSession === 'function'
          ? getCurrentSession.call(sessionManager)
          : null;
        if (
          current
          && typeof current.projectPath === 'string'
          && current.projectPath.length > 0
          && current.projectPath !== SYSTEM_PROJECT_PATH
        ) {
          return current.projectPath;
        }
        return process.cwd();
      })();

  const pinnedSessionId = channelContextManager.getPinnedSession(channelId, targetAgentId);
  if (pinnedSessionId) {
    const pinned = sessionManager.getSession(pinnedSessionId);
    if (pinned) {
      return { sessionId: pinned.id, projectPath: pinned.projectPath };
    }
  }

  const normalizedProjectPath = resolvePath(projectPath);
  const normalizedPrefix = normalizedProjectPath.endsWith(pathSep)
    ? normalizedProjectPath
    : `${normalizedProjectPath}${pathSep}`;

  const listSessions = (sessionManager as unknown as {
    listSessions?: () => Array<{
      id?: string;
      projectPath?: string;
      lastAccessedAt?: string;
      context?: Record<string, unknown>;
    }>;
  }).listSessions;
  const sessionsForTarget = (typeof listSessions === 'function' ? listSessions.call(sessionManager) : [])
    .filter((session): session is {
      id: string;
      projectPath: string;
      lastAccessedAt?: string;
      context?: Record<string, unknown>;
    } => {
      if (typeof session.id !== 'string' || session.id.trim().length === 0) return false;
      if (typeof session.projectPath !== 'string' || session.projectPath.length === 0) return false;
      const candidatePath = resolvePath(session.projectPath);
      const projectPathMatched = candidatePath === normalizedProjectPath || candidatePath.startsWith(normalizedPrefix);
      if (!projectPathMatched) return false;
      const sessionContext = (session.context ?? {}) as Record<string, unknown>;
      return typeof sessionContext.ownerAgentId === 'string' && sessionContext.ownerAgentId === targetAgentId;
    })
    .sort((a, b) => {
      const ta = typeof a.lastAccessedAt === 'string' ? new Date(a.lastAccessedAt).getTime() : 0;
      const tb = typeof b.lastAccessedAt === 'string' ? new Date(b.lastAccessedAt).getTime() : 0;
      return tb - ta;
    });

  const findSessionsByProjectPath = (sessionManager as unknown as {
    findSessionsByProjectPath?: (projectPath: string) => Array<{ id: string }>;
  }).findSessionsByProjectPath;
  const latest = typeof findSessionsByProjectPath === 'function'
    ? (findSessionsByProjectPath.call(sessionManager, projectPath) ?? [])[0]
    : undefined;
  const createSession = (sessionManager as unknown as {
    createSession?: (
      projectPath: string,
      source?: string,
      options?: { allowReuse?: boolean },
    ) => { id: string };
  }).createSession;
  const ensureSession = (sessionManager as unknown as {
    ensureSession?: (sessionId: string, projectPath: string, source?: string) => void;
  }).ensureSession;

  const session = sessionsForTarget[0]
    ?? latest
    ?? (typeof createSession === 'function'
      ? createSession.call(sessionManager, projectPath, `channel:${channelId}`, { allowReuse: true })
      : sessionManager.getOrCreateSystemSession());

  if (typeof ensureSession === 'function') {
    ensureSession.call(sessionManager, session.id, projectPath, `channel:${channelId}`);
  }
  channelContextManager.pinSession(channelId, targetAgentId, session.id);
  return { sessionId: session.id, projectPath };
}
