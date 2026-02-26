import { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from './useWebSocket.js';
import { getWebSocket } from '../api/websocket.js';
import type {
  WorkflowExecutionState,
  WorkflowInfo,
  AgentExecutionDetail,
  WsMessage,
  WorkflowUpdatePayload,
  AgentUpdatePayload,
  TaskReport,
  TaskNode,
  AgentRuntime,
  RuntimeEvent,
  ReviewSettings,
  UserInputPayload,
  UserRound,
  ExecutionRound,
  AgentRoundInfo,
  RoundEdgeInfo,
  RuntimeFile,
  RuntimeImage,
  RuntimePlanStep,
} from '../api/types.js';

const CHAT_PANEL_TARGET = (import.meta.env.VITE_CHAT_PANEL_TARGET as string | undefined)?.trim() || 'chat-codex-gateway';
const DEFAULT_CHAT_AGENT_ID = 'chat-codex';
const MAX_INLINE_FILE_TEXT_CHARS = 12000;
const SESSION_MESSAGES_FETCH_LIMIT = 0;
const DEFAULT_CONTEXT_HISTORY_WINDOW_SIZE = 40;
const parsedContextWindowSize = Number(import.meta.env.VITE_CONTEXT_HISTORY_WINDOW_SIZE ?? '');
const CONTEXT_HISTORY_WINDOW_SIZE =
  Number.isFinite(parsedContextWindowSize) && parsedContextWindowSize > 0
    ? Math.floor(parsedContextWindowSize)
    : DEFAULT_CONTEXT_HISTORY_WINDOW_SIZE;

type KernelInputItem =
  | { type: 'text'; text: string }
  | { type: 'image'; image_url: string }
  | { type: 'local_image'; path: string };

interface SessionLog {
  sessionId: string;
  agentId: string;
  agentRole: string;
  userTask: string;
  taskId?: string;
  startTime: string;
  endTime?: string;
  success: boolean;
  iterations: Array<{
    round: number;
    action: string;
    thought?: string;
    params?: Record<string, unknown>;
    observation?: string;
    success: boolean;
    timestamp: string;
    duration?: number;
  }>;
  totalRounds: number;
  finalOutput?: string;
  finalError?: string;
  stopReason?: string;
}

interface SessionApiAttachment {
  id: string;
  name: string;
  type: 'image' | 'file' | 'code';
  url: string;
  size?: number;
}

interface SessionApiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'orchestrator';
  content: string;
  timestamp: string;
  attachments?: SessionApiAttachment[];
}

interface RuntimeTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimated?: boolean;
}

interface AgentRunStatus {
  phase: 'idle' | 'running' | 'error';
  text: string;
  updatedAt: string;
}

interface UseWorkflowExecutionReturn {
  workflow: WorkflowInfo | null;
  executionState: WorkflowExecutionState | null;
  runtimeEvents: RuntimeEvent[];
  userRounds: UserRound[];
  executionRounds: ExecutionRound[];
  selectedAgentId: string | null;
  setSelectedAgentId: (agentId: string | null) => void;
  isLoading: boolean;
  error: string | null;
  startWorkflow: (userTask: string) => Promise<void>;
  pauseWorkflow: () => Promise<void>;
  resumeWorkflow: () => Promise<void>;
  sendUserInput: (input: UserInputPayload) => Promise<void>;
  editRuntimeEvent: (eventId: string, content: string) => Promise<boolean>;
  deleteRuntimeEvent: (eventId: string) => Promise<boolean>;
  agentRunStatus: AgentRunStatus;
  contextEditableEventIds: string[];
  getAgentDetail: (agentId: string) => AgentExecutionDetail | null;
  getTaskReport: () => TaskReport | null;
  isConnected: boolean;
  inputLockState: InputLockState | null;
  clientId: string | null;
  acquireInputLock: () => Promise<boolean>;
  releaseInputLock: () => void;
}

interface InputLockState {
  sessionId: string;
  lockedBy: string | null;
  lockedAt: string | null;
  typing: boolean;
  lastHeartbeatAt?: string | null;
  expiresAt?: string | null;
}

function isPersistedSessionMessageId(id: string): boolean {
  return id.startsWith('msg-');
}

function inferAgentType(agentId: string): AgentRuntime['type'] {
  if (agentId.includes('orchestrator')) return 'orchestrator';
  if (agentId.includes('reviewer')) return 'reviewer';
  return 'executor';
}

function inferAgentStatus(log: SessionLog): AgentRuntime['status'] {
  if (!log.endTime) return 'running';
  if (log.success) return 'idle';
  return 'error';
}

function mapTaskStatusToPathStatus(status: TaskNode['status']): 'active' | 'completed' | 'error' | 'pending' {
  if (status === 'in_progress') return 'active';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'error';
  return 'pending';
}

function pickWorkflowForSession(workflows: WorkflowInfo[], sessionId: string, preferredWorkflowId?: string): WorkflowInfo | null {
  if (workflows.length === 0) return null;

  if (preferredWorkflowId) {
    const exact = workflows.find((w) => w.id === preferredWorkflowId || w.epicId === preferredWorkflowId);
    if (exact) return exact;
  }

  const sameSession = workflows.filter((w) => w.sessionId === sessionId);
  const candidates = sameSession.length > 0 ? sameSession : workflows;

  const active = candidates
    .filter((w) => w.status === 'planning' || w.status === 'executing' || w.status === 'paused')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  if (active.length > 0) return active[0];

  return candidates
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
}

function pushEvent(current: RuntimeEvent[], event: Omit<RuntimeEvent, 'id'> & { id?: string }): RuntimeEvent[] {
  const entry: RuntimeEvent = {
    ...event,
    id: event.id ?? `${event.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
  };
  const existingIndex = current.findIndex((item) => item.id === entry.id);
  if (existingIndex >= 0) {
    const updated = [...current];
    updated[existingIndex] = entry;
    return updated;
  }
  return [...current.slice(-299), entry];
}

function upsertAgentRuntimeEvent(current: RuntimeEvent[], event: Omit<RuntimeEvent, 'id'>): RuntimeEvent[] {
  // 对同一个 agent 的状态事件做就地更新，避免 UI 积压导致卡顿
  if (event.role !== 'agent' || !event.agentId) {
    return pushEvent(current, event);
  }

  const idx = current.findIndex(
    (e) =>
      e.role === 'agent' &&
      e.agentId === event.agentId &&
      e.kind === 'status',
  );

  if (idx >= 0 && event.kind === 'status') {
    const updated = [...current];
    updated[idx] = {
      ...updated[idx],
      ...event,
    } as RuntimeEvent;
    return updated;
  }

  return pushEvent(current, event);
}

function computeAgentLoadFromLog(log: SessionLog): number {
  const rounds = Math.max(log.totalRounds || log.iterations.length || 1, 1);
  const current = log.iterations.length;
  if (log.endTime) return 100;
  return Math.min(95, Math.max(5, Math.round((current / rounds) * 100)));
}

function buildRoundExecutionPath(
  tasks: TaskNode[],
  orchestratorId: string,
): WorkflowExecutionState['executionPath'] {
  return tasks.map((task) => ({
    from: orchestratorId,
    to: task.assignee || 'executor-loop',
    status: mapTaskStatusToPathStatus(task.status),
    message: `${task.id}: ${task.description}`,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstStringField(value: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate !== 'string') continue;
    const normalized = candidate.trim();
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}

function looksLikeExecOutput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.exitCode === 'number') return true;
  if (isRecord(value.termination) && typeof value.termination.type === 'string') return true;
  if (typeof value.wall_time_seconds === 'number') return true;
  if (typeof value.text === 'string' && value.text.includes('Process exited with code')) return true;
  return false;
}

function inferToolName(input?: unknown, output?: unknown): string | undefined {
  if (isRecord(input)) {
    if (typeof input.cmd === 'string') return 'exec_command';
    if (typeof input.command === 'string') return 'exec_command';
    if (Array.isArray(input.command) && input.command.length > 0) return 'exec_command';
    if (
      typeof input.chars === 'string' &&
      (typeof input.session_id === 'string' || typeof input.sessionId === 'string')
    ) {
      return 'write_stdin';
    }
    if (typeof input.path === 'string') return 'view_image';
    if (typeof input.query === 'string' || typeof input.q === 'string') return 'web_search';
    if (typeof input.action === 'string' && input.action === 'query') return 'context_ledger.memory';
  }

  if (isRecord(output)) {
    if (Array.isArray(output.plan)) return 'update_plan';
    if (typeof output.path === 'string' && typeof output.mimeType === 'string' && output.mimeType.startsWith('image/')) {
      return 'view_image';
    }
    if (Array.isArray(output.results)) return 'web_search';
    if (looksLikeExecOutput(output)) return 'exec_command';
    if (isRecord(output.result)) {
      if (looksLikeExecOutput(output.result)) return 'exec_command';
      if (
        typeof output.result.path === 'string' &&
        typeof output.result.mimeType === 'string' &&
        output.result.mimeType.startsWith('image/')
      ) {
        return 'view_image';
      }
    }
  }

  return undefined;
}

function resolveDisplayToolName(payload: Record<string, unknown>, input?: unknown, output?: unknown): string {
  const explicitName = firstStringField(payload, ['toolName', 'tool_name', 'tool']);
  if (explicitName && explicitName !== 'unknown') {
    if (explicitName === 'shell' || explicitName === 'shell.exec' || explicitName === 'shell_command') {
      return inferToolName(input, output) ?? 'exec_command';
    }
    return explicitName;
  }
  return inferToolName(input, output) ?? 'unknown';
}

function truncateInlineText(text: string, maxChars = 140): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function formatCommandArray(command: unknown[]): string {
  return command
    .filter((item): item is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof item))
    .map((item) => String(item))
    .join(' ')
    .trim();
}

function extractExecCommand(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  if (typeof input.cmd === 'string' && input.cmd.trim().length > 0) {
    return truncateInlineText(input.cmd, 200);
  }
  if (typeof input.command === 'string' && input.command.trim().length > 0) {
    return truncateInlineText(input.command, 200);
  }
  if (Array.isArray(input.command)) {
    const formatted = formatCommandArray(input.command);
    if (formatted.length > 0) return truncateInlineText(formatted, 200);
  }
  return undefined;
}

function buildToolExecutionSummary(toolName: string, input?: unknown): string | undefined {
  const command = extractExecCommand(input);
  if (command) return `命令 ${command}`;

  if (!isRecord(input)) return undefined;

  if (toolName === 'write_stdin' && typeof input.chars === 'string') {
    return `写入 ${input.chars.length} 字符`;
  }

  if (typeof input.path === 'string' && input.path.trim().length > 0) {
    return `路径 ${truncateInlineText(input.path, 120)}`;
  }

  const query = typeof input.query === 'string' ? input.query : typeof input.q === 'string' ? input.q : '';
  if (query.trim().length > 0) {
    return `查询 ${truncateInlineText(query, 120)}`;
  }

  if (typeof input.action === 'string' && input.action.trim().length > 0) {
    return `动作 ${truncateInlineText(input.action, 80)}`;
  }

  return undefined;
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

function normalizeRuntimeFileMime(attachment: SessionApiAttachment): string {
  if (attachment.type === 'code') return 'text/plain';
  if (attachment.type === 'image') return 'image/*';
  return 'application/octet-stream';
}

function toRuntimeImageUrl(url: string): string {
  const trimmed = url.trim();
  if (
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://')
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

function pickFilenameFromPath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? inputPath;
}

function parseViewImageOutput(output: unknown): RuntimeImage | null {
  if (!isRecord(output)) return null;
  const path = typeof output.path === 'string' ? output.path.trim() : '';
  if (path.length === 0) return null;
  const mimeType = typeof output.mimeType === 'string' ? output.mimeType : '';
  if (!mimeType.startsWith('image/')) return null;
  const size = typeof output.sizeBytes === 'number' && Number.isFinite(output.sizeBytes)
    ? Math.max(0, Math.floor(output.sizeBytes))
    : undefined;
  return {
    id: `view-image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: pickFilenameFromPath(path),
    url: toRuntimeImageUrl(path),
    mimeType,
    size,
  };
}

function parseUpdatePlanOutput(output: unknown): {
  steps: RuntimePlanStep[];
  explanation?: string;
  updatedAt?: string;
} | null {
  if (!isRecord(output) || !Array.isArray(output.plan)) return null;
  const steps: RuntimePlanStep[] = [];
  for (const item of output.plan) {
    if (!isRecord(item)) continue;
    if (typeof item.step !== 'string' || item.step.trim().length === 0) continue;
    if (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed') continue;
    steps.push({
      step: item.step.trim(),
      status: item.status,
    });
  }
  if (steps.length === 0) return null;
  return {
    steps,
    explanation: typeof output.explanation === 'string' ? output.explanation : undefined,
    updatedAt: typeof output.updatedAt === 'string' ? output.updatedAt : undefined,
  };
}

function stringifyToolPayload(value: unknown, maxChars = 260): string | undefined {
  if (value === null || value === undefined) return undefined;
  let raw = '';
  if (typeof value === 'string') {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value, null, 2);
    } catch {
      raw = String(value);
    }
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}...` : trimmed;
}

function cleanTechnicalErrorText(raw: string): string {
  const normalized = raw
    .replace(/tool execution failed for [^:]+:\s*/ig, '')
    .replace(/\b(ENOENT|EACCES|ETIMEDOUT|ECONNREFUSED|EPIPE)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : '执行失败';
}

function humanizeToolError(toolName: string, rawError: unknown): string {
  const text = typeof rawError === 'string' ? rawError.trim() : '';
  if (text.length === 0) return `工具执行失败：${toolName}`;

  const spawnMissing = text.match(/spawn\s+([^\s]+)\s+enoent/i);
  if (spawnMissing) {
    return `工具执行失败：未找到可执行命令 ${spawnMissing[1]}`;
  }

  const lower = text.toLowerCase();
  if (lower.includes('permission denied') || lower.includes('eacces')) {
    return '工具执行失败：权限不足，当前环境不允许该操作';
  }
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) {
    return '工具执行失败：执行超时，请缩小范围后重试';
  }
  if (lower.includes('not found') || lower.includes('no such file') || lower.includes('enoent')) {
    return '工具执行失败：目标命令或文件不存在';
  }

  return `工具执行失败：${cleanTechnicalErrorText(text)}`;
}

function extractToolFailureText(output: unknown): string | undefined {
  if (typeof output === 'string' && output.trim().length > 0) {
    return output.trim();
  }
  if (!isRecord(output)) return undefined;

  if (typeof output.error === 'string' && output.error.trim().length > 0) {
    return output.error.trim();
  }
  if (isRecord(output.result)) {
    const nested = output.result;
    if (typeof nested.error === 'string' && nested.error.trim().length > 0) {
      return nested.error.trim();
    }
    if (typeof nested.stderr === 'string' && nested.stderr.trim().length > 0) {
      return nested.stderr.trim();
    }
  }
  if (typeof output.stderr === 'string' && output.stderr.trim().length > 0) {
    return output.stderr.trim();
  }

  return undefined;
}

function resolveToolResultStatus(output: unknown): 'success' | 'error' {
  if (!isRecord(output)) return 'success';
  if (typeof output.ok === 'boolean') return output.ok ? 'success' : 'error';
  if (typeof output.success === 'boolean') return output.success ? 'success' : 'error';
  if (typeof output.exitCode === 'number') return output.exitCode === 0 ? 'success' : 'error';

  if (isRecord(output.result)) {
    const result = output.result;
    if (typeof result.ok === 'boolean') return result.ok ? 'success' : 'error';
    if (typeof result.success === 'boolean') return result.success ? 'success' : 'error';
    if (typeof result.exitCode === 'number') return result.exitCode === 0 ? 'success' : 'error';
  }

  return 'success';
}

function buildHumanToolResultOutput(toolName: string, output: unknown): string | undefined {
  if (
    toolName !== 'shell.exec'
    && toolName !== 'exec_command'
    && toolName !== 'write_stdin'
    && toolName !== 'shell'
    && toolName !== 'shell_command'
  ) {
    return stringifyToolPayload(output, 1200);
  }

  if (!isRecord(output)) return stringifyToolPayload(output, 1200);
  const result = isRecord(output.result) ? output.result : output;
  const stdout = typeof result.stdout === 'string'
    ? result.stdout
    : typeof result.output === 'string'
      ? result.output
      : typeof result.text === 'string'
        ? result.text
        : '';
  const stderr = typeof result.stderr === 'string' ? cleanTechnicalErrorText(result.stderr) : '';

  const parts: string[] = [];
  if (stdout.trim().length > 0) {
    parts.push(`输出:\n${stdout.trim().slice(0, 2000)}`);
  }
  if (stderr.trim().length > 0) {
    parts.push(`提示:\n${stderr.trim().slice(0, 800)}`);
  }
  if (parts.length === 0) {
    return '命令已执行，无可展示输出。';
  }
  return parts.join('\n\n');
}

function buildToolResultContent(
  toolName: string,
  status: 'success' | 'error',
  duration?: number,
  errorText?: string,
  input?: unknown,
): string {
  const durationText = typeof duration === 'number' ? ` (${duration}ms)` : '';
  const summary = buildToolExecutionSummary(toolName, input);
  const summaryText = summary ? ` · ${summary}` : '';
  if (status === 'error') {
    return errorText ?? `工具执行失败：${toolName}${summaryText}${durationText}`;
  }
  return `工具执行成功：${toolName}${summaryText}${durationText}`;
}

function toSessionAttachments(images: RuntimeImage[], files: RuntimeFile[]): SessionApiAttachment[] {
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

function mapSessionMessageToRuntimeEvent(message: SessionApiMessage): RuntimeEvent {
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
    const agentId = message.role === 'orchestrator' ? 'orchestrator-loop' : DEFAULT_CHAT_AGENT_ID;
    return {
      id: message.id,
      role: 'agent',
      agentId,
      agentName: agentId,
      content: message.content,
      timestamp: message.timestamp,
      kind: 'observation',
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

function buildUserRoundsFromSessionMessages(messages: SessionApiMessage[]): UserRound[] {
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

function buildKernelInputItems(text: string, images: RuntimeImage[], files: RuntimeFile[]): KernelInputItem[] {
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

function normalizeReviewSettings(review: ReviewSettings | undefined): ReviewSettings | undefined {
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

function buildGatewayHistory(
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

function buildContextEditableEventIds(events: RuntimeEvent[], maxItems: number): string[] {
  return events
    .filter((event) => (event.role === 'user' || event.role === 'agent') && typeof event.id === 'string' && event.id.length > 0)
    .slice(-maxItems)
    .map((event) => event.id);
}

export function mapWsMessageToRuntimeEvent(
  msg: WsMessage,
  currentSessionId: string,
): (Omit<RuntimeEvent, 'id'> & { id?: string }) | null {
  const payload = isRecord(msg.payload) ? msg.payload : {};
  const eventSessionId =
    (typeof msg.sessionId === 'string' ? msg.sessionId : undefined) ||
    (typeof payload.sessionId === 'string' ? payload.sessionId : undefined);

  if (eventSessionId && eventSessionId !== currentSessionId && eventSessionId !== 'default') {
    return null;
  }

  const timestamp = typeof msg.timestamp === 'string' ? msg.timestamp : new Date().toISOString();
  const agentId =
    (typeof msg.agentId === 'string' ? msg.agentId : undefined) ||
    (typeof payload.agentId === 'string' ? payload.agentId : undefined);

  switch (msg.type) {
    case 'task_started':
    case 'task_completed':
    case 'task_failed':
      return null;
    case 'tool_call':
      return null;
    case 'tool_result':
      {
        const output = payload.output;
        const toolInput = payload.input;
        const toolName = resolveDisplayToolName(payload, toolInput, output);
        const toolId = typeof payload.toolId === 'string' ? payload.toolId : undefined;
        const duration = typeof payload.duration === 'number' ? payload.duration : undefined;
        const status = resolveToolResultStatus(output);
        const failureText = status === 'error'
          ? humanizeToolError(toolName, extractToolFailureText(output))
          : undefined;
        const humanOutput = status === 'error'
          ? (failureText ?? buildHumanToolResultOutput(toolName, output))
          : buildHumanToolResultOutput(toolName, output);

        if (toolName === 'view_image') {
          const image = parseViewImageOutput(output);
          if (image) {
            return {
              ...(toolId ? { id: `tool:${toolId}:result` } : {}),
              role: 'agent',
              agentId: agentId || DEFAULT_CHAT_AGENT_ID,
              agentName: agentId || DEFAULT_CHAT_AGENT_ID,
              kind: 'observation',
              toolName,
              toolStatus: 'success',
              toolDurationMs: duration,
              content: buildToolResultContent(toolName, 'success', duration, undefined, toolInput),
              timestamp,
              images: [image],
              ...(toolInput !== undefined ? { toolInput } : {}),
            };
          }
        }

        if (toolName === 'update_plan') {
          const planOutput = parseUpdatePlanOutput(output);
          if (planOutput) {
            return {
              ...(toolId ? { id: `tool:${toolId}:result` } : {}),
              role: 'agent',
              agentId: agentId || DEFAULT_CHAT_AGENT_ID,
              agentName: agentId || DEFAULT_CHAT_AGENT_ID,
              kind: 'observation',
              toolName,
              toolStatus: 'success',
              toolDurationMs: duration,
              content: buildToolResultContent(toolName, 'success', duration, undefined, toolInput),
              timestamp,
              planSteps: planOutput.steps,
              planExplanation: planOutput.explanation,
              planUpdatedAt: planOutput.updatedAt,
              ...(toolInput !== undefined ? { toolInput } : {}),
            };
          }
        }

        return {
          ...(toolId ? { id: `tool:${toolId}:result` } : {}),
          role: 'agent',
          agentId: agentId || DEFAULT_CHAT_AGENT_ID,
          agentName: agentId || DEFAULT_CHAT_AGENT_ID,
          kind: 'observation',
          toolName,
          toolStatus: status,
          toolOutput: humanOutput,
          toolDurationMs: duration,
          content: buildToolResultContent(toolName, status, duration, failureText, toolInput),
          ...(toolInput !== undefined ? { toolInput } : {}),
          ...(failureText ? { errorMessage: failureText } : {}),
          timestamp,
        };
      }
    case 'tool_error':
      {
        const toolName = resolveDisplayToolName(payload, payload.input, payload.output);
        const toolId = typeof payload.toolId === 'string' ? payload.toolId : undefined;
        const failureText = humanizeToolError(toolName, payload.error);
        return {
          ...(toolId ? { id: `tool:${toolId}:error` } : {}),
          role: 'agent',
          agentId: agentId || DEFAULT_CHAT_AGENT_ID,
          agentName: agentId || DEFAULT_CHAT_AGENT_ID,
          kind: 'observation',
          toolName,
          toolStatus: 'error',
          toolOutput: failureText,
          content: failureText,
          errorMessage: failureText,
          timestamp,
        };
      }
    case 'assistant_chunk':
      if (typeof payload.content !== 'string' || payload.content.length === 0) return null;
      return {
        role: 'agent',
        agentId: agentId || DEFAULT_CHAT_AGENT_ID,
        agentName: agentId || DEFAULT_CHAT_AGENT_ID,
        kind: 'observation',
        content: payload.content,
        timestamp,
      };
    case 'assistant_complete':
      return {
        role: 'agent',
        agentId: agentId || DEFAULT_CHAT_AGENT_ID,
        agentName: agentId || DEFAULT_CHAT_AGENT_ID,
        kind: 'status',
        content: typeof payload.content === 'string' ? payload.content : '回复完成',
        timestamp,
      };
    case 'workflow_progress':
      return {
        role: 'system',
        kind: 'status',
        content:
          typeof payload.overallProgress === 'number'
            ? `进度：${Math.round(payload.overallProgress)}%`
            : '工作流进度更新',
        timestamp,
      };
    case 'phase_transition':
      return {
        role: 'system',
        kind: 'status',
        content: `阶段切换：${String((payload as Record<string, unknown>).from ?? '?')} -> ${String(
          (payload as Record<string, unknown>).to ?? '?',
        )}`,
        timestamp,
      };
    case 'waiting_for_user':
      return {
        role: 'system',
        kind: 'status',
        content: `等待用户决策：${typeof payload.reason === 'string' ? payload.reason : '需要确认'}`,
        timestamp,
      };
    case 'user_decision_received':
      return {
        role: 'system',
        kind: 'status',
        content: '已接收用户决策',
        timestamp,
      };
    default:
      return null;
  }
}

function extractChatReply(result: unknown): { reply: string; agentId: string; tokenUsage?: RuntimeTokenUsage } {
  const candidate = isRecord(result) && isRecord(result.output) ? result.output : result;

  if (typeof candidate === 'string') {
    return { reply: candidate, agentId: DEFAULT_CHAT_AGENT_ID, tokenUsage: estimateTokenUsage(candidate) };
  }

  if (!isRecord(candidate)) {
    const reply = JSON.stringify(candidate);
    return { reply, agentId: DEFAULT_CHAT_AGENT_ID, tokenUsage: estimateTokenUsage(reply) };
  }

  const agentId = typeof candidate.module === 'string' ? candidate.module : DEFAULT_CHAT_AGENT_ID;
  if (candidate.success === false) {
    const error = typeof candidate.error === 'string' ? candidate.error : 'chat-codex request failed';
    throw new Error(error);
  }

  if (typeof candidate.response === 'string' && candidate.response.trim().length > 0) {
    return {
      reply: candidate.response,
      agentId,
      tokenUsage: parseTokenUsage(candidate) ?? estimateTokenUsage(candidate.response),
    };
  }

  if (typeof candidate.output === 'string' && candidate.output.trim().length > 0) {
    return {
      reply: candidate.output,
      agentId,
      tokenUsage: parseTokenUsage(candidate) ?? estimateTokenUsage(candidate.output),
    };
  }

  if (typeof candidate.error === 'string' && candidate.error.length > 0) {
    throw new Error(candidate.error);
  }

  const reply = JSON.stringify(candidate, null, 2);
  return { reply, agentId, tokenUsage: parseTokenUsage(candidate) ?? estimateTokenUsage(reply) };
}

function parseTokenUsage(candidate: Record<string, unknown>): RuntimeTokenUsage | undefined {
  const fromCandidate = normalizeTokenUsage(candidate);
  if (fromCandidate) return fromCandidate;
  if (isRecord(candidate.metadata)) {
    const fromMetadata = normalizeTokenUsage(candidate.metadata);
    if (fromMetadata) return fromMetadata;
  }
  return undefined;
}

function normalizeTokenUsage(source: Record<string, unknown>): RuntimeTokenUsage | undefined {
  const usage = isRecord(source.usage) ? source.usage : source;
  const prompt = parseNumberLike(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.inputTokens,
  );
  const completion = parseNumberLike(
    usage.completion_tokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.outputTokens,
  );
  const total = parseNumberLike(
    usage.total_tokens,
    usage.totalTokens,
  );

  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  return {
    ...(prompt !== undefined ? { inputTokens: prompt } : {}),
    ...(completion !== undefined ? { outputTokens: completion } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
    estimated: false,
  };
}

function parseNumberLike(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.round(value);
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return Math.round(parsed);
      }
    }
  }
  return undefined;
}

function estimateTokenUsage(text: string): RuntimeTokenUsage {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { totalTokens: 0, estimated: true };
  }
  const total = Math.max(1, Math.ceil(trimmed.length / 4));
  return { totalTokens: total, estimated: true };
}

function parseInputLockState(value: unknown): InputLockState | null {
  if (!isRecord(value)) return null;
  if (typeof value.sessionId !== 'string') return null;
  const lockedBy = typeof value.lockedBy === 'string' ? value.lockedBy : null;
  const lockedAt = typeof value.lockedAt === 'string' ? value.lockedAt : null;
  const typing = value.typing === true;
  const lastHeartbeatAt = typeof value.lastHeartbeatAt === 'string' ? value.lastHeartbeatAt : null;
  const expiresAt = typeof value.expiresAt === 'string' ? value.expiresAt : null;

  return {
    sessionId: value.sessionId,
    lockedBy,
    lockedAt,
    typing,
    lastHeartbeatAt,
    expiresAt,
  };
}

export function useWorkflowExecution(sessionId: string): UseWorkflowExecutionReturn {
  const [workflow, setWorkflow] = useState<WorkflowInfo | null>(null);
  const [executionState, setExecutionState] = useState<WorkflowExecutionState | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [userRounds, setUserRounds] = useState<UserRound[]>([]);
  const [executionRounds, setExecutionRounds] = useState<ExecutionRound[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<SessionLog[]>([]);
  const [agentRunStatus, setAgentRunStatus] = useState<AgentRunStatus>({
    phase: 'idle',
    text: '已就绪',
    updatedAt: new Date().toISOString(),
  });
  const executionStateRef = useRef<WorkflowExecutionState | null>(null);
  const runtimeEventsRef = useRef<RuntimeEvent[]>([]);

  useEffect(() => {
    executionStateRef.current = executionState;
  }, [executionState]);

  useEffect(() => {
    runtimeEventsRef.current = runtimeEvents;
  }, [runtimeEvents]);

  const handleWebSocketMessage = useCallback((msg: WsMessage) => {
    const payload = isRecord(msg.payload) ? msg.payload : {};
    const messageSessionId =
      (typeof msg.sessionId === 'string' ? msg.sessionId : undefined)
      ?? (typeof payload.sessionId === 'string' ? payload.sessionId : undefined);
    const isCurrentSessionEvent =
      !messageSessionId || messageSessionId === sessionId || messageSessionId === 'default';

    if (msg.type === 'chat_codex_turn') {
      if (!isCurrentSessionEvent) return;
      const phase = typeof payload.phase === 'string' ? payload.phase : 'kernel_event';
      const mode = typeof payload.mode === 'string' ? payload.mode : 'main';
      const reviewIteration = typeof payload.reviewIteration === 'number' ? payload.reviewIteration : undefined;
      const label = mode === 'review'
        ? `Review 回合${typeof reviewIteration === 'number' ? ` #${reviewIteration}` : ''}`
        : '主回合';
      if (phase === 'turn_start') {
        setAgentRunStatus({
          phase: 'running',
          text: `${label}开始执行...`,
          updatedAt: new Date().toISOString(),
        });
      } else if (phase === 'kernel_event' && payload.type === 'task_started') {
        const modelContextWindow =
          typeof payload.modelContextWindow === 'number' && Number.isFinite(payload.modelContextWindow)
            ? Math.max(0, Math.floor(payload.modelContextWindow))
            : undefined;
        setAgentRunStatus({
          phase: 'running',
          text: modelContextWindow
            ? `${label}开始执行... 上下文窗口 ${modelContextWindow} tokens`
            : `${label}开始执行...`,
          updatedAt: new Date().toISOString(),
        });
      } else if (phase === 'kernel_event' && payload.type === 'model_round') {
        const round = typeof payload.round === 'number' && Number.isFinite(payload.round)
          ? Math.floor(payload.round)
          : undefined;
        if (round && round > 0) {
          const finishReason = typeof payload.finishReason === 'string' ? payload.finishReason.trim() : '';
          const contextUsagePercent =
            typeof payload.contextUsagePercent === 'number' && Number.isFinite(payload.contextUsagePercent)
              ? Math.max(0, Math.floor(payload.contextUsagePercent))
              : undefined;
          const estimatedTokensInContextWindow =
            typeof payload.estimatedTokensInContextWindow === 'number' && Number.isFinite(payload.estimatedTokensInContextWindow)
              ? Math.max(0, Math.floor(payload.estimatedTokensInContextWindow))
              : undefined;
          const maxInputTokens =
            typeof payload.maxInputTokens === 'number' && Number.isFinite(payload.maxInputTokens)
              ? Math.max(0, Math.floor(payload.maxInputTokens))
              : undefined;
          const thresholdPercent =
            typeof payload.thresholdPercent === 'number' && Number.isFinite(payload.thresholdPercent)
              ? Math.max(0, Math.floor(payload.thresholdPercent))
              : undefined;
          const fragments: string[] = [];
          if (finishReason.length > 0) {
            fragments.push(`finish=${finishReason}`);
          }
          if (contextUsagePercent !== undefined) {
            if (estimatedTokensInContextWindow !== undefined && maxInputTokens !== undefined && maxInputTokens > 0) {
              fragments.push(`上下文 ${contextUsagePercent}% (${estimatedTokensInContextWindow}/${maxInputTokens})`);
            } else {
              fragments.push(`上下文 ${contextUsagePercent}%`);
            }
          }
          if (
            thresholdPercent !== undefined
            && contextUsagePercent !== undefined
            && contextUsagePercent >= thresholdPercent
          ) {
            fragments.push('接近上下文阈值');
          }
          setAgentRunStatus({
            phase: 'running',
            text: `${label}内部循环第 ${round} 轮${fragments.length > 0 ? ` · ${fragments.join(' · ')}` : ''}`,
            updatedAt: new Date().toISOString(),
          });
        }
      } else if (phase === 'turn_complete') {
        setAgentRunStatus({
          phase: 'running',
          text: `${label}完成，等待下一步...`,
          updatedAt: new Date().toISOString(),
        });
      } else if (phase === 'turn_error') {
        setAgentRunStatus({
          phase: 'error',
          text: `${label}执行失败`,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }

    if (msg.type === 'tool_call') {
      if (!isCurrentSessionEvent) return;
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
      setAgentRunStatus({
        phase: 'running',
        text: `正在执行工具：${toolName}`,
        updatedAt: new Date().toISOString(),
      });
    } else if (msg.type === 'tool_result') {
      if (!isCurrentSessionEvent) return;
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
      setAgentRunStatus({
        phase: 'running',
        text: `工具完成：${toolName}，继续处理中...`,
        updatedAt: new Date().toISOString(),
      });
    } else if (msg.type === 'tool_error') {
      if (!isCurrentSessionEvent) return;
      const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
      setAgentRunStatus({
        phase: 'error',
        text: `工具失败：${toolName}`,
        updatedAt: new Date().toISOString(),
      });
    } else if (msg.type === 'assistant_complete') {
      setAgentRunStatus({
        phase: 'idle',
        text: '本轮已完成',
        updatedAt: new Date().toISOString(),
      });
    }

    if (msg.type === 'workflow_update') {
      const workflowPayload = msg.payload as WorkflowUpdatePayload;

      if (workflowPayload.taskUpdates && workflowPayload.taskUpdates.length > 0) {
        setExecutionRounds(buildExecutionRoundsFromTasks(workflowPayload.taskUpdates));
      }
      setExecutionState((prev) => {
        if (!prev || prev.workflowId !== workflowPayload.workflowId) return prev;
        return {
          ...prev,
          status: workflowPayload.status,
          orchestrator: workflowPayload.orchestratorState
            ? {
                ...prev.orchestrator,
                currentRound: workflowPayload.orchestratorState.round,
                thought: workflowPayload.orchestratorState.thought,
              }
            : prev.orchestrator,
          tasks: workflowPayload.taskUpdates || prev.tasks,
          agents: workflowPayload.agentUpdates || prev.agents,
          executionPath: workflowPayload.executionPath || prev.executionPath,
          userInput: workflowPayload.userInput || prev.userInput,
          paused: workflowPayload.status === 'paused' ? true : workflowPayload.status === 'executing' ? false : prev.paused,
        };
      });
      // workflow_update 只用于状态更新，不再生成会话面板占位消息
      return;
    }

    if (msg.type === 'agent_update') {
      const payload = msg.payload as AgentUpdatePayload;
      setExecutionState((prev) => {
        if (!prev) return prev;
        const updatedAgents = prev.agents.map((agent) =>
          agent.id === payload.agentId
            ? {
                ...agent,
                status: payload.status,
                currentTaskId: payload.currentTaskId,
                load: payload.load,
              }
            : agent,
        );
        // 当新 agent 出现时添加到列表
        if (!updatedAgents.some((agent) => agent.id === payload.agentId)) {
          updatedAgents.push({
            id: payload.agentId,
            name: payload.agentId,
            type: inferAgentType(payload.agentId),
            status: payload.status,
            load: payload.load || 0,
            errorRate: 0,
            requestCount: 0,
            tokenUsage: 0,
            currentTaskId: payload.currentTaskId,
          });
        }
        return { ...prev, agents: updatedAgents };
      });

      setRuntimeEvents((prev) => {
        const event: Omit<RuntimeEvent, 'id'> = {
          role: 'agent',
          agentId: payload.agentId,
          agentName: executionStateRef.current?.agents.find(a => a.id === payload.agentId)?.name ?? payload.agentId,
          kind: payload.step?.thought ? 'thought' : payload.step?.action ? 'action' : 'status',
          content: payload.step?.thought
            ? payload.step.thought
            : payload.step?.action
              ? `${payload.step.action}${payload.step.observation ? ` -> ${payload.step.observation}` : ''}`
            : `状态 ${payload.status}${payload.currentTaskId ? `，任务 ${payload.currentTaskId}` : ''}`,
          timestamp: new Date().toISOString(),
        };
        return upsertAgentRuntimeEvent(prev, event);
      });
      return;
    }

    // 处理输入锁事件
    if (msg.type === 'input_lock_changed') {
      const lockPayload = parseInputLockState(msg.payload);
      if (lockPayload) {
        setInputLockState(lockPayload);
      }
      return;
    }

    if (msg.type === 'typing_indicator') {
      // 更新正在输入状态，但不改变锁持有者
      const typingPayload = isRecord(msg.payload) ? msg.payload : null;
      const typingClientId = typingPayload && typeof typingPayload.clientId === 'string' ? typingPayload.clientId : '';
      const typing = typingPayload ? typingPayload.typing === true : false;
      setInputLockState((prev) => {
        if (!prev || prev.lockedBy !== typingClientId) return prev;
        return { ...prev, typing };
      });
      return;
    }

    if (msg.type === 'input_lock_heartbeat_ack') {
      if (msg.sessionId !== sessionId) return;
      if (msg.alive === false) {
        setInputLockState((prev) => {
          if (!prev) return prev;
          return {
            sessionId: prev.sessionId,
            lockedBy: null,
            lockedAt: null,
            typing: false,
            lastHeartbeatAt: null,
            expiresAt: null,
          };
        });
        return;
      }
      const nextState = parseInputLockState(msg.state);
      if (nextState) {
        setInputLockState(nextState);
      }
      return;
    }

    const runtimeEvent = mapWsMessageToRuntimeEvent(msg, sessionId);
    if (!runtimeEvent) return;
    setRuntimeEvents((prev) => pushEvent(prev, runtimeEvent));
  }, [sessionId]);

  const { isConnected, getClientId, send: sendWs } = useWebSocket(handleWebSocketMessage);

  // 输入锁状态
  const [inputLockState, setInputLockState] = useState<InputLockState | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const lockHeartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lockAcquireTokenRef = useRef(0);

  const stopLockHeartbeat = useCallback(() => {
    if (lockHeartbeatTimerRef.current) {
      clearInterval(lockHeartbeatTimerRef.current);
      lockHeartbeatTimerRef.current = null;
    }
  }, []);

  const startLockHeartbeat = useCallback(() => {
    if (!sessionId || !clientId) return;
    stopLockHeartbeat();
    lockHeartbeatTimerRef.current = setInterval(() => {
      sendWs({ type: 'input_lock_heartbeat', sessionId });
    }, 8000);
  }, [clientId, sendWs, sessionId, stopLockHeartbeat]);

  // 更新 clientId
  useEffect(() => {
    const id = getClientId();
    if (id && id !== clientId) {
      setClientId(id);
    }
  }, [getClientId, clientId, isConnected]);

  // 查询初始锁状态
  useEffect(() => {
    if (!sessionId || !isConnected) return;
    fetch(`/api/v1/input-lock/${sessionId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.state) {
          setInputLockState(data.state);
        }
      })
      .catch(() => {});
  }, [sessionId, isConnected]);

  // 锁状态变化时自动启动/停止心跳
  useEffect(() => {
    if (inputLockState?.lockedBy && clientId && inputLockState.lockedBy === clientId) {
      startLockHeartbeat();
      return;
    }
    stopLockHeartbeat();
  }, [clientId, inputLockState?.lockedBy, startLockHeartbeat, stopLockHeartbeat]);

  useEffect(() => {
    return () => stopLockHeartbeat();
  }, [stopLockHeartbeat]);

  // 获取输入锁
  const acquireInputLock = useCallback(async (): Promise<boolean> => {
    if (!isConnected || !sessionId) return false;
    const acquireToken = ++lockAcquireTokenRef.current;
    return new Promise((resolve) => {
      const handler = (msg: WsMessage) => {
        if (msg.type === 'input_lock_result') {
          if (msg.sessionId !== sessionId) return;
          if (typeof msg.acquired !== 'boolean') return;
          if (acquireToken !== lockAcquireTokenRef.current) return;

          unsubscribe();
          if (timeoutHandle) clearTimeout(timeoutHandle);

          if (msg.acquired) {
            const next = parseInputLockState(msg.state) ?? {
              sessionId,
              lockedBy: clientId,
              lockedAt: new Date().toISOString(),
              typing: true,
              lastHeartbeatAt: new Date().toISOString(),
              expiresAt: null,
            };
            setInputLockState(next);
            sendWs({ type: 'typing_indicator', sessionId, typing: true });
            startLockHeartbeat();
          }
          resolve(msg.acquired);
        }
      };

      // 临时订阅
      const wsClient = getWebSocket();
      const unsubscribe = wsClient.onMessage(handler);
      sendWs({ type: 'input_lock_acquire', sessionId });

      // 超时处理
      const timeoutHandle = setTimeout(() => {
        unsubscribe();
        resolve(false);
      }, 5000);
    });
  }, [isConnected, sessionId, clientId, sendWs, startLockHeartbeat]);

  // 释放输入锁
  const releaseInputLock = useCallback(() => {
    if (!sessionId) return;
    stopLockHeartbeat();
    sendWs({ type: 'typing_indicator', sessionId, typing: false });
    sendWs({ type: 'input_lock_release', sessionId });
    setInputLockState((prev) => {
      if (prev?.lockedBy === clientId) {
        return {
          sessionId,
          lockedBy: null,
          lockedAt: null,
          typing: false,
          lastHeartbeatAt: null,
          expiresAt: null,
        };
      }
      return prev;
    });
  }, [sessionId, clientId, sendWs, stopLockHeartbeat]);

  const loadSessionMessages = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/sessions/${sessionId}/messages?limit=${SESSION_MESSAGES_FETCH_LIMIT}`);
      if (!response.ok) return;

      const payload = (await response.json()) as { success?: boolean; messages?: SessionApiMessage[] };
      if (!payload.success || !Array.isArray(payload.messages)) return;

      const sortedMessages = payload.messages
        .slice()
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      const mappedEvents = sortedMessages.map(mapSessionMessageToRuntimeEvent);
      setRuntimeEvents(mappedEvents);
      setUserRounds(buildUserRoundsFromSessionMessages(sortedMessages));
    } catch {
      // keep current UI state if load fails
    }
  }, [sessionId]);

  const appendSessionMessage = useCallback(
    async (
      role: SessionApiMessage['role'],
      content: string,
      images: RuntimeImage[] = [],
      files: RuntimeFile[] = [],
    ): Promise<SessionApiMessage | null> => {
      const attachments = toSessionAttachments(images, files);
      const response = await fetch(`/api/v1/sessions/${sessionId}/messages/append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role,
          content,
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { success?: boolean; message?: SessionApiMessage };
      if (!payload.success || !payload.message) return null;
      return payload.message;
    },
    [sessionId],
  );

  const patchSessionMessage = useCallback(async (messageId: string, content: string): Promise<boolean> => {
    const response = await fetch(`/api/v1/sessions/${sessionId}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return response.ok;
  }, [sessionId]);

  const removeSessionMessage = useCallback(async (messageId: string): Promise<boolean> => {
    const response = await fetch(`/api/v1/sessions/${sessionId}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
    return response.ok;
  }, [sessionId]);

  useEffect(() => {
    setRuntimeEvents([]);
    setUserRounds([]);
    setAgentRunStatus({
      phase: 'idle',
      text: '已就绪',
      updatedAt: new Date().toISOString(),
    });
    void loadSessionMessages();
  }, [loadSessionMessages]);

  const refreshRuntimeState = useCallback(async () => {
    try {
      const [workflowsRes, logsRes] = await Promise.all([
        fetch('/api/v1/workflows'),
        fetch('/api/v1/execution-logs'),
      ]);

      if (!workflowsRes.ok || !logsRes.ok) {
        return;
      }

      const workflows = (await workflowsRes.json()) as WorkflowInfo[];
      const logsPayload = (await logsRes.json()) as { success: boolean; logs: SessionLog[] };
      const allLogs = logsPayload.success ? logsPayload.logs : [];
      setLogs(allLogs);

      const preferredWorkflowId = executionStateRef.current?.workflowId || workflow?.id;
      const selectedWorkflow = pickWorkflowForSession(workflows, sessionId, preferredWorkflowId);
      
      // Always set workflow state, even if empty
      setWorkflow(selectedWorkflow);
      
      if (!selectedWorkflow) {
        // No workflow found - show empty state with default orchestrator agent
        setExecutionState({
          workflowId: `empty-${sessionId}`,
          status: 'planning',
          orchestrator: {
            id: 'orchestrator-loop',
            currentRound: 0,
            maxRounds: 10,
          },
          agents: [{
            id: 'orchestrator-loop',
            name: 'orchestrator-loop',
            type: 'orchestrator',
            status: 'idle',
            load: 0,
            errorRate: 0,
            requestCount: 0,
            tokenUsage: 0,
          }],
          tasks: [],
          executionPath: [],
          paused: false,
          executionRounds: [],
        });
        return;
      }

      const tasksRes = await fetch(`/api/v1/workflows/${selectedWorkflow.id}/tasks`);
      const taskList = tasksRes.ok ? ((await tasksRes.json()) as TaskNode[]) : [];

      const latestByAgent = new Map<string, SessionLog>();
      for (const log of allLogs) {
        const existing = latestByAgent.get(log.agentId);
        if (!existing || new Date(log.startTime).getTime() > new Date(existing.startTime).getTime()) {
          latestByAgent.set(log.agentId, log);
        }
      }

      const agentsFromLogs: AgentRuntime[] = Array.from(latestByAgent.values()).map((log) => {
        const currentRound = log.iterations.length;
        const load = computeAgentLoadFromLog(log);

        return {
          id: log.agentId,
          name: log.agentId,
          type: inferAgentType(log.agentId),
          status: inferAgentStatus(log),
          load,
          errorRate: log.finalError ? 100 : 0,
          requestCount: currentRound,
          tokenUsage: 0,
          currentTaskId: log.taskId,
        };
      });

      const assigneeSet = new Set(taskList.map((task) => task.assignee).filter((v): v is string => Boolean(v)));
      const agentsWithAssignees = [...agentsFromLogs];
      for (const assignee of assigneeSet) {
        if (!agentsWithAssignees.some((agent) => agent.id === assignee)) {
          agentsWithAssignees.push({
            id: assignee,
            name: assignee,
            type: inferAgentType(assignee),
            status: 'idle',
            load: 0,
            errorRate: 0,
            requestCount: 0,
            tokenUsage: 0,
          });
        }
      }

      if (!agentsWithAssignees.some((agent) => agent.type === 'orchestrator')) {
        agentsWithAssignees.push({
          id: 'orchestrator-loop',
          name: 'orchestrator-loop',
          type: 'orchestrator',
          status: selectedWorkflow.status === 'failed' ? 'error' : selectedWorkflow.status === 'paused' ? 'paused' : 'running',
          load: 0,
          errorRate: 0,
          requestCount: 0,
          tokenUsage: 0,
        });
      }

      const orchestratorLog = Array.from(latestByAgent.values())
        .filter((log) => inferAgentType(log.agentId) === 'orchestrator')
        .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())[0];

      const executionPath = buildRoundExecutionPath(taskList, 'orchestrator-loop');

      setExecutionState((prev) => ({
        workflowId: selectedWorkflow.id,
        status: selectedWorkflow.status,
        orchestrator: {
          id: 'orchestrator-loop',
          currentRound: orchestratorLog?.iterations.length || prev?.orchestrator.currentRound || 0,
          maxRounds: Math.max(orchestratorLog?.totalRounds || 10, 1),
          thought: orchestratorLog?.iterations[orchestratorLog.iterations.length - 1]?.thought,
        },
        agents: agentsWithAssignees,
        tasks: taskList,
        executionPath,
        paused: selectedWorkflow.status === 'paused',
        userInput: prev?.userInput,
        executionRounds: prev?.executionRounds || [],
      }));

      // 根据任务状态构建执行轮次并更新状态
      const rounds = buildExecutionRoundsFromTasks(taskList);
      setExecutionRounds(rounds);
    } catch {
      // keep current UI state if polling fails
    }
  }, [sessionId, workflow?.id]);

  useEffect(() => {
    void refreshRuntimeState();
    const timer = setInterval(() => {
      void refreshRuntimeState();
    }, 3000);
    return () => clearInterval(timer);
  }, [refreshRuntimeState]);

  const startWorkflow = useCallback(
    async (userTask: string) => {
      setIsLoading(true);
      setError(null);

      try {
        const res = await fetch('/api/v1/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target: 'orchestrator-loop',
            message: { content: userTask, sessionId },
            blocking: false,
          }),
        });

        if (!res.ok) {
          throw new Error(`Failed to start workflow: ${res.status}`);
        }

        setExecutionState({
          workflowId: workflow?.id || `pending-${Date.now()}`,
          status: 'planning',
          orchestrator: {
            id: 'orchestrator-loop',
            currentRound: 0,
            maxRounds: 10,
          },
          agents: [
            {
              id: 'orchestrator-loop',
              name: 'orchestrator-loop',
              type: 'orchestrator',
              status: 'running',
              load: 1,
              errorRate: 0,
              requestCount: 0,
              tokenUsage: 0,
            },
          ],
          tasks: [],
          executionPath: [],
          paused: false,
          executionRounds: [],
        });

        await refreshRuntimeState();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to start workflow');
      } finally {
        setIsLoading(false);
      }
    },
    [refreshRuntimeState, sessionId, workflow?.id],
  );

  const pauseWorkflow = useCallback(async () => {
    if (!executionState) return;

    try {
      await fetch('/api/v1/workflow/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: executionState.workflowId,
          hard: true,
        }),
      });

      setRuntimeEvents((prev) =>
        pushEvent(prev, {
          role: 'system',
          kind: 'status',
          content: '执行已暂停',
          timestamp: new Date().toISOString(),
        }),
      );

      setExecutionState((prev) => (prev ? { ...prev, paused: true, status: 'paused' } : prev));
    } catch {
      // ignore pause failure in UI
    }
  }, [executionState]);

  const resumeWorkflow = useCallback(async () => {
    if (!executionState) return;

    try {
      await fetch('/api/v1/workflow/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: executionState.workflowId,
        }),
      });

      setRuntimeEvents((prev) =>
        pushEvent(prev, {
          role: 'system',
          kind: 'status',
          content: '执行已恢复',
          timestamp: new Date().toISOString(),
        }),
      );

      setExecutionState((prev) => (prev ? { ...prev, paused: false, status: 'executing' } : prev));
    } catch {
      // ignore resume failure in UI
    }
  }, [executionState]);

const sendUserInput = useCallback(
  async (inputPayload: UserInputPayload) => {
    const text = inputPayload.text.trim();
    const images = inputPayload.images ?? [];
    const files = inputPayload.files ?? [];
    const review = normalizeReviewSettings(inputPayload.review);
    if (!text && images.length === 0 && files.length === 0) return;
    const inputItems = buildKernelInputItems(text, images, files);
    const displayText = text || (images.length > 0 || files.length > 0 ? '[附件输入]' : '');

    const eventTime = new Date().toISOString();
    const roundId = `user-round-${Date.now()}`;
    const pendingUserEvent: Omit<RuntimeEvent, 'id'> = {
      role: 'user',
      content: displayText,
      images,
      files,
      timestamp: eventTime,
      kind: 'status',
      agentId: 'pending',
      tokenUsage: estimateTokenUsage(displayText),
    };

    // 1. 先本地插入 pending 状态的用户事件（立即可见）
    setRuntimeEvents((prev) => pushEvent(prev, pendingUserEvent));

    // 2. 同步更新用户轮次
    setUserRounds((prev) => [
      ...prev,
      {
        roundId,
        timestamp: eventTime,
        summary: text ? (text.length > 24 ? `${text.slice(0, 24)}...` : text) : '[附件输入]',
        fullText: text,
        images,
        files,
      },
    ]);

    setAgentRunStatus({
      phase: 'running',
      text: review
        ? `chat-codex 正在思考（Review: ${review.strictness === 'strict' ? '严格' : '主线'}, 上限 ${review.maxTurns}）...`
        : 'chat-codex 正在思考...',
      updatedAt: new Date().toISOString(),
    });

    // 3. 统一走 chat-codex gateway
    try {
      const history = buildGatewayHistory(
        [
          ...runtimeEventsRef.current,
          {
            id: `${eventTime}-pending-local`,
            ...pendingUserEvent,
          },
        ],
        CONTEXT_HISTORY_WINDOW_SIZE,
      );

      const res = await fetch('/api/v1/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          target: CHAT_PANEL_TARGET,
          blocking: true,
          message: {
            text: displayText,
            sessionId,
            history,
            deliveryMode: 'sync',
            metadata: {
              inputItems,
              ...(review
                ? {
                    review,
                  }
                : {}),
            },
          },
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const responseData = (await res.json()) as { result?: unknown; error?: string } | null;
      if (!responseData || responseData.error) {
        throw new Error(responseData?.error || 'Empty response from daemon');
      }
      const { reply, agentId, tokenUsage } = extractChatReply(responseData.result);
      let persistedUserMessage: SessionApiMessage | null = null;
      let persistedAssistantMessage: SessionApiMessage | null = null;

      try {
        persistedUserMessage = await appendSessionMessage('user', displayText, images, files);
        persistedAssistantMessage = await appendSessionMessage('assistant', reply);
      } catch {
        // keep conversation running even if session persistence fails
      }

      const assistantEvent: Omit<RuntimeEvent, 'id'> & { id?: string } = {
        ...(persistedAssistantMessage?.id ? { id: persistedAssistantMessage.id } : {}),
        role: 'agent',
        agentId,
        agentName: agentId,
        content: reply,
        timestamp: persistedAssistantMessage?.timestamp ?? new Date().toISOString(),
        kind: 'observation',
        tokenUsage,
      };

      setRuntimeEvents((prev) =>
        prev
          .map((e) =>
            e.role === 'user' && e.timestamp === eventTime
              ? {
                  ...e,
                  ...(persistedUserMessage?.id ? { id: persistedUserMessage.id } : {}),
                  ...(persistedUserMessage?.timestamp ? { timestamp: persistedUserMessage.timestamp } : {}),
                  agentId: 'confirmed',
                }
              : e,
          ),
      );

      setRuntimeEvents((prev) => pushEvent(prev, assistantEvent));

      setExecutionState((prev) => (prev ? { ...prev, userInput: displayText } : prev));
      setAgentRunStatus({
        phase: 'idle',
        text: '本轮已完成',
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      // 6. API 失败：更新事件为 error 并追加错误事件
      setRuntimeEvents((prev) =>
        prev
          .map((e) =>
            e.role === 'user' && e.timestamp === eventTime
              ? { ...e, agentId: 'error', kind: 'status', errorMessage: err instanceof Error ? err.message : '发送失败' }
              : e,
          ),
      );

      const errorMsg = err instanceof Error ? err.message : '发送失败';
      setAgentRunStatus({
        phase: 'error',
        text: `执行失败：${errorMsg}`,
        updatedAt: new Date().toISOString(),
      });
      setRuntimeEvents((prev) =>
        pushEvent(prev, {
          role: 'system',
          content: `发送失败：${errorMsg}`,
          timestamp: new Date().toISOString(),
          kind: 'status',
          agentId: 'error',
        }),
      );
    }
  },
  [appendSessionMessage, sessionId],
);

const editRuntimeEvent = useCallback(async (eventId: string, content: string): Promise<boolean> => {
  const normalized = content.trim();
  if (normalized.length === 0) {
    return false;
  }

  const current = runtimeEventsRef.current.find((event) => event.id === eventId);
  if (!current || (current.role !== 'user' && current.role !== 'agent')) {
    return false;
  }

  const previousContent = current.content;
  setRuntimeEvents((prev) => prev.map((event) => (event.id === eventId ? { ...event, content: normalized } : event)));

  if (!isPersistedSessionMessageId(eventId)) {
    return true;
  }

  const updated = await patchSessionMessage(eventId, normalized);
  if (!updated) {
    setRuntimeEvents((prev) => prev.map((event) => (event.id === eventId ? { ...event, content: previousContent } : event)));
    return false;
  }
  return true;
}, [patchSessionMessage]);

const deleteRuntimeEvent = useCallback(async (eventId: string): Promise<boolean> => {
  const current = runtimeEventsRef.current.find((event) => event.id === eventId);
  if (!current || (current.role !== 'user' && current.role !== 'agent')) {
    return false;
  }

  setRuntimeEvents((prev) => prev.filter((event) => event.id !== eventId));
  if (!isPersistedSessionMessageId(eventId)) {
    return true;
  }

  const deleted = await removeSessionMessage(eventId);
  if (!deleted) {
    setRuntimeEvents((prev) => pushEvent(prev, current));
    return false;
  }
  return true;
}, [removeSessionMessage]);

const contextEditableEventIds = buildContextEditableEventIds(
  runtimeEvents,
  CONTEXT_HISTORY_WINDOW_SIZE,
);

  const getAgentDetail = useCallback(
    (agentId: string): AgentExecutionDetail | null => {
      const latestLog = logs
        .filter((log) => log.agentId === agentId)
        .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())[0];

      const agent = executionState?.agents.find((a) => a.id === agentId);
      if (!agent && !latestLog) return null;

      return {
        agentId,
        agentName: agent?.name || agentId,
        taskId: latestLog?.taskId,
        taskDescription: latestLog?.userTask,
        status: agent?.status || (latestLog ? inferAgentStatus(latestLog) : 'idle'),
        steps: (latestLog?.iterations || []).map((iteration) => ({
          round: iteration.round,
          action: iteration.action,
          thought: iteration.thought,
          params: iteration.params,
          observation: iteration.observation,
          success: iteration.success,
          timestamp: iteration.timestamp,
          duration: iteration.duration,
        })),
        currentRound: latestLog?.iterations.length || 0,
        totalRounds: latestLog?.totalRounds || latestLog?.iterations.length || 0,
        startTime: latestLog?.startTime || new Date().toISOString(),
        endTime: latestLog?.endTime,
      };
    },
    [executionState, logs],
  );

  const getTaskReport = useCallback((): TaskReport | null => {
    if (!workflow || !executionState) return null;

    const completedTasks = executionState.tasks.filter((t) => t.status === 'completed');
    const failedTasks = executionState.tasks.filter((t) => t.status === 'failed');

    return {
      workflowId: executionState.workflowId,
      epicId: workflow.epicId,
      userTask: workflow.userTask,
      status: executionState.status,
      summary: {
        totalTasks: executionState.tasks.length,
        completed: completedTasks.length,
        failed: failedTasks.length,
        success: failedTasks.length === 0 && completedTasks.length === executionState.tasks.length,
        rounds: executionState.orchestrator.currentRound,
        duration: 0,
      },
      taskDetails: executionState.tasks.map((task) => ({
        taskId: task.id,
        description: task.description,
        status: task.status,
        assignee: task.assignee,
        output: task.result?.output,
        error: task.result?.error,
      })),
      createdAt: workflow.createdAt,
      completedAt:
        executionState.status === 'completed' || executionState.status === 'failed'
          ? new Date().toISOString()
          : undefined,
    };
  }, [workflow, executionState]);

 return {
   workflow,
   executionState,
   runtimeEvents,
   userRounds,
   executionRounds,
   selectedAgentId,
   setSelectedAgentId,
   isLoading,
   error,
   startWorkflow,
   pauseWorkflow,
   resumeWorkflow,
   sendUserInput,
   editRuntimeEvent,
   deleteRuntimeEvent,
   agentRunStatus,
   contextEditableEventIds,
   getAgentDetail,
   getTaskReport,
   isConnected,
   inputLockState,
   clientId,
   acquireInputLock,
   releaseInputLock,
 };
}

function buildExecutionRoundsFromTasks(
  tasks: TaskNode[],
): ExecutionRound[] {
  const roundMap = new Map<string, ExecutionRound>();

  for (const task of tasks) {
    const roundKey = `round-${task.id.split('-')[0] || '0'}`;
    if (!roundMap.has(roundKey)) {
      roundMap.set(roundKey, {
        roundId: roundKey,
        timestamp: task.startedAt || new Date().toISOString(),
        agents: [],
        edges: [],
      });
    }

    const round = roundMap.get(roundKey)!;
    const agentInfo: AgentRoundInfo = {
      agentId: task.assignee || 'executor-loop',
      status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'error' : task.status === 'in_progress' ? 'running' : 'idle',
      taskId: task.id,
      taskDescription: task.description,
    };
    if (!round.agents.some((a) => a.agentId === agentInfo.agentId)) {
      round.agents.push(agentInfo);
    }

    const edgeInfo: RoundEdgeInfo = {
      from: 'orchestrator-loop',
      to: task.assignee || 'executor-loop',
      status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'error' : task.status === 'in_progress' ? 'active' : 'pending',
      message: `${task.id}: ${task.description.slice(0, 32)}`,
    };
    if (!round.edges.some((e) => e.to === edgeInfo.to && e.from === edgeInfo.from)) {
      round.edges.push(edgeInfo);
    }
  }

  return Array.from(roundMap.values()).sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}
