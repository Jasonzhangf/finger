import { useState, useEffect, useCallback, useRef } from 'react';
import { useWebSocket } from './useWebSocket.js';
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
  getAgentDetail: (agentId: string) => AgentExecutionDetail | null;
  getTaskReport: () => TaskReport | null;
  isConnected: boolean;
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

function pushEvent(current: RuntimeEvent[], event: Omit<RuntimeEvent, 'id'>): RuntimeEvent[] {
  const entry: RuntimeEvent = {
    ...event,
    id: `${event.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
  };
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

function buildToolResultContent(toolName: string, output: unknown, duration?: number): string {
  const header = typeof duration === 'number'
    ? `工具完成：${toolName} (${duration}ms)`
    : `工具完成：${toolName}`;
  const preview = stringifyToolPayload(output);
  if (!preview) return header;
  return `${header}\n${preview}`;
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

export function mapWsMessageToRuntimeEvent(msg: WsMessage, currentSessionId: string): Omit<RuntimeEvent, 'id'> | null {
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
      return {
        role: 'system',
        kind: 'status',
        content: `任务开始：${typeof payload.title === 'string' ? payload.title : '处理中'}`,
        timestamp,
      };
    case 'task_completed':
      return {
        role: 'system',
        kind: 'status',
        content: '任务完成',
        timestamp,
      };
    case 'task_failed':
      return {
        role: 'system',
        kind: 'status',
        content: `任务失败：${typeof payload.error === 'string' ? payload.error : 'unknown error'}`,
        timestamp,
      };
    case 'tool_call':
      {
        const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
        const inputPreview = stringifyToolPayload(payload.input);
        return {
          role: 'agent',
          agentId: agentId || DEFAULT_CHAT_AGENT_ID,
          agentName: agentId || DEFAULT_CHAT_AGENT_ID,
          kind: 'action',
          toolName,
          content: inputPreview
            ? `调用工具：${toolName}\n${inputPreview}`
            : `调用工具：${toolName}`,
          timestamp,
        };
      }
    case 'tool_result':
      {
        const toolName = typeof payload.toolName === 'string' ? payload.toolName : 'unknown';
        const output = payload.output;
        const duration = typeof payload.duration === 'number' ? payload.duration : undefined;

        if (toolName === 'view_image') {
          const image = parseViewImageOutput(output);
          if (image) {
            return {
              role: 'agent',
              agentId: agentId || DEFAULT_CHAT_AGENT_ID,
              agentName: agentId || DEFAULT_CHAT_AGENT_ID,
              kind: 'observation',
              toolName,
              toolDurationMs: duration,
              content: `工具完成：${toolName}（已附加图片）`,
              timestamp,
              images: [image],
            };
          }
        }

        if (toolName === 'update_plan') {
          const planOutput = parseUpdatePlanOutput(output);
          if (planOutput) {
            return {
              role: 'agent',
              agentId: agentId || DEFAULT_CHAT_AGENT_ID,
              agentName: agentId || DEFAULT_CHAT_AGENT_ID,
              kind: 'observation',
              toolName,
              toolDurationMs: duration,
              content: `工具完成：${toolName}（${planOutput.steps.length} 个步骤）`,
              timestamp,
              planSteps: planOutput.steps,
              planExplanation: planOutput.explanation,
              planUpdatedAt: planOutput.updatedAt,
            };
          }
        }

        return {
          role: 'agent',
          agentId: agentId || DEFAULT_CHAT_AGENT_ID,
          agentName: agentId || DEFAULT_CHAT_AGENT_ID,
          kind: 'observation',
          toolName,
          toolDurationMs: duration,
          content: buildToolResultContent(toolName, output, duration),
          timestamp,
        };
      }
    case 'tool_error':
      return {
        role: 'agent',
        agentId: agentId || DEFAULT_CHAT_AGENT_ID,
        agentName: agentId || DEFAULT_CHAT_AGENT_ID,
        kind: 'observation',
        content: `工具失败：${typeof payload.error === 'string' ? payload.error : 'unknown error'}`,
        timestamp,
      };
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

interface ToolTraceItem {
  tool: string;
  status: 'ok' | 'error';
  error?: string;
}

function extractToolTrace(result: unknown): ToolTraceItem[] {
  const candidate = isRecord(result) && isRecord(result.output) ? result.output : result;
  if (!isRecord(candidate) || !isRecord(candidate.metadata)) return [];

  const rawTrace = candidate.metadata.tool_trace;
  if (!Array.isArray(rawTrace)) return [];

  const trace: ToolTraceItem[] = [];
  for (const item of rawTrace) {
    if (!isRecord(item)) continue;
    const tool = typeof item.tool === 'string' ? item.tool.trim() : '';
    if (!tool) continue;
    const status: ToolTraceItem['status'] = item.status === 'error' ? 'error' : 'ok';
    const error = typeof item.error === 'string' && item.error.trim().length > 0
      ? item.error.trim()
      : undefined;
    trace.push({
      tool,
      status,
      ...(error ? { error } : {}),
    });
  }
  return trace;
}

function buildToolTraceEvents(toolTrace: ToolTraceItem[], agentId: string): Array<Omit<RuntimeEvent, 'id'>> {
  if (toolTrace.length === 0) return [];

  const events: Array<Omit<RuntimeEvent, 'id'>> = [];
  const base = Date.now();
  for (let i = 0; i < toolTrace.length; i += 1) {
    const item = toolTrace[i];
    const actionTs = new Date(base + i * 2).toISOString();
    const observationTs = new Date(base + i * 2 + 1).toISOString();

    events.push({
      role: 'agent',
      agentId,
      agentName: agentId,
      kind: 'action',
      toolName: item.tool,
      content: `调用工具：${item.tool}`,
      timestamp: actionTs,
    });

    events.push({
      role: 'agent',
      agentId,
      agentName: agentId,
      kind: 'observation',
      toolName: item.tool,
      content: item.status === 'ok'
        ? `工具完成：${item.tool}`
        : `工具失败：${item.tool}${item.error ? `\n${item.error}` : ''}`,
      ...(item.status === 'error' && item.error ? { errorMessage: item.error } : {}),
      timestamp: observationTs,
    });
  }

  return events;
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
  const executionStateRef = useRef<WorkflowExecutionState | null>(null);

  useEffect(() => {
    executionStateRef.current = executionState;
  }, [executionState]);

  const handleWebSocketMessage = useCallback((msg: WsMessage) => {
    if (msg.type === 'workflow_update') {
      const payload = msg.payload as WorkflowUpdatePayload;

      if (payload.taskUpdates && payload.taskUpdates.length > 0) {
        setExecutionRounds(buildExecutionRoundsFromTasks(payload.taskUpdates, executionStateRef.current?.agents || []));
      }
      setExecutionState((prev) => {
        if (!prev || prev.workflowId !== payload.workflowId) return prev;
        return {
          ...prev,
          status: payload.status,
          orchestrator: payload.orchestratorState
            ? {
                ...prev.orchestrator,
                currentRound: payload.orchestratorState.round,
                thought: payload.orchestratorState.thought,
              }
            : prev.orchestrator,
          tasks: payload.taskUpdates || prev.tasks,
          agents: payload.agentUpdates || prev.agents,
          executionPath: payload.executionPath || prev.executionPath,
          userInput: payload.userInput || prev.userInput,
          paused: payload.status === 'paused' ? true : payload.status === 'executing' ? false : prev.paused,
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

    const runtimeEvent = mapWsMessageToRuntimeEvent(msg, sessionId);
    if (!runtimeEvent) return;
    setRuntimeEvents((prev) => pushEvent(prev, runtimeEvent));
  }, [sessionId]);

  const { isConnected } = useWebSocket(handleWebSocketMessage);

  const loadSessionMessages = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/sessions/${sessionId}/messages?limit=100`);
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
    ): Promise<void> => {
      const attachments = toSessionAttachments(images, files);
      await fetch(`/api/v1/sessions/${sessionId}/messages/append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role,
          content,
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      });
    },
    [sessionId],
  );

  useEffect(() => {
    setRuntimeEvents([]);
    setUserRounds([]);
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
      const rounds = buildExecutionRoundsFromTasks(taskList, agentsWithAssignees);
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
    if (!text && images.length === 0 && files.length === 0) return;
    const inputItems = buildKernelInputItems(text, images, files);
    const displayText = text || (images.length > 0 || files.length > 0 ? '[附件输入]' : '');

    const eventTime = new Date().toISOString();
    const roundId = `user-round-${Date.now()}`;
    const processingEventId = `processing-${Date.now()}`;

    // 1. 先本地插入 pending 状态的用户事件（立即可见）
    setRuntimeEvents((prev) =>
      pushEvent(prev, {
       role: 'user',
       content: displayText,
       images,
       files,
       timestamp: eventTime,
       kind: 'status',
       agentId: 'pending',
       tokenUsage: estimateTokenUsage(displayText),
     }),
   );

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

    setRuntimeEvents((prev) =>
      pushEvent(prev, {
        id: processingEventId,
        role: 'system',
        agentId: 'chat-codex',
        agentName: 'chat-codex',
        kind: 'status',
        content: 'chat-codex 正在处理，请稍候...',
        timestamp: new Date().toISOString(),
      }),
    );

    // 3. 统一走 chat-codex gateway
    try {
      const history = runtimeEvents
        .filter((event) => event.role === 'user' || event.role === 'agent')
        .slice(-20)
        .map((event) => ({
          role: event.role === 'user' ? 'user' : 'assistant',
          content: event.content,
        }));

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
      const toolTraceEvents = buildToolTraceEvents(extractToolTrace(responseData.result), agentId);

      try {
        await appendSessionMessage('user', displayText, images, files);
        await appendSessionMessage('assistant', reply);
      } catch {
        // keep conversation running even if session persistence fails
      }

      setRuntimeEvents((prev) => {
        const confirmed = prev
          .filter((e) => e.id !== processingEventId)
          .map((e) =>
          e.role === 'user' && e.timestamp === eventTime
            ? { ...e, agentId: 'confirmed' }
            : e,
        );

        let next = confirmed;
        for (const toolEvent of toolTraceEvents) {
          next = pushEvent(next, toolEvent);
        }

        return pushEvent(next, {
          role: 'agent',
          agentId,
          agentName: agentId,
          content: reply,
          timestamp: new Date().toISOString(),
          kind: 'observation',
          tokenUsage,
        });
      });

      setExecutionState((prev) => (prev ? { ...prev, userInput: displayText } : prev));
    } catch (err) {
      // 6. API 失败：更新事件为 error 并追加错误事件
      setRuntimeEvents((prev) =>
        prev
          .filter((e) => e.id !== processingEventId)
          .map((e) =>
          e.role === 'user' && e.timestamp === eventTime
            ? { ...e, agentId: 'error', kind: 'status', errorMessage: err instanceof Error ? err.message : '发送失败' }
            : e
        ),
      );

      const errorMsg = err instanceof Error ? err.message : '发送失败';
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
  [appendSessionMessage, runtimeEvents, sessionId],
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
   getAgentDetail,
   getTaskReport,
   isConnected,
 };
}

function buildExecutionRoundsFromTasks(
  tasks: TaskNode[],
  _agents: AgentRuntime[],
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
