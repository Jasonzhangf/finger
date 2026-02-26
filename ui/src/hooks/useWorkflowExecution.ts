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

interface RuntimeOverview {
  reqTokens?: number;
  respTokens?: number;
  totalTokens?: number;
  tokenUpdatedAtLocal?: string;
  contextUsagePercent?: number;
  contextTokensInWindow?: number;
  contextMaxInputTokens?: number;
  contextThresholdPercent?: number;
  ledgerFocusMaxChars: number;
  lastLedgerInsertChars?: number;
  compactCount: number;
  updatedAt: string;
}

interface ToolPanelOverview {
  availableTools: string[];
  exposedTools: string[];
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
  interruptCurrentTurn: () => Promise<boolean>;
  sendUserInput: (input: UserInputPayload) => Promise<void>;
  editRuntimeEvent: (eventId: string, content: string) => Promise<boolean>;
  deleteRuntimeEvent: (eventId: string) => Promise<boolean>;
  agentRunStatus: AgentRunStatus;
  runtimeOverview: RuntimeOverview;
  toolPanelOverview: ToolPanelOverview;
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

const DEFAULT_LEDGER_FOCUS_MAX_CHARS = 20_000;
const SEND_RETRY_MAX_ATTEMPTS = 6;
const SEND_RETRY_BASE_DELAY_MS = 800;
type ToolCategoryLabel = '编辑' | '读取' | '写入' | '计划' | '搜索' | '网络搜索' | '其他';

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

function parseJsonObjectString(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function looksLikeExecOutput(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.exitCode === 'number') return true;
  if (isRecord(value.termination) && typeof value.termination.type === 'string') return true;
  if (typeof value.wall_time_seconds === 'number') return true;
  if (typeof value.text === 'string' && value.text.includes('Process exited with code')) return true;
  return false;
}

function unwrapToolPayload(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (isRecord(value.input)) return value.input;
  if (isRecord(value.args)) return value.args;
  if (typeof value.arguments === 'string') {
    const parsed = parseJsonObjectString(value.arguments);
    if (parsed) return parsed;
  }
  return value;
}

function normalizeToolName(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return 'unknown';
  if (
    normalized === 'shell'
    || normalized === 'shell.exec'
    || normalized === 'shell_command'
    || normalized === 'local_shell'
    || normalized === 'unified_exec'
  ) {
    return 'exec_command';
  }
  if (normalized === 'web_search_request') return 'web_search';
  return normalized;
}

function inferToolName(input?: unknown, output?: unknown): string | undefined {
  const normalizedInputRaw = unwrapToolPayload(input);
  const normalizedInput = typeof normalizedInputRaw === 'string'
    ? parseJsonObjectString(normalizedInputRaw) ?? normalizedInputRaw
    : normalizedInputRaw;
  if (isRecord(normalizedInput)) {
    if (typeof normalizedInput.cmd === 'string') return 'exec_command';
    if (typeof normalizedInput.command === 'string') return 'exec_command';
    if (Array.isArray(normalizedInput.command) && normalizedInput.command.length > 0) return 'exec_command';
    if (
      typeof normalizedInput.chars === 'string' &&
      (typeof normalizedInput.session_id === 'string' || typeof normalizedInput.sessionId === 'string')
    ) {
      return 'write_stdin';
    }
    if (typeof normalizedInput.path === 'string') return 'view_image';
    if (typeof normalizedInput.query === 'string' || typeof normalizedInput.q === 'string') return 'web_search';
    if (typeof normalizedInput.action === 'string' && normalizedInput.action === 'query') return 'context_ledger.memory';
  }

  const normalizedOutputRaw = unwrapToolPayload(output);
  const normalizedOutput = typeof normalizedOutputRaw === 'string'
    ? parseJsonObjectString(normalizedOutputRaw) ?? normalizedOutputRaw
    : normalizedOutputRaw;
  if (isRecord(normalizedOutput)) {
    if (Array.isArray(normalizedOutput.plan)) return 'update_plan';
    if (
      typeof normalizedOutput.path === 'string'
      && typeof normalizedOutput.mimeType === 'string'
      && normalizedOutput.mimeType.startsWith('image/')
    ) {
      return 'view_image';
    }
    if (Array.isArray(normalizedOutput.results)) return 'web_search';
    if (looksLikeExecOutput(normalizedOutput)) return 'exec_command';
    if (isRecord(normalizedOutput.result)) {
      if (looksLikeExecOutput(normalizedOutput.result)) return 'exec_command';
      if (
        typeof normalizedOutput.result.path === 'string' &&
        typeof normalizedOutput.result.mimeType === 'string' &&
        normalizedOutput.result.mimeType.startsWith('image/')
      ) {
        return 'view_image';
      }
    }
  }

  return undefined;
}

function resolveDisplayToolName(payload: Record<string, unknown>, input?: unknown, output?: unknown): string {
  const explicitName = firstStringField(payload, ['toolName', 'tool_name', 'tool']);
  if (explicitName) {
    const normalized = normalizeToolName(explicitName);
    if (normalized !== 'unknown') return normalized;
  }
  return inferToolName(input, output) ?? 'unknown';
}

function classifyExecCommand(command: string): ToolCategoryLabel {
  const normalized = command.trim().toLowerCase();
  if (normalized.length === 0) return '其他';

  if (/(^|\s)(rg|grep|find|fd)\b/.test(normalized)) return '搜索';
  if (/(^|\s)(cat|sed|head|tail|less|more|ls|pwd|stat|wc|du|git\s+(show|status|log|diff))\b/.test(normalized)) {
    return '读取';
  }
  if (
    /(^|\s)(echo|tee|cp|mv|rm|mkdir|rmdir|touch|chmod|chown|git\s+(add|commit|checkout|restore)|npm\s+install|pnpm\s+install|yarn\s+add)\b/.test(normalized)
    || />\s*[^ ]/.test(normalized)
  ) {
    return '写入';
  }
  return '其他';
}

function resolveToolCategoryLabel(toolName: string, input?: unknown): ToolCategoryLabel {
  if (toolName === 'apply_patch') return '编辑';
  if (toolName === 'update_plan') return '计划';
  if (toolName === 'context_ledger.memory') return '搜索';
  if (toolName === 'web_search') return '网络搜索';
  if (toolName === 'view_image') return '读取';
  if (toolName === 'write_stdin') return '写入';
  if (toolName === 'exec_command' || toolName === 'shell.exec') {
    const command = extractExecCommand(input);
    if (command) return classifyExecCommand(command);
    return '其他';
  }
  return '其他';
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
  const normalizedInput = unwrapToolPayload(input);
  if (!isRecord(normalizedInput)) return undefined;
  if (typeof normalizedInput.cmd === 'string' && normalizedInput.cmd.trim().length > 0) {
    return truncateInlineText(normalizedInput.cmd, 200);
  }
  if (typeof normalizedInput.command === 'string' && normalizedInput.command.trim().length > 0) {
    return truncateInlineText(normalizedInput.command, 200);
  }
  if (Array.isArray(normalizedInput.command)) {
    const formatted = formatCommandArray(normalizedInput.command);
    if (formatted.length > 0) return truncateInlineText(formatted, 200);
  }
  return undefined;
}

function buildToolExecutionSummary(toolName: string, input?: unknown): string | undefined {
  const command = extractExecCommand(input);
  if (command) return command;

  const normalizedInput = unwrapToolPayload(input);
  if (!isRecord(normalizedInput)) return undefined;

  if (toolName === 'write_stdin' && typeof normalizedInput.chars === 'string') {
    return `写入 ${normalizedInput.chars.length} 字符`;
  }

  if (typeof normalizedInput.path === 'string' && normalizedInput.path.trim().length > 0) {
    return `路径 ${truncateInlineText(normalizedInput.path, 120)}`;
  }

  const query = typeof normalizedInput.query === 'string'
    ? normalizedInput.query
    : typeof normalizedInput.q === 'string'
      ? normalizedInput.q
      : '';
  if (query.trim().length > 0) {
    return `查询 ${truncateInlineText(query, 120)}`;
  }

  if (typeof normalizedInput.action === 'string' && normalizedInput.action.trim().length > 0) {
    return `动作 ${truncateInlineText(normalizedInput.action, 80)}`;
  }

  return undefined;
}

function resolveToolActionLabel(toolName: string, input?: unknown): string {
  const summary = buildToolExecutionSummary(toolName, input);
  if (summary && summary.trim().length > 0) return summary.trim();
  if (toolName === 'update_plan') return '更新计划';
  if (toolName === 'context_ledger.memory') return '查询记忆';
  if (toolName === 'web_search') return '网络搜索';
  if (toolName === 'apply_patch') return '应用补丁';
  if (toolName === 'view_image') return '查看图片';
  if (toolName === 'write_stdin') return '写入终端';
  if (toolName === 'exec_command') return '执行命令';
  return toolName;
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
  const actionLabel = resolveToolActionLabel(toolName, input);
  if (status === 'error') {
    return errorText ?? `执行失败：${actionLabel}${durationText}`;
  }
  return `执行成功：${actionLabel}${durationText}`;
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
        const toolSeq = typeof payload.seq === 'number' && Number.isFinite(payload.seq)
          ? Math.max(0, Math.floor(payload.seq))
          : undefined;
        const toolId = typeof payload.toolId === 'string'
          ? payload.toolId
          : toolSeq !== undefined
            ? `seq-${toolSeq}`
            : undefined;
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
              toolCategory: resolveToolCategoryLabel(toolName, toolInput),
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
              toolCategory: resolveToolCategoryLabel(toolName, toolInput),
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
          toolCategory: resolveToolCategoryLabel(toolName, toolInput),
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
        const toolSeq = typeof payload.seq === 'number' && Number.isFinite(payload.seq)
          ? Math.max(0, Math.floor(payload.seq))
          : undefined;
        const toolId = typeof payload.toolId === 'string'
          ? payload.toolId
          : toolSeq !== undefined
            ? `seq-${toolSeq}`
            : undefined;
        const failureText = humanizeToolError(toolName, payload.error);
        return {
          ...(toolId ? { id: `tool:${toolId}:error` } : {}),
          role: 'agent',
          agentId: agentId || DEFAULT_CHAT_AGENT_ID,
          agentName: agentId || DEFAULT_CHAT_AGENT_ID,
          kind: 'observation',
          toolName,
          toolCategory: resolveToolCategoryLabel(toolName, payload.input),
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

function extractChatReply(result: unknown): {
  reply: string;
  agentId: string;
  tokenUsage?: RuntimeTokenUsage;
  pendingInputAccepted?: boolean;
} {
  const candidate = isRecord(result) && isRecord(result.output) ? result.output : result;

  if (typeof candidate === 'string') {
    return { reply: candidate, agentId: DEFAULT_CHAT_AGENT_ID, tokenUsage: estimateTokenUsage(candidate) };
  }

  if (!isRecord(candidate)) {
    const reply = JSON.stringify(candidate);
    return { reply, agentId: DEFAULT_CHAT_AGENT_ID, tokenUsage: estimateTokenUsage(reply) };
  }

  const agentId = typeof candidate.module === 'string' ? candidate.module : DEFAULT_CHAT_AGENT_ID;
  const metadata = isRecord(candidate.metadata) ? candidate.metadata : null;
  const pendingInputAccepted =
    candidate.pendingInputAccepted === true
    || metadata?.pendingInputAccepted === true;
  if (candidate.success === false) {
    const error = typeof candidate.error === 'string' ? candidate.error : 'chat-codex request failed';
    throw new Error(error);
  }

  if (typeof candidate.response === 'string' && candidate.response.trim().length > 0) {
    return {
      reply: candidate.response,
      agentId,
      tokenUsage: parseTokenUsage(candidate) ?? estimateTokenUsage(candidate.response),
      ...(pendingInputAccepted ? { pendingInputAccepted: true } : {}),
    };
  }

  if (typeof candidate.output === 'string' && candidate.output.trim().length > 0) {
    return {
      reply: candidate.output,
      agentId,
      tokenUsage: parseTokenUsage(candidate) ?? estimateTokenUsage(candidate.output),
      ...(pendingInputAccepted ? { pendingInputAccepted: true } : {}),
    };
  }

  if (typeof candidate.error === 'string' && candidate.error.length > 0) {
    throw new Error(candidate.error);
  }

  const reply = JSON.stringify(candidate, null, 2);
  return {
    reply,
    agentId,
    tokenUsage: parseTokenUsage(candidate) ?? estimateTokenUsage(reply),
    ...(pendingInputAccepted ? { pendingInputAccepted: true } : {}),
  };
}

function parseTokenUsage(candidate: Record<string, unknown>): RuntimeTokenUsage | undefined {
  const fromCandidate = normalizeTokenUsage(candidate);
  if (fromCandidate) return fromCandidate;
  if (isRecord(candidate.metadata)) {
    const fromMetadata = normalizeTokenUsage(candidate.metadata);
    if (fromMetadata) return fromMetadata;
    const fromRoundTrace = extractTokenUsageFromRoundTrace(candidate.metadata);
    if (fromRoundTrace) return fromRoundTrace;
  }
  const fromRoundTrace = extractTokenUsageFromRoundTrace(candidate);
  if (fromRoundTrace) return fromRoundTrace;
  return undefined;
}

function extractTokenUsageFromRoundTrace(source: Record<string, unknown>): RuntimeTokenUsage | undefined {
  const traces = source.round_trace ?? source.roundTrace;
  if (!Array.isArray(traces) || traces.length === 0) return undefined;
  for (let i = traces.length - 1; i >= 0; i -= 1) {
    const item = traces[i];
    if (!isRecord(item)) continue;
    const inputTokens = parseNumberLike(item.input_tokens, item.inputTokens);
    const outputTokens = parseNumberLike(item.output_tokens, item.outputTokens);
    const totalTokens = parseNumberLike(item.total_tokens, item.totalTokens);
    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) continue;
    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      estimated: false,
    };
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

function computeContextUsagePercent(
  contextTokensInWindow: number | undefined,
  contextMaxInputTokens: number | undefined,
): number | undefined {
  if (
    typeof contextTokensInWindow !== 'number'
    || !Number.isFinite(contextTokensInWindow)
    || contextTokensInWindow < 0
    || typeof contextMaxInputTokens !== 'number'
    || !Number.isFinite(contextMaxInputTokens)
    || contextMaxInputTokens <= 0
  ) {
    return undefined;
  }
  const ratio = Math.floor((contextTokensInWindow / contextMaxInputTokens) * 100);
  return Math.max(0, Math.min(100, ratio));
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('aborted');
}

async function safeParseJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload = (await response.json()) as unknown;
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function extractErrorMessageFromBody(body: Record<string, unknown> | null): string | undefined {
  if (!body) return undefined;
  const direct = firstStringField(body, ['error', 'message']);
  if (direct) return direct;
  if (isRecord(body.result)) {
    const nested = firstStringField(body.result, ['error', 'message']);
    if (nested) return nested;
  }
  if (isRecord(body.payload)) {
    const nested = firstStringField(body.payload, ['error', 'message']);
    if (nested) return nested;
  }
  return undefined;
}

function extractCompactSummary(body: Record<string, unknown> | null): string | undefined {
  if (!body) return undefined;
  const summary = firstStringField(body, ['summary']);
  if (!summary) return undefined;
  return truncateInlineText(summary, 220);
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

function normalizeToolNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map(normalizeToolName);
  return Array.from(new Set(names));
}

function parseRetryAfterMs(attempt: number): number {
  const base = SEND_RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(30_000, Math.floor(base));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryChatRequest(statusCode: number | undefined, errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  if (normalized.includes('daily_cost_limit_exceeded')) return false;
  if (normalized.includes('insufficient_quota')) return false;
  if (normalized.includes('unauthorized')) return false;
  if (normalized.includes('forbidden')) return false;

  if (typeof statusCode === 'number') {
    return statusCode === 408
      || statusCode === 409
      || statusCode === 425
      || statusCode === 429
      || statusCode === 500
      || statusCode === 502
      || statusCode === 503
      || statusCode === 504;
  }

  return normalized.includes('timeout')
    || normalized.includes('timed out')
    || normalized.includes('result timeout')
    || normalized.includes('gateway')
    || normalized.includes('fetch failed')
    || normalized.includes('network')
    || normalized.includes('econnreset')
    || normalized.includes('econnrefused')
    || normalized.includes('socket hang up');
}

function extractStatusCodeFromErrorMessage(message: string): number | undefined {
  const httpMatch = message.match(/\bHTTP[_\s:]?(\d{3})\b/i);
  if (httpMatch) {
    const parsed = Number.parseInt(httpMatch[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  const statusMatch = message.match(/\bstatus[:=\s]+(\d{3})\b/i);
  if (statusMatch) {
    const parsed = Number.parseInt(statusMatch[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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
  const [runtimeOverview, setRuntimeOverview] = useState<RuntimeOverview>({
    ledgerFocusMaxChars: DEFAULT_LEDGER_FOCUS_MAX_CHARS,
    compactCount: 0,
    updatedAt: new Date().toISOString(),
  });
  const [toolPanelOverview, setToolPanelOverview] = useState<ToolPanelOverview>({
    availableTools: [],
    exposedTools: [],
  });
  const executionStateRef = useRef<WorkflowExecutionState | null>(null);
  const runtimeEventsRef = useRef<RuntimeEvent[]>([]);
  const inFlightSendAbortRef = useRef<AbortController | null>(null);

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
        if (modelContextWindow !== undefined && modelContextWindow > 0) {
          setRuntimeOverview((prev) => ({
            ...prev,
            contextMaxInputTokens: modelContextWindow,
            updatedAt: new Date().toISOString(),
          }));
        }
        setAgentRunStatus({
          phase: 'running',
          text: modelContextWindow
            ? `${label}开始执行... 上下文窗口 ${modelContextWindow} tokens`
            : `${label}开始执行...`,
          updatedAt: new Date().toISOString(),
        });
      } else if (phase === 'kernel_event' && payload.type === 'pending_input_queued') {
        setAgentRunStatus({
          phase: 'running',
          text: `${label}执行中，新的输入已排队，等待当前回合合并...`,
          updatedAt: new Date().toISOString(),
        });
      } else if (phase === 'kernel_event' && payload.type === 'turn_interrupted') {
        setAgentRunStatus({
          phase: 'idle',
          text: `${label}已停止`,
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
          const effectiveContextUsagePercent = contextUsagePercent
            ?? computeContextUsagePercent(estimatedTokensInContextWindow, maxInputTokens);
          const fragments: string[] = [];
          if (finishReason.length > 0) {
            fragments.push(`finish=${finishReason}`);
          }
          if (effectiveContextUsagePercent !== undefined) {
            if (estimatedTokensInContextWindow !== undefined && maxInputTokens !== undefined && maxInputTokens > 0) {
              fragments.push(`上下文 ${effectiveContextUsagePercent}% (${estimatedTokensInContextWindow}/${maxInputTokens})`);
            } else if (estimatedTokensInContextWindow !== undefined) {
              fragments.push(`上下文 ${estimatedTokensInContextWindow} tokens`);
            } else {
              fragments.push(`上下文 ${effectiveContextUsagePercent}%`);
            }
          } else if (estimatedTokensInContextWindow !== undefined) {
            fragments.push(`上下文 ${estimatedTokensInContextWindow} tokens`);
          }
          if (
            thresholdPercent !== undefined
            && effectiveContextUsagePercent !== undefined
            && effectiveContextUsagePercent >= thresholdPercent
          ) {
            fragments.push('接近上下文阈值');
          }
          setAgentRunStatus({
            phase: 'running',
            text: `${label}内部循环第 ${round} 轮${fragments.length > 0 ? ` · ${fragments.join(' · ')}` : ''}`,
            updatedAt: new Date().toISOString(),
          });

          const inputTokens = parseNumberLike(payload.inputTokens, payload.input_tokens);
          const outputTokens = parseNumberLike(payload.outputTokens, payload.output_tokens);
          const totalTokens = parseNumberLike(payload.totalTokens, payload.total_tokens);
          if (
            inputTokens !== undefined
            || outputTokens !== undefined
            || totalTokens !== undefined
            || effectiveContextUsagePercent !== undefined
            || estimatedTokensInContextWindow !== undefined
            || maxInputTokens !== undefined
            || thresholdPercent !== undefined
          ) {
            setRuntimeOverview((prev) => ({
              ...prev,
              ...(inputTokens !== undefined ? { reqTokens: inputTokens } : {}),
              ...(outputTokens !== undefined ? { respTokens: outputTokens } : {}),
              ...(totalTokens !== undefined ? { totalTokens } : {}),
              ...((inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined)
                ? { tokenUpdatedAtLocal: new Date().toLocaleString() }
                : {}),
              ...(effectiveContextUsagePercent !== undefined ? { contextUsagePercent: effectiveContextUsagePercent } : {}),
              ...(estimatedTokensInContextWindow !== undefined
                ? { contextTokensInWindow: estimatedTokensInContextWindow }
                : {}),
              ...(maxInputTokens !== undefined ? { contextMaxInputTokens: maxInputTokens } : {}),
              ...(thresholdPercent !== undefined ? { contextThresholdPercent: thresholdPercent } : {}),
              updatedAt: new Date().toISOString(),
            }));
          }
        }
      } else if (phase === 'kernel_event' && payload.type === 'context_compact') {
        setRuntimeOverview((prev) => ({
          ...prev,
          compactCount: prev.compactCount + 1,
          updatedAt: new Date().toISOString(),
        }));
      } else if (phase === 'turn_complete') {
        const finalKernelEvent =
          typeof payload.finalKernelEvent === 'string' ? payload.finalKernelEvent.trim() : '';
        if (finalKernelEvent === 'pending_input_queued') {
          setAgentRunStatus({
            phase: 'running',
            text: `${label}执行中，输入已排队，等待当前回合继续...`,
            updatedAt: new Date().toISOString(),
          });
          return;
        }
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
      const toolName = resolveDisplayToolName(payload, payload.input, payload.output);
      const actionLabel = resolveToolActionLabel(toolName, payload.input);
      const category = resolveToolCategoryLabel(toolName, payload.input);
      setAgentRunStatus({
        phase: 'running',
        text: `正在执行${category}工具：${actionLabel}`,
        updatedAt: new Date().toISOString(),
      });
    } else if (msg.type === 'tool_result') {
      if (!isCurrentSessionEvent) return;
      const toolName = resolveDisplayToolName(payload, payload.input, payload.output);
      const actionLabel = resolveToolActionLabel(toolName, payload.input);
      const category = resolveToolCategoryLabel(toolName, payload.input);
      const output = isRecord(payload.output) ? payload.output : null;
      if (toolName === 'context_ledger.memory' && output) {
        const focusMaxChars = parseNumberLike(output.focus_max_chars, output.focusMaxChars);
        const insertChars = parseNumberLike(output.chars);
        setRuntimeOverview((prev) => ({
          ...prev,
          ...(focusMaxChars !== undefined ? { ledgerFocusMaxChars: focusMaxChars } : {}),
          ...(insertChars !== undefined ? { lastLedgerInsertChars: insertChars } : {}),
          updatedAt: new Date().toISOString(),
        }));
      }
      setAgentRunStatus({
        phase: 'running',
        text: `${category}工具完成：${actionLabel}，继续处理中...`,
        updatedAt: new Date().toISOString(),
      });
    } else if (msg.type === 'tool_error') {
      if (!isCurrentSessionEvent) return;
      const toolName = resolveDisplayToolName(payload, payload.input, payload.output);
      const actionLabel = resolveToolActionLabel(toolName, payload.input);
      const category = resolveToolCategoryLabel(toolName, payload.input);
      setAgentRunStatus({
        phase: 'error',
        text: `${category}工具失败：${actionLabel}`,
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

  const refreshToolPanelOverview = useCallback(async () => {
    try {
      const [toolsRes, policyRes] = await Promise.all([
        fetch('/api/v1/tools'),
        fetch(`/api/v1/tools/agents/${encodeURIComponent(DEFAULT_CHAT_AGENT_ID)}/policy`),
      ]);
      if (!toolsRes.ok || !policyRes.ok) return;
      const toolsPayload = (await toolsRes.json()) as { success?: boolean; tools?: Array<Record<string, unknown>> };
      const policyPayload = (await policyRes.json()) as { success?: boolean; policy?: Record<string, unknown> };
      if (!toolsPayload.success || !Array.isArray(toolsPayload.tools) || !policyPayload.success) return;

      const availableTools = Array.from(new Set(
        toolsPayload.tools
          .filter((item) => isRecord(item))
          .filter((item) => (typeof item.policy === 'string' ? item.policy : 'allow') === 'allow')
          .map((item) => (typeof item.name === 'string' ? normalizeToolName(item.name) : ''))
          .filter((name) => name.length > 0),
      )).sort();

      const policy = isRecord(policyPayload.policy) ? policyPayload.policy : {};
      const whitelist = normalizeToolNameList(policy.whitelist);
      const blacklistSet = new Set(normalizeToolNameList(policy.blacklist));
      const exposedBase = whitelist.length > 0 ? whitelist : availableTools;
      const exposedTools = exposedBase.filter((name) => !blacklistSet.has(name)).sort();

      setToolPanelOverview((prev) => ({
        ...prev,
        availableTools,
        exposedTools,
      }));
    } catch {
      // ignore tool panel refresh failures
    }
  }, []);

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
    setRuntimeOverview({
      ledgerFocusMaxChars: DEFAULT_LEDGER_FOCUS_MAX_CHARS,
      compactCount: 0,
      updatedAt: new Date().toISOString(),
    });
    setToolPanelOverview({
      availableTools: [],
      exposedTools: [],
    });
    setAgentRunStatus({
      phase: 'idle',
      text: '已就绪',
      updatedAt: new Date().toISOString(),
    });
    void loadSessionMessages();
    void refreshToolPanelOverview();
  }, [loadSessionMessages, refreshToolPanelOverview]);

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

  const interruptCurrentTurn = useCallback(async (): Promise<boolean> => {
    const activeAbort = inFlightSendAbortRef.current;
    if (activeAbort) {
      activeAbort.abort();
    }
    try {
      const res = await fetch(`/api/v1/chat-codex/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await safeParseJson(res);
      if (!res.ok) {
        const message = extractErrorMessageFromBody(body) ?? `HTTP ${res.status}`;
        throw new Error(message);
      }
      const interrupted = body?.interrupted === true;
      setAgentRunStatus({
        phase: 'idle',
        text: interrupted ? '已停止当前回合' : '当前没有可停止的回合',
        updatedAt: new Date().toISOString(),
      });
      setRuntimeEvents((prev) =>
        pushEvent(prev, {
          role: 'system',
          kind: 'status',
          content: interrupted ? '已发送停止信号，当前回合终止。' : '当前没有可停止的运行回合。',
          timestamp: new Date().toISOString(),
        }),
      );
      return interrupted;
    } catch (error) {
      const message = error instanceof Error ? error.message : '停止当前回合失败';
      setAgentRunStatus({
        phase: 'error',
        text: `停止失败：${message}`,
        updatedAt: new Date().toISOString(),
      });
      setRuntimeEvents((prev) =>
        pushEvent(prev, {
          role: 'system',
          kind: 'status',
          content: `停止当前回合失败：${message}`,
          timestamp: new Date().toISOString(),
          agentId: 'error',
        }),
      );
      return false;
    }
  }, [sessionId]);

const sendUserInput = useCallback(
  async (inputPayload: UserInputPayload) => {
    const text = inputPayload.text.trim();
    const images = inputPayload.images ?? [];
    const files = inputPayload.files ?? [];
    const review = normalizeReviewSettings(inputPayload.review);
    const planModeEnabled = inputPayload.planModeEnabled === true;
    if (!text && images.length === 0 && files.length === 0) return;
    if (text === '/compact' && images.length === 0 && files.length === 0) {
      try {
        const compactRes = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/compress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const compactBody = await safeParseJson(compactRes);
        if (!compactRes.ok) {
          const compactError = extractErrorMessageFromBody(compactBody) ?? `HTTP ${compactRes.status}`;
          throw new Error(compactError);
        }
        const summary = extractCompactSummary(compactBody);
        setRuntimeOverview((prev) => ({
          ...prev,
          compactCount: prev.compactCount + 1,
          updatedAt: new Date().toISOString(),
        }));
        setRuntimeEvents((prev) =>
          pushEvent(prev, {
            role: 'system',
            kind: 'status',
            content: `上下文已压缩${summary ? `：${summary}` : ''}`,
            timestamp: new Date().toISOString(),
          }),
        );
        setAgentRunStatus({
          phase: 'idle',
          text: '上下文压缩完成',
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '上下文压缩失败';
        setRuntimeEvents((prev) =>
          pushEvent(prev, {
            role: 'system',
            kind: 'status',
            content: `压缩失败：${message}`,
            timestamp: new Date().toISOString(),
            agentId: 'error',
          }),
        );
        setAgentRunStatus({
          phase: 'error',
          text: `压缩失败：${message}`,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }
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
        ? `chat-codex 正在思考（${planModeEnabled ? '计划模式 · ' : ''}Review: ${review.strictness === 'strict' ? '严格' : '主线'}, 上限 ${review.maxTurns}）...`
        : `chat-codex 正在思考${planModeEnabled ? '（计划模式）' : ''}...`,
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

      const abortController = new AbortController();
      inFlightSendAbortRef.current = abortController;
      const requestBody = {
        target: CHAT_PANEL_TARGET,
        blocking: true,
        message: {
          text: displayText,
          sessionId,
          history,
          deliveryMode: 'sync',
          metadata: {
            inputItems,
            mode: planModeEnabled ? 'plan' : 'main',
            kernelMode: planModeEnabled ? 'plan' : 'main',
            planModeEnabled,
            includePlanTool: planModeEnabled,
            ...(review
              ? {
                  review,
                }
              : {}),
          },
        },
      };

      let responseData: { result?: unknown; error?: string } | null = null;
      let attempt = 1;
      for (; attempt <= SEND_RETRY_MAX_ATTEMPTS; attempt += 1) {
        let responseStatus: number | undefined;
        try {
          const res = await fetch('/api/v1/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: abortController.signal,
            body: JSON.stringify(requestBody),
          });
          responseStatus = res.status;
          if (!res.ok) {
            const failureBody = await safeParseJson(res);
            const message = extractErrorMessageFromBody(failureBody) ?? `HTTP ${res.status}`;
            const wrapped = message.startsWith('HTTP') ? message : `HTTP ${res.status}: ${message}`;
            throw new Error(wrapped);
          }
          responseData = (await res.json()) as { result?: unknown; error?: string } | null;
          if (!responseData || responseData.error) {
            throw new Error(responseData?.error || 'Empty response from daemon');
          }
          break;
        } catch (error) {
          if (isAbortError(error)) throw error;
          const errorMessage = error instanceof Error ? error.message : String(error);
          const inferredStatus = responseStatus ?? extractStatusCodeFromErrorMessage(errorMessage);
          const canRetry = attempt < SEND_RETRY_MAX_ATTEMPTS && shouldRetryChatRequest(inferredStatus, errorMessage);
          if (!canRetry) {
            throw error;
          }
          const backoffMs = parseRetryAfterMs(attempt);
          const waitSeconds = Math.max(1, Math.ceil(backoffMs / 1000));
          setAgentRunStatus({
            phase: 'running',
            text: `请求失败，${waitSeconds}s 后自动重试（${attempt}/${SEND_RETRY_MAX_ATTEMPTS - 1}）...`,
            updatedAt: new Date().toISOString(),
          });
          await sleep(backoffMs);
        }
      }

      if (!responseData) {
        throw new Error('Empty response from daemon');
      }

      if (!responseData || responseData.error) {
        throw new Error(responseData?.error || 'Empty response from daemon');
      }
      const { reply, agentId, tokenUsage, pendingInputAccepted } = extractChatReply(responseData.result);
      if (pendingInputAccepted) {
        setRuntimeEvents((prev) =>
          prev
            .map((e) =>
              e.role === 'user' && e.timestamp === eventTime
                ? { ...e, agentId: 'confirmed', kind: 'status' }
                : e,
            ),
        );
        setRuntimeEvents((prev) =>
          pushEvent(prev, {
            role: 'system',
            kind: 'status',
            content: '输入已排队，等待当前回合合并处理。',
            timestamp: new Date().toISOString(),
          }),
        );
        setAgentRunStatus({
          phase: 'running',
          text: '当前回合仍在执行，输入已排队...',
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      if (tokenUsage) {
        setRuntimeOverview((prev) => ({
          ...prev,
          ...(typeof tokenUsage.inputTokens === 'number' ? { reqTokens: tokenUsage.inputTokens } : {}),
          ...(typeof tokenUsage.outputTokens === 'number' ? { respTokens: tokenUsage.outputTokens } : {}),
          ...(typeof tokenUsage.totalTokens === 'number' ? { totalTokens: tokenUsage.totalTokens } : {}),
          tokenUpdatedAtLocal: new Date().toLocaleString(),
          updatedAt: new Date().toISOString(),
        }));
      }
      if (isRecord(responseData.result) && isRecord(responseData.result.metadata)) {
        const metadata = responseData.result.metadata;
        const focusMaxChars = parseNumberLike(
          metadata.contextLedgerFocusMaxChars,
          metadata.context_ledger_focus_max_chars,
        );
        const contextUsagePercent = parseNumberLike(
          metadata.context_usage_percent,
          metadata.contextUsagePercent,
          metadata.context_budget_usage_percent,
        );
        const contextTokens = parseNumberLike(
          metadata.estimated_tokens_in_context_window,
          metadata.estimatedTokensInContextWindow,
          isRecord(metadata.context_budget) ? metadata.context_budget.estimated_tokens_in_context_window : undefined,
        );
        const contextMaxInputTokens = parseNumberLike(
          metadata.max_input_tokens,
          metadata.maxInputTokens,
          isRecord(metadata.context_budget) ? metadata.context_budget.max_input_tokens : undefined,
        );
        const contextThresholdPercent = parseNumberLike(
          metadata.threshold_percent,
          metadata.thresholdPercent,
          isRecord(metadata.context_budget) && typeof metadata.context_budget.threshold_ratio === 'number'
            ? metadata.context_budget.threshold_ratio * 100
            : undefined,
        );
        const effectiveContextUsagePercent = contextUsagePercent
          ?? computeContextUsagePercent(contextTokens, contextMaxInputTokens);
        const roundTraceUsage = extractTokenUsageFromRoundTrace(metadata);
        const exposedToolsFromMetadata = normalizeToolNameList(metadata.tools);
        if (exposedToolsFromMetadata.length > 0) {
          setToolPanelOverview((prev) => ({
            availableTools: prev.availableTools,
            exposedTools: exposedToolsFromMetadata,
          }));
        }
        if (
          focusMaxChars !== undefined
          || effectiveContextUsagePercent !== undefined
          || contextTokens !== undefined
          || contextMaxInputTokens !== undefined
          || contextThresholdPercent !== undefined
          || roundTraceUsage
        ) {
          setRuntimeOverview((prev) => ({
            ...prev,
            ...(focusMaxChars !== undefined ? { ledgerFocusMaxChars: focusMaxChars } : {}),
            ...(effectiveContextUsagePercent !== undefined ? { contextUsagePercent: effectiveContextUsagePercent } : {}),
            ...(contextTokens !== undefined ? { contextTokensInWindow: contextTokens } : {}),
            ...(contextMaxInputTokens !== undefined ? { contextMaxInputTokens } : {}),
            ...(contextThresholdPercent !== undefined ? { contextThresholdPercent } : {}),
            ...(roundTraceUsage?.inputTokens !== undefined ? { reqTokens: roundTraceUsage.inputTokens } : {}),
            ...(roundTraceUsage?.outputTokens !== undefined ? { respTokens: roundTraceUsage.outputTokens } : {}),
            ...(roundTraceUsage?.totalTokens !== undefined ? { totalTokens: roundTraceUsage.totalTokens } : {}),
            ...((roundTraceUsage?.inputTokens !== undefined
              || roundTraceUsage?.outputTokens !== undefined
              || roundTraceUsage?.totalTokens !== undefined)
              ? { tokenUpdatedAtLocal: new Date().toLocaleString() }
              : {}),
            updatedAt: new Date().toISOString(),
          }));
        }
      }
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
      if (isAbortError(err)) {
        setRuntimeEvents((prev) =>
          prev
            .map((e) =>
              e.role === 'user' && e.timestamp === eventTime
                ? { ...e, agentId: 'confirmed', kind: 'status' }
                : e,
            ),
        );
        setAgentRunStatus({
          phase: 'idle',
          text: '当前回合已中止',
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      const interruptedByUser =
        err instanceof Error && err.message.toLowerCase().includes('interrupted by user');
      if (interruptedByUser) {
        setRuntimeEvents((prev) =>
          prev
            .map((e) =>
              e.role === 'user' && e.timestamp === eventTime
                ? { ...e, agentId: 'confirmed', kind: 'status' }
                : e,
            ),
        );
        setAgentRunStatus({
          phase: 'idle',
          text: '当前回合已停止',
          updatedAt: new Date().toISOString(),
        });
        setRuntimeEvents((prev) =>
          pushEvent(prev, {
            role: 'system',
            content: '当前回合已被停止。',
            timestamp: new Date().toISOString(),
            kind: 'status',
          }),
        );
        return;
      }
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
    } finally {
      inFlightSendAbortRef.current = null;
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
   interruptCurrentTurn,
   sendUserInput,
   editRuntimeEvent,
   deleteRuntimeEvent,
   agentRunStatus,
   runtimeOverview,
   toolPanelOverview,
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
