import type { RuntimeEvent, RuntimePlanStep, WsMessage } from '../api/types.js';
import { DEFAULT_CHAT_AGENT_ID } from './useWorkflowExecution.constants.js';
import { describeOrchestratorPhase } from './useWorkflowExecution.phase.js';
import {
  buildHumanToolResultOutput,
  buildToolResultContent,
  extractToolFailureText,
  humanizeToolError,
  resolveDisplayToolName,
  resolveToolCategoryLabel,
  resolveToolResultStatus,
} from './useWorkflowExecution.tools.js';
import { isRecord } from './useWorkflowExecution.utils.js';

function pickFilenameFromPath(inputPath: string): string {
  const normalized = inputPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? inputPath;
}

function toRuntimeImageUrl(url: string): string {
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

function parseViewImageOutput(output: unknown) {
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

export function mapWsMessageToRuntimeEvent(
  msg: WsMessage,
  currentSessionId: string,
): (Omit<RuntimeEvent, 'id'> & { id?: string }) | null {
  const payload = isRecord(msg.payload) ? msg.payload : {};
  const eventSessionId =
    (typeof msg.sessionId === 'string' ? msg.sessionId : undefined)
    || (typeof payload.sessionId === 'string' ? payload.sessionId : undefined);

  const timestamp = typeof msg.timestamp === 'string' ? msg.timestamp : new Date().toISOString();
  const agentId =
    (typeof msg.agentId === 'string' ? msg.agentId : undefined)
    || (typeof payload.agentId === 'string' ? payload.agentId : undefined);

  if (eventSessionId && eventSessionId !== currentSessionId) {
    return null;
  }

  switch (msg.type) {
    case 'task_started':
    case 'task_completed':
    case 'task_failed':
      return null;
    case 'tool_call':
      return null;
    case 'tool_result': {
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
    case 'tool_error': {
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
      {
        const messageId = typeof payload.messageId === 'string' ? payload.messageId.trim() : '';
        const eventId = messageId.length > 0 ? `assistant:${messageId}` : undefined;
        return {
          ...(eventId ? { id: eventId } : {}),
          role: 'agent',
          agentId: agentId || DEFAULT_CHAT_AGENT_ID,
          agentName: agentId || DEFAULT_CHAT_AGENT_ID,
          kind: 'observation',
          content: payload.content,
          timestamp,
        };
      }
    case 'assistant_complete': {
      const messageId = typeof payload.messageId === 'string' ? payload.messageId.trim() : '';
      const eventId = messageId.length > 0 ? `assistant:${messageId}` : undefined;
      const content = typeof payload.content === 'string' ? payload.content.trim() : '';
      if (content.length === 0) return null;
      return {
        ...(eventId ? { id: eventId } : {}),
        role: 'agent',
        agentId: agentId || DEFAULT_CHAT_AGENT_ID,
        agentName: agentId || DEFAULT_CHAT_AGENT_ID,
        kind: 'observation',
        content,
        timestamp,
      };
    }
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
    case 'phase_transition': {
      const from = String((payload as Record<string, unknown>).from ?? '').trim();
      const to = String((payload as Record<string, unknown>).to ?? '').trim();
      const fromLabel = from ? describeOrchestratorPhase(from) : '?';
      const toLabel = to ? describeOrchestratorPhase(to) : '?';
      return {
        role: 'system',
        kind: 'status',
        content: `阶段切换：${fromLabel} -> ${toLabel}`,
        timestamp,
      };
    }
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
    case 'agent_runtime_dispatch': {
      const target = typeof payload.targetAgentId === 'string' ? payload.targetAgentId : 'unknown-agent';
      const status = typeof payload.status === 'string' ? payload.status : 'unknown';
      const summary = typeof payload.summary === 'string' ? payload.summary : '';
      const content = summary.length > 0
        ? `[dispatch] ${target} ${status} - ${summary}`
        : `[dispatch] ${target} ${status}`;
      return {
        role: 'system',
        kind: 'status',
        content,
        timestamp,
      };
    }
    case 'agent_runtime_control': {
      const action = typeof payload.action === 'string' ? payload.action : 'unknown';
      const status = typeof payload.status === 'string' ? payload.status : 'unknown';
      const content = `[control] ${action} -> ${status}`;
      return {
        role: 'system',
        kind: 'status',
        content,
        timestamp,
      };
    }
    case 'agent_runtime_status': {
      const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
      const status = typeof payload.status === 'string' ? payload.status : 'unknown';
      const content = summary.length > 0
        ? `[runtime] ${status} - ${summary}`
        : `[runtime] ${status}`;
      return {
        role: 'system',
        kind: 'status',
        content,
        timestamp,
      };
    }
    case 'agent_runtime_mock_assertion': {
      const assertion = isRecord(payload.payload) ? payload.payload : payload;
      const summary = typeof assertion.content === 'string' ? assertion.content : 'mock assertion';
      const result = isRecord(assertion.result) ? assertion.result : {};
      const resultSummary = typeof result.summary === 'string' ? result.summary : '';
      const content = resultSummary
        ? `[assert] ${summary} => ${resultSummary}`
        : `[assert] ${summary}`;
      return {
        role: 'system',
        kind: 'status',
        content,
        timestamp,
      };
    }
    case 'runtime_status_changed':
      return {
        role: 'system',
        kind: 'status',
        content: `[runtime] status=${String(payload.status ?? 'unknown')}`,
        timestamp,
      };
    case 'runtime_finished':
      return {
        role: 'system',
        kind: 'status',
        content: `[runtime] finished: ${String(payload.finalStatus ?? payload.status ?? 'unknown')}`,
        timestamp,
      };
    default:
      return null;
  }
}
