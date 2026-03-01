import type { ReviewSettings, RuntimeEvent, RuntimeFile, RuntimeImage, UserRound } from '../api/types.js';
import { MAX_INLINE_FILE_TEXT_CHARS } from './useWorkflowExecution.constants.js';
import type { KernelInputItem, SessionApiAttachment, SessionApiMessage } from './useWorkflowExecution.types.js';
import {
  buildToolResultContent,
  resolveToolActionLabel,
  resolveToolCategoryLabel,
} from './useWorkflowExecution.tools.js';
import { estimateTokenUsage, isRecord } from './useWorkflowExecution.utils.js';

export function normalizeRuntimeFileMime(attachment: SessionApiAttachment): string {
  if (attachment.type === 'code') return 'text/plain';
  if (attachment.type === 'image') return 'image/*';
  return 'application/octet-stream';
}

export function toRuntimeImageUrl(url: string): string {
  const trimmed = url.trim();
  if (
    trimmed.startsWith('data:')
    || trimmed.startsWith('blob:')
    || trimmed.startsWith('http://')
    || trimmed.startsWith('https://')
  ) {
    return trimmed;
  }
  const isPosixAbsPath = trimmed.startsWith('/');
  const isWindowsAbsPath = /^[A-Za-z]:[\\/]/.test(trimmed);
  if (!isPosixAbsPath && !isWindowsAbsPath) {
    return trimmed;
  }
  return `/api/v1/files/local-image?path=${encodeURIComponent(trimmed)}`;
}

function buildFileInputText(file: RuntimeFile): string {
  const header = `[文件 ${file.name} | ${file.mimeType} | ${file.size} bytes]`;
  if (typeof file.textContent === 'string' && file.textContent.trim().length > 0) {
    const trimmed = file.textContent.slice(0, MAX_INLINE_FILE_TEXT_CHARS);
    const suffix = file.textContent.length > MAX_INLINE_FILE_TEXT_CHARS ? '\n...[文件内容已截断]' : '';
    return `${header}\n${trimmed}${suffix}`;
  }
  return `${header}\n[二进制文件，未内联文本内容]`;
}

export function toSessionAttachments(images: RuntimeImage[], files: RuntimeFile[]): SessionApiAttachment[] {
  const imageAttachments: SessionApiAttachment[] = images.map((image) => ({
    id: image.id,
    name: image.name,
    type: 'image',
    url: image.dataUrl || image.url,
    size: image.size,
  }));
  const fileAttachments: SessionApiAttachment[] = files.map((file) => ({
    id: file.id,
    name: file.name,
    type: file.mimeType.startsWith('text/') ? 'code' : 'file',
    url: file.dataUrl || '',
    size: file.size,
  }));
  return [...imageAttachments, ...fileAttachments];
}

export function mapSessionMessageToRuntimeEvent(
  message: SessionApiMessage,
  defaultAgentId: string,
): RuntimeEvent {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const images: RuntimeImage[] = attachments
    .filter((item) => item.type === 'image')
    .map((item) => ({
      id: item.id,
      name: item.name,
      url: toRuntimeImageUrl(item.url),
      size: item.size,
    }));
  const files: RuntimeFile[] = attachments
    .filter((item) => item.type !== 'image')
    .map((item) => ({
      id: item.id,
      name: item.name,
      mimeType: normalizeRuntimeFileMime(item),
      size: item.size ?? 0,
      dataUrl: item.url.startsWith('data:') ? item.url : undefined,
    }));

  const metaRecord = isRecord(message.metadata) ? message.metadata : null;
  const metaEvent = metaRecord && isRecord(metaRecord.event) ? metaRecord.event : null;
  const explicitAgentId =
    (typeof message.agentId === 'string' && message.agentId.trim().length > 0 ? message.agentId.trim() : '')
    || (metaEvent && typeof metaEvent.agentId === 'string' ? metaEvent.agentId : '');
  const resolvedAgentId = explicitAgentId || defaultAgentId;
  const metaAgentName =
    (metaRecord && typeof metaRecord.agentName === 'string' && metaRecord.agentName.trim().length > 0
      ? metaRecord.agentName.trim()
      : '')
    || (metaRecord && typeof metaRecord.agentRole === 'string' && metaRecord.agentRole.trim().length > 0
      ? metaRecord.agentRole.trim()
      : '');
  const resolvedAgentName = metaAgentName || explicitAgentId || resolvedAgentId;
  const toolName =
    (typeof message.toolName === 'string' && message.toolName.trim().length > 0 ? message.toolName.trim() : '')
    || (metaEvent && typeof metaEvent.toolName === 'string' ? metaEvent.toolName : '');
  const toolInput =
    message.toolInput !== undefined
      ? message.toolInput
      : (metaEvent && isRecord(metaEvent.payload) ? metaEvent.payload.input : undefined);
  const toolOutput =
    message.toolOutput !== undefined
      ? message.toolOutput
      : (metaEvent && isRecord(metaEvent.payload)
        ? (metaEvent.payload.output ?? metaEvent.payload.error)
        : undefined);
  const toolDurationMs =
    typeof message.toolDurationMs === 'number'
      ? message.toolDurationMs
      : (metaEvent && isRecord(metaEvent.payload) && typeof metaEvent.payload.duration === 'number'
        ? metaEvent.payload.duration
        : undefined);
  const toolStatus = message.toolStatus
    ?? (message.type === 'tool_error' ? 'error' : message.type === 'tool_result' ? 'success' : undefined);

  if (message.type === 'tool_call' && toolName) {
    const actionLabel = resolveToolActionLabel(toolName, toolInput);
    const category = resolveToolCategoryLabel(toolName, toolInput);
    return {
      id: message.id,
      role: 'system',
      agentId: resolvedAgentId,
      agentName: resolvedAgentName,
      content: message.content || `调用工具：${actionLabel}`,
      timestamp: message.timestamp,
      kind: 'action',
      toolName,
      toolCategory: category,
      toolStatus: 'running',
      ...(toolDurationMs !== undefined ? { toolDurationMs } : {}),
      ...(toolInput !== undefined ? { toolInput } : {}),
      ...(toolOutput !== undefined ? { toolOutput } : {}),
    };
  }

  if ((message.type === 'tool_result' || message.type === 'tool_error') && toolName) {
    const category = resolveToolCategoryLabel(toolName, toolInput);
    const status = toolStatus === 'error' ? 'error' : 'success';
    const errorText = status === 'error' && typeof toolOutput === 'string' ? toolOutput : undefined;
    const content = message.content || buildToolResultContent(toolName, status, toolDurationMs, errorText, toolInput);
    return {
      id: message.id,
      role: 'system',
      agentId: resolvedAgentId,
      agentName: resolvedAgentName,
      content,
      timestamp: message.timestamp,
      kind: 'observation',
      toolName,
      toolCategory: category,
      toolStatus: status,
      ...(toolDurationMs !== undefined ? { toolDurationMs } : {}),
      ...(toolInput !== undefined ? { toolInput } : {}),
      ...(toolOutput !== undefined ? { toolOutput } : {}),
      ...(status === 'error' && typeof toolOutput === 'string' ? { errorMessage: toolOutput } : {}),
    };
  }

  // Tool events from session messages stay in the conversation stream as-is.

  if (message.type === 'agent_step') {
    return {
      id: message.id,
      role: 'system',
      agentId: resolvedAgentId,
      agentName: resolvedAgentName,
      content: message.content,
      timestamp: message.timestamp,
      kind: 'thought',
    };
  }

  if (message.role === 'user') {
    return {
      id: message.id,
      role: 'user',
      content: message.content,
      timestamp: message.timestamp,
      kind: 'status',
      tokenUsage: estimateTokenUsage(message.content),
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
    };
  }

  if (message.role === 'assistant' || message.role === 'orchestrator') {
    return {
      id: message.id,
      role: 'agent',
      agentId: resolvedAgentId,
      agentName: resolvedAgentName,
      content: message.content,
      timestamp: message.timestamp,
      kind: 'observation',
      tokenUsage: estimateTokenUsage(message.content),
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
    };
  }

  if (message.role === 'system') {
    return {
      id: message.id,
      role: 'system',
      ...(explicitAgentId ? { agentId: explicitAgentId, agentName: resolvedAgentName } : {}),
      content: message.content,
      timestamp: message.timestamp,
      kind: 'status',
      tokenUsage: estimateTokenUsage(message.content),
      ...(images.length > 0 ? { images } : {}),
      ...(files.length > 0 ? { files } : {}),
    };
  }

  return {
    id: message.id,
    role: 'system',
    content: message.content,
    timestamp: message.timestamp,
    kind: 'status',
    tokenUsage: estimateTokenUsage(message.content),
    ...(images.length > 0 ? { images } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}

export function buildUserRoundsFromSessionMessages(messages: SessionApiMessage[]): UserRound[] {
  return messages
    .filter((item) => item.role === 'user')
    .map((item) => {
      const attachments = Array.isArray(item.attachments) ? item.attachments : [];
      const images: RuntimeImage[] = attachments
        .filter((attachment) => attachment.type === 'image')
        .map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          url: toRuntimeImageUrl(attachment.url),
          size: attachment.size,
        }));
      const files: RuntimeFile[] = attachments
        .filter((attachment) => attachment.type !== 'image')
        .map((attachment) => ({
          id: attachment.id,
          name: attachment.name,
          mimeType: normalizeRuntimeFileMime(attachment),
          size: attachment.size ?? 0,
          dataUrl: attachment.url.startsWith('data:') ? attachment.url : undefined,
        }));
      const text = item.content || '';
      return {
        roundId: item.id,
        timestamp: item.timestamp,
        summary: text.length > 24 ? `${text.slice(0, 24)}...` : text || '[附件输入]',
        fullText: text,
        ...(images.length > 0 ? { images } : {}),
        ...(files.length > 0 ? { files } : {}),
      };
    });
}

export function buildKernelInputItems(
  text: string,
  images: RuntimeImage[],
  files: RuntimeFile[],
): KernelInputItem[] {
  const items: KernelInputItem[] = [];
  if (text.trim().length > 0) {
    items.push({ type: 'text', text: text.trim() });
  }

  for (const image of images) {
    if (typeof image.dataUrl === 'string' && image.dataUrl.trim().length > 0) {
      items.push({ type: 'image', image_url: image.dataUrl });
      continue;
    }
    if (image.url.startsWith('data:')) {
      items.push({ type: 'image', image_url: image.url });
    }
  }

  for (const file of files) {
    if (file.mimeType.startsWith('image/') && typeof file.dataUrl === 'string' && file.dataUrl.trim().length > 0) {
      const exists = items.some((item) => item.type === 'image' && item.image_url === file.dataUrl);
      if (!exists) {
        items.push({ type: 'image', image_url: file.dataUrl });
      }
      continue;
    }

    const hasSameImage = items.some(
      (item) => item.type === 'image' && typeof file.dataUrl === 'string' && item.image_url === file.dataUrl,
    );
    if (!hasSameImage) {
      items.push({ type: 'text', text: buildFileInputText(file) });
    }
  }

  return items;
}

export function normalizeReviewSettings(review: ReviewSettings | undefined): ReviewSettings | undefined {
  if (!review || review.enabled !== true) return undefined;
  const target = review.target.trim();
  if (target.length === 0) return undefined;

  const strictness = review.strictness === 'strict' ? 'strict' : 'mainline';
  const maxTurns = Number.isFinite(review.maxTurns)
    ? Math.max(0, Math.floor(review.maxTurns))
    : 10;

  return {
    enabled: true,
    target,
    strictness,
    maxTurns,
  };
}

export function buildGatewayHistory(
  events: RuntimeEvent[],
  maxItems: number,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return events
    .filter((event) => event.role === 'user' || event.role === 'agent')
    .map((event) => {
      const role: 'user' | 'assistant' = event.role === 'user' ? 'user' : 'assistant';
      return {
        role,
        content: event.content,
      };
    })
    .filter((event) => event.content.trim().length > 0)
    .slice(-maxItems);
}

export function buildContextEditableEventIds(events: RuntimeEvent[], maxItems: number): string[] {
  return events
    .filter((event) => (event.role === 'user' || event.role === 'agent') && typeof event.id === 'string' && event.id.length > 0)
    .slice(-maxItems)
    .map((event) => event.id);
}
