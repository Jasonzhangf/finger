import { isAbsolute, join } from 'path';
import type { ChatCodexDeveloperRole } from '../../agents/chat-codex/developer-prompt-templates.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';

export type RuntimePromptConfig = {
  prompts?: {
    system?: string;
    developer?: string;
  };
};

export type FingerRoleForPrompt = {
  roleProfile: string;
};

export function resolveRolePromptOverridesFromConfig(
  runtimeConfig: RuntimePromptConfig | undefined | null,
  role: FingerRoleForPrompt,
  developerRole: ChatCodexDeveloperRole,
  agentId: string,
): {
  developerPromptPath?: string;
  developerPromptPaths?: Partial<Record<ChatCodexDeveloperRole, string>>;
} {
  const systemPath = runtimeConfig?.prompts?.system?.trim();
  const developerPath = runtimeConfig?.prompts?.developer?.trim();
  const effectiveDeveloperPath = role.roleProfile === 'system'
    ? (systemPath && systemPath.length > 0 ? systemPath : developerPath)
    : developerPath;

  if (!effectiveDeveloperPath || effectiveDeveloperPath.length === 0) {
    return {};
  }

  const agentDir = join(FINGER_PATHS.runtime.agentsDir, agentId);
  const resolvedPath = isAbsolute(effectiveDeveloperPath)
    ? effectiveDeveloperPath
    : join(agentDir, effectiveDeveloperPath);

  return {
    developerPromptPath: resolvedPath,
    developerPromptPaths: {
      [developerRole]: resolvedPath,
    } as Partial<Record<ChatCodexDeveloperRole, string>>,
  };
}

export function hasMediaInputInMessage(
  message: {
    metadata?: Record<string, unknown>;
    attachments?: unknown[];
  } | null | undefined,
): boolean {
  if (!message) return false;
  const directAttachments = Array.isArray(message.attachments) ? message.attachments : [];
  const metadataAttachments = Array.isArray(message.metadata?.attachments)
    ? message.metadata.attachments as unknown[]
    : [];
  const allAttachments = [...directAttachments, ...metadataAttachments];
  if (allAttachments.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const attachment = item as Record<string, unknown>;
    const kind = typeof attachment.kind === 'string' ? attachment.kind : '';
    const mimeType = typeof attachment.mimeType === 'string' ? attachment.mimeType : '';
    const type = typeof attachment.type === 'string' ? attachment.type : '';
    return kind === 'image'
      || mimeType.startsWith('image/')
      || type === 'image';
  })) {
    return true;
  }

  const inputItems = message.metadata?.inputItems;
  if (!Array.isArray(inputItems)) return false;
  return inputItems.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const type = (item as { type?: unknown }).type;
    return type === 'image' || type === 'local_image';
  });
}

export function mapRawSessionMessages(
  messages: Array<{
    id?: string;
    role: string;
    content: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
  }>,
  limit: number,
  extraMetadata?: Record<string, unknown>,
): Array<{
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}> {
  const sliced = Number.isFinite(limit) && limit > 0
    ? messages.slice(-limit)
    : messages;
  return sliced
    .filter((item) => typeof item.content === 'string' && item.content.trim().length > 0)
    .map((item, index) => ({
      id: item.id ?? `raw-${Date.now()}-${index}`,
      role: item.role === 'assistant' || item.role === 'system' ? item.role : 'user',
      content: item.content,
      timestamp: item.timestamp ?? new Date().toISOString(),
      ...((item.metadata && typeof item.metadata === 'object') || (extraMetadata && typeof extraMetadata === 'object')
        ? { metadata: { ...(item.metadata ?? {}), ...(extraMetadata ?? {}) } }
        : {}),
    }));
}
