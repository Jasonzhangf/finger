import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { getChannelBridgeManager } from '../../bridges/manager.js';

interface SendLocalImageInput {
  path: string;
  caption?: string;
  channelId?: string;
  to?: string;
  replyTo?: string;
}

interface SendLocalImageResult {
  ok: boolean;
  messageId?: string;
  channelId: string;
  to: string;
  path: string;
  mimeType: string;
  error?: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
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

function parseInput(input: unknown): SendLocalImageInput {
  if (!input || typeof input !== 'object') {
    throw new Error('send_local_image input must be an object');
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.path !== 'string' || raw.path.trim().length === 0) {
    throw new Error('send_local_image.path must be a non-empty string');
  }
  return {
    path: raw.path.trim(),
    caption: typeof raw.caption === 'string' ? raw.caption : undefined,
    channelId: typeof raw.channelId === 'string' ? raw.channelId : undefined,
    to: typeof raw.to === 'string' ? raw.to : undefined,
    replyTo: typeof raw.replyTo === 'string' ? raw.replyTo : undefined,
  };
}

function resolveTargetFromSession(
  deps: AgentRuntimeDeps,
  sessionId: string | undefined,
): { channelId?: string; to?: string; replyTo?: string } {
  if (!sessionId) return {};
  const messages = deps.sessionManager.getMessages(sessionId, 80);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const meta = msg.metadata;
    if (!meta || typeof meta !== 'object') continue;
    const m = meta as Record<string, unknown>;
    const channelId = typeof m.channelId === 'string' ? m.channelId : undefined;
    const senderId = typeof m.senderId === 'string' ? m.senderId : undefined;
    const groupId = typeof m.groupId === 'string' ? m.groupId : undefined;
    const messageId = typeof m.messageId === 'string' ? m.messageId : undefined;
    if (!channelId) continue;
    const to = groupId ? `group:${groupId}` : senderId;
    if (!to) continue;
    return { channelId, to, replyTo: messageId };
  }
  return {};
}

/**
 * 注册 send_local_image 工具
 *
 * 用途：读取本地图片并通过 channel bridge 发送给当前会话用户。
 */
export function registerSendLocalImageTool(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps,
): void {
  toolRegistry.register({
    name: 'send_local_image',
    description: '发送本地图片到当前会话渠道（按 channel 适配：qqbot/openclaw-weixin/webui）',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地图片路径（绝对或相对路径）' },
        caption: { type: 'string', description: '图片说明（可选）' },
        channelId: { type: 'string', description: '指定渠道（可选，默认从当前 session 推断）' },
        to: { type: 'string', description: '指定目标（可选，默认从当前 session 推断）' },
        replyTo: { type: 'string', description: '指定回复消息ID（可选）' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    policy: 'allow',
    handler: async (input: unknown, context?: Record<string, unknown>): Promise<SendLocalImageResult> => {
      const params = parseInput(input);
      const deps = getAgentRuntimeDeps();
      const runtimeSessionId = typeof context?.sessionId === 'string' ? context.sessionId : undefined;
      const inferred = resolveTargetFromSession(deps, runtimeSessionId);

      const channelId = params.channelId || inferred.channelId || 'qqbot';
      const to = params.to || inferred.to;
      const replyTo = params.replyTo || inferred.replyTo;
      if (!to) {
        throw new Error('send_local_image cannot resolve target user/group from session; please provide `to`');
      }

      const baseDir = runtimeSessionId
        ? (deps.sessionManager.getSession(runtimeSessionId)?.projectPath || process.cwd())
        : process.cwd();
      const resolvedPath = path.isAbsolute(params.path)
        ? params.path
        : path.resolve(baseDir, params.path);

      const st = fs.statSync(resolvedPath, { throwIfNoEntry: false });
      if (!st || !st.isFile()) {
        throw new Error(`image file does not exist: ${resolvedPath}`);
      }

      const ext = path.extname(resolvedPath).toLowerCase();
      const mimeType = MIME_BY_EXTENSION[ext];
      if (!mimeType) {
        throw new Error(`unsupported image extension: ${ext || '(none)'}`);
      }

      const bridgeManager = getChannelBridgeManager();
      const result = await bridgeManager.sendMessage(channelId, {
        to,
        text: params.caption || '',
        ...(replyTo ? { replyTo } : {}),
        attachments: [
          {
            type: 'image',
            url: pathToFileURL(resolvedPath).toString(),
            filename: path.basename(resolvedPath),
            name: path.basename(resolvedPath),
            mimeType,
          },
        ],
      });

      return {
        ok: true,
        messageId: result.messageId,
        channelId,
        to,
        path: resolvedPath,
        mimeType,
      };
    },
  });
}
