/**
 * Agent Status Subscriber - Event Handlers
 *
 * 从主类提取的事件处理函数，减少 agent-status-subscriber.ts 文件大小
 */

import type {
  RuntimeEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolErrorEvent,
  SystemErrorEvent,
} from '../../runtime/events.js';
import type { SessionEnvelopeMapping, AgentInfo, WrappedStatusUpdate } from './agent-status-subscriber-types.js';
import { getAgentIcon } from './agent-status-subscriber-helpers.js';
import { sendStatusUpdate } from './agent-status-subscriber-runtime.js';
import { logger } from '../../core/logger.js';

const log = logger.module('AgentStatusSubscriberHandlers');
const RAW_TOOL_ERROR_SUPPRESSED_CHANNELS = new Set(['qqbot', 'openclaw-weixin']);

function shouldSuppressRawToolError(channelId?: string): boolean {
  if (!channelId) return false;
  return RAW_TOOL_ERROR_SUPPRESSED_CHANNELS.has(channelId);
}

type ToolVerb = 'search' | 'read' | 'write' | 'run' | 'edit' | 'plan' | 'other';

function truncateInline(value: string, max = 72): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function resolveOutputRecord(output: unknown): Record<string, unknown> | null {
  if (!output || typeof output !== 'object') return null;
  const record = output as Record<string, unknown>;
  if (record.result && typeof record.result === 'object' && record.result !== null) {
    return record.result as Record<string, unknown>;
  }
  return record;
}

function extractStdout(output: unknown): string | undefined {
  const record = resolveOutputRecord(output);
  if (!record) return undefined;
  const stdout = typeof record.stdout === 'string'
    ? record.stdout
    : typeof record.output === 'string'
      ? record.output
      : typeof record.text === 'string'
        ? record.text
        : '';
  const normalized = stdout.trim();
  return normalized.length > 0 ? truncateInline(normalized, 100) : undefined;
}

function extractStderr(output: unknown): string | undefined {
  const record = resolveOutputRecord(output);
  if (!record) return undefined;
  const stderr = typeof record.stderr === 'string'
    ? record.stderr
    : typeof record.error === 'string'
      ? record.error
      : '';
  const normalized = stderr.trim();
  return normalized.length > 0 ? truncateInline(normalized, 100) : undefined;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null = regex.exec(command);
  while (match) {
    const token = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (token.length > 0) tokens.push(token);
    match = regex.exec(command);
  }
  return tokens;
}

function looksLikePathToken(token: string): boolean {
  if (!token || token.startsWith('-')) return false;
  if (token.startsWith('~') || token.startsWith('/') || token.startsWith('./') || token.startsWith('../')) return true;
  if (/^[A-Za-z]:[\\/]/.test(token)) return true;
  if (/[\\/]/.test(token)) return true;
  return /\.[A-Za-z0-9_-]{1,8}$/.test(token);
}

function pickFileName(token: string): string {
  const normalized = token.trim().replace(/\\/g, '/');
  const compact = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  const parts = compact.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? token;
}

function classifyExecCommand(command: string): ToolVerb {
  const normalized = command.trim().toLowerCase();
  if (normalized.length === 0) return 'run';
  if (/(^|\s)(rg|grep|find|fd)\b/.test(normalized)) return 'search';
  if (/(^|\s)(cat|sed|head|tail|less|more|ls|pwd|stat|wc|du|git\s+(show|status|log|diff))\b/.test(normalized)) return 'read';
  if (/(^|\s)(echo|tee|cp|mv|rm|mkdir|rmdir|touch|chmod|chown|git\s+(add|commit|checkout|restore)|npm\s+install|pnpm\s+install|yarn\s+add)\b/.test(normalized) || />\s*[^ ]/.test(normalized)) {
    return 'write';
  }
  return 'run';
}

function parseExecCommandTarget(command: string, verb: ToolVerb): string | undefined {
  const firstSegment = command.split(/(?:\|\||&&|\||;)/)[0]?.trim() ?? command.trim();
  const tokens = tokenizeCommand(firstSegment);
  if (tokens.length <= 1) return undefined;
  const executable = tokens[0].toLowerCase();
  const args = tokens.slice(1);

  if ((executable === 'cp' || executable === 'mv') && args.length >= 2) {
    const last = [...args].reverse().find((token) => looksLikePathToken(token) && token !== '.');
    return last ? pickFileName(last) : undefined;
  }

  if (executable === 'find') {
    const path = args.find((token) => looksLikePathToken(token));
    return path ? pickFileName(path) : undefined;
  }

  if (executable === 'rg' || executable === 'grep') {
    const candidates = args.filter((token) => looksLikePathToken(token) && !token.startsWith('-'));
    const target = candidates[candidates.length - 1];
    return target ? pickFileName(target) : undefined;
  }

  const candidate = args.find((token) => looksLikePathToken(token) && token !== '.');
  if (candidate) return pickFileName(candidate);
  if (verb === 'run') return executable;
  return undefined;
}

function parseMailboxVerb(toolName: string): ToolVerb {
  const action = toolName.replace(/^mailbox\./i, '').toLowerCase();
  if (action === 'ack' || action === 'remove' || action === 'remove_all') return 'write';
  return 'read';
}

function parseToolSummary(toolName: string, input: unknown, output?: unknown): {
  verb: ToolVerb;
  target?: string;
  signals?: string[];
  details?: Record<string, unknown>;
} {
  const normalizedToolName = typeof toolName === 'string' ? toolName.trim().toLowerCase() : 'unknown';
  const payload = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  if (normalizedToolName === 'apply_patch') {
    const patchText = typeof payload.patch === 'string'
      ? payload.patch
      : typeof input === 'string'
        ? input
        : '';
    const match = patchText.match(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/m);
    return {
      verb: 'edit',
      ...(match && match[1] ? { target: pickFileName(match[1]) } : {}),
    };
  }

  if (normalizedToolName === 'update_plan') {
    return { verb: 'plan' };
  }

  if (normalizedToolName === 'context_ledger.memory') {
    const action = typeof payload.action === 'string' ? payload.action.trim().toLowerCase() : 'query';
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';
    const outputRecord = resolveOutputRecord(output);
    const summary = outputRecord && typeof outputRecord.summary === 'string' ? outputRecord.summary.trim() : '';
    const hits = outputRecord && Array.isArray(outputRecord.results) ? outputRecord.results.length : undefined;
    const verb: ToolVerb = (action === 'index' || action === 'compact' || action === 'write') ? 'write' : 'read';
    return {
      verb,
      ...(query.length > 0 ? { target: truncateInline(query, 48) } : {}),
      signals: [
        `action=${action}`,
        query.length > 0 ? `query=${truncateInline(query, 100)}` : '',
        typeof hits === 'number' ? `hits=${hits}` : '',
        summary.length > 0 ? `summary=${truncateInline(summary, 100)}` : '',
      ].filter((item) => item.length > 0),
    };
  }

  if (normalizedToolName.startsWith('mailbox.')) {
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    const outputRecord = resolveOutputRecord(output);
    const message = outputRecord && outputRecord.message && typeof outputRecord.message === 'object'
      ? outputRecord.message as Record<string, unknown>
      : null;
    const content = message?.content && typeof message.content === 'object'
      ? message.content as Record<string, unknown>
      : null;
    const envelope = content?.envelope && typeof content.envelope === 'object'
      ? content.envelope as Record<string, unknown>
      : null;
    const title = envelope && typeof envelope.title === 'string' ? envelope.title.trim() : '';
    const shortDescription = envelope && typeof envelope.shortDescription === 'string'
      ? envelope.shortDescription.trim()
      : '';
    const messageCategory = message && typeof message.category === 'string' ? message.category.trim() : '';
    const messageId = message && typeof message.id === 'string' ? message.id.trim() : '';
    return {
      verb: parseMailboxVerb(normalizedToolName),
      ...(id.length > 0 ? { target: truncateInline(id, 40) } : {}),
      signals: [
        messageId ? `msg=${truncateInline(messageId, 60)}` : '',
        messageCategory ? `cat=${truncateInline(messageCategory, 30)}` : '',
        title ? `title=${truncateInline(title, 100)}` : '',
        shortDescription ? `desc=${truncateInline(shortDescription, 100)}` : '',
      ].filter((item) => item.length > 0),
    };
  }

  if (normalizedToolName === 'web_search' || normalizedToolName === 'search_query') {
    const query = typeof payload.query === 'string'
      ? payload.query.trim()
      : typeof payload.q === 'string'
        ? payload.q.trim()
        : '';
    return {
      verb: 'search',
      ...(query.length > 0 ? { target: truncateInline(query, 48) } : {}),
    };
  }

  if (normalizedToolName === 'view_image') {
    const path = typeof payload.path === 'string' ? payload.path.trim() : '';
    return {
      verb: 'read',
      ...(path.length > 0 ? { target: pickFileName(path) } : {}),
    };
  }

  if (normalizedToolName === 'write_stdin') {
    const stdin = typeof payload.chars === 'string' ? payload.chars.trim() : '';
    const stdout = extractStdout(output);
    const stderr = extractStderr(output);
    return {
      verb: 'run',
      target: 'stdin',
      signals: [
        stdin ? `stdin=${truncateInline(stdin, 100)}` : '',
        stdout ? `stdout=${stdout}` : '',
        stderr ? `stderr=${stderr}` : '',
      ].filter((item) => item.length > 0),
    };
  }

  if (normalizedToolName === 'exec_command' || normalizedToolName === 'shell.exec' || normalizedToolName === 'shell') {
    const command = typeof payload.cmd === 'string'
      ? payload.cmd.trim()
      : typeof payload.command === 'string'
        ? payload.command.trim()
        : '';
    if (command.length === 0) return { verb: 'run' };
    const verb = classifyExecCommand(command);
    const stdout = extractStdout(output);
    const stderr = extractStderr(output);
    return {
      verb,
      target: parseExecCommandTarget(command, verb) ?? truncateInline(command, 64),
      signals: [
        `stdin=${truncateInline(command, 100)}`,
        stdout ? `stdout=${stdout}` : '',
        stderr ? `stderr=${stderr}` : '',
      ].filter((item) => item.length > 0),
      details: {
        command: truncateInline(command, 200),
      },
    };
  }

  return { verb: 'run', target: normalizedToolName };
}

/**
 * 处理上下文，包含事件处理所需的依赖
 */
export interface HandlerContext {
  messageHub?: import('../../orchestration/message-hub.js').MessageHub;
  channelBridgeManager?: import('../../bridges/manager.js').ChannelBridgeManager;
  broadcast?: (message: unknown) => void;
  resolveEnvelopeMapping: (sessionId: string) => SessionEnvelopeMapping | null;
  getAgentInfo: (agentId: string) => Promise<AgentInfo>;
  sendReasoningUpdate?: (sessionId: string, agentId: string, reasoningText: string) => Promise<void>;
  stepBuffer: Map<string, Array<{ index: number; summary: string; timestamp: string }>>;
  stepBatchDefault: number;
  primaryAgentId: string | null;
  registerChildAgent: (childAgentId: string, parentAgentId: string) => void;
  registerChildSession: (childSessionId: string, envelope: SessionEnvelopeMapping[ 'envelope']) => void;
}

/**
 * 处理 tool_call 事件
 */
export async function handleToolCall(
  event: ToolCallEvent,
  _ctx: HandlerContext,
): Promise<void> {
  log.debug('[AgentStatusSubscriber] Skip tool_call push; only emit tool_result/tool_error', {
    sessionId: event.sessionId,
    agentId: event.agentId,
    toolName: event.toolName,
    toolId: event.toolId,
  });
}

/**
 * 处理 tool_result 事件
 */
export async function handleToolResult(
  event: ToolResultEvent,
  ctx: HandlerContext,
): Promise<void> {
  const sessionId = event.sessionId;
  const mapping = ctx.resolveEnvelopeMapping(sessionId);
  if (!mapping || !ctx.messageHub) return;


  const agentId = event.agentId || 'unknown-agent';
  const toolName = event.toolName || 'unknown-tool';
  const agentInfo = await ctx.getAgentInfo(agentId);
  const parsed = parseToolSummary(toolName, event.payload?.input, event.payload?.output);
  const statusTag = 'success';
  const signalText = parsed.signals && parsed.signals.length > 0 ? ` · ${parsed.signals.join(' · ')}` : '';
  const taskDescription = `[${parsed.verb}] ${parsed.target ?? toolName} · ${statusTag}${signalText}`;

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: event.toolId || `tool-result-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId,
    task: {
      targetAgentId: agentId,
      taskDescription,
    },
    agent: agentInfo,
    status: {
      state: 'running',
      summary: taskDescription,
      details: {
        toolId: event.toolId,
        toolName,
        duration: event.payload?.duration,
        ...(parsed.signals && parsed.signals.length > 0 ? { signals: parsed.signals } : {}),
        ...(parsed.details ? parsed.details : {}),
      },
    },
    display: {
      title: `${getAgentIcon(agentInfo.agentRole)} ${taskDescription}`,
      subtitle: `${agentInfo.agentName || agentId}`,
      icon: getAgentIcon(agentInfo.agentRole),
      level: 'summary',
    },
  };

  await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
}

/**
 * 处理 tool_error 事件
 */
export async function handleToolError(
  event: ToolErrorEvent,
  ctx: HandlerContext,
): Promise<void> {
  const agentId = event.agentId || 'unknown-agent';
  const sessionId = event.sessionId;
  const mapping = ctx.resolveEnvelopeMapping(sessionId);
  if (!mapping) return;

  if (shouldSuppressRawToolError(mapping.envelope.channel)) {
    log.info('[AgentStatusSubscriber] Suppressed raw tool_error push for external channel', {
      channel: mapping.envelope.channel,
      sessionId,
      agentId,
      toolName: event.toolName,
      error: event.payload?.error,
    });
    return;
  }

  const agentInfo = await ctx.getAgentInfo(agentId);
  const parsed = parseToolSummary(event.toolName || 'unknown-tool', event.payload?.input);
  const signalText = parsed.signals && parsed.signals.length > 0 ? ` · ${parsed.signals.join(' · ')}` : '';
  const taskDescription = `[${parsed.verb}] ${parsed.target ?? (event.toolName || 'unknown-tool')} · failed${signalText}`;
  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: event.toolId || `tool-error-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId,
    task: {
      targetAgentId: agentId,
      taskDescription,
    },
    agent: agentInfo,
    status: {
      state: 'failed',
      summary: taskDescription,
      details: {
        error: event.payload?.error,
        toolName: event.toolName,
        ...(parsed.signals && parsed.signals.length > 0 ? { signals: parsed.signals } : {}),
        ...(parsed.details ? parsed.details : {}),
      },
    },
    display: {
      title: `${getAgentIcon(agentInfo.agentRole)} ${taskDescription}`,
      subtitle: event.payload?.error,
      icon: getAgentIcon(agentInfo.agentRole),
      level: 'detailed',
    },
  };

  if (ctx.messageHub) {
    await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
  }
}

/**
 * 处理 system_error 事件
 */
export async function handleSystemError(
  event: SystemErrorEvent,
  ctx: HandlerContext,
): Promise<void> {
  const sessionId = event.sessionId;
  const mapping = ctx.resolveEnvelopeMapping(sessionId);
  if (!mapping) return;

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: `system-error-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId,
    task: {
      taskDescription: '系统错误',
    },
    agent: { agentId: 'system' },
    status: {
      state: 'failed',
      summary: event.payload?.error || '系统错误',
      details: { component: event.payload?.component, recoverable: event.payload?.recoverable },
    },
    display: {
      title: '系统错误',
      subtitle: event.payload?.error,
      icon: '⚠️',
      level: 'detailed',
    },
  };

  if (ctx.messageHub) {
    await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
  }
}

/**
 * 处理 dispatch 事件（任务派发）
 */
export async function handleDispatch(
  event: RuntimeEvent,
  ctx: HandlerContext,
): Promise<void> {
  const payload = event.payload as {
    sourceAgentId?: string;
    dispatchId?: string;
    targetAgentId?: string;
    status?: string;
    queuePosition?: number;
    result?: Record<string, unknown>;
    childSessionId?: string;
    sessionId?: string;
  };

  const targetAgentId = payload.targetAgentId;
  if (!targetAgentId) return;

  if (ctx.primaryAgentId && targetAgentId !== ctx.primaryAgentId) {
    ctx.registerChildAgent(targetAgentId, ctx.primaryAgentId);
  }

  const sessionId = event.sessionId;
  const mapping = ctx.resolveEnvelopeMapping(sessionId);
  if (!mapping || !ctx.messageHub) return;


  const agentInfo = await ctx.getAgentInfo(targetAgentId);
  const dispatchStatus = typeof payload.status === 'string' ? payload.status : 'queued';
  const queuePosition = typeof payload.queuePosition === 'number' ? payload.queuePosition : undefined;
  const mailboxMessageId = typeof payload.result?.messageId === 'string' ? payload.result.messageId : undefined;
  const state: WrappedStatusUpdate['status']['state'] = dispatchStatus === 'failed'
    ? 'failed'
    : dispatchStatus === 'completed'
      ? 'completed'
      : 'running';
  const summary = [
    `派发 ${targetAgentId}`,
    `状态: ${dispatchStatus}`,
    typeof queuePosition === 'number' ? `队列 #${queuePosition}` : '',
    mailboxMessageId ? `mailbox: ${mailboxMessageId}` : '',
  ].filter((item) => item.length > 0).join(' · ');

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: payload.dispatchId || `dispatch-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId,
    task: {
      taskId: payload.dispatchId,
      sourceAgentId: payload.sourceAgentId,
      targetAgentId,
      taskDescription: summary,
    },
    agent: agentInfo,
    status: {
      state,
      summary,
      details: {
        dispatchId: payload.dispatchId,
        sourceAgentId: payload.sourceAgentId,
        targetAgentId,
        dispatchStatus,
        ...(typeof queuePosition === 'number' ? { queuePosition } : {}),
        ...(mailboxMessageId ? { mailboxMessageId } : {}),
      },
    },
    display: {
      title: `${getAgentIcon(agentInfo.agentRole)} 派发更新`,
      // avoid duplication: summary is already rendered as status.summary
      subtitle: undefined,
      icon: getAgentIcon(agentInfo.agentRole),
      level: targetAgentId === ctx.primaryAgentId ? 'detailed' : 'summary',
    },
  };

  await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
}

export async function handleWaitingForUser(
  event: RuntimeEvent,
  ctx: HandlerContext,
): Promise<void> {
  const mapping = ctx.resolveEnvelopeMapping(event.sessionId);
  if (!mapping || !ctx.messageHub) return;


  const payload = event.payload as {
    reason?: string;
    options?: Array<{ id?: string; label?: string }>;
    context?: Record<string, unknown>;
  };
  const askContext = payload.context ?? {};
  const question = typeof askContext.question === 'string' && askContext.question.trim().length > 0
    ? askContext.question.trim()
    : '需要你回复后才能继续';
  const options = Array.isArray(payload.options)
    ? payload.options
      .map((item, index) => {
        const label = typeof item?.label === 'string' && item.label.trim().length > 0
          ? item.label.trim()
          : typeof item?.id === 'string' && item.id.trim().length > 0
            ? item.id.trim()
            : '';
        return label ? `${index + 1}. ${label}` : '';
      })
      .filter((item) => item.length > 0)
    : [];
  const extraContext = typeof askContext.context === 'string' && askContext.context.trim().length > 0
    ? askContext.context.trim()
    : '';

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: `waiting-for-user-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    agent: { agentId: typeof askContext.agentId === 'string' ? askContext.agentId : 'unknown-agent' },
    task: { taskDescription: question },
    status: {
      state: 'waiting',
      summary: question,
      details: {
        reason: payload.reason,
        requestId: typeof askContext.requestId === 'string' ? askContext.requestId : undefined,
      },
    },
    display: {
      title: '❓ 需要你回复',
      subtitle: [
        options.length > 0 ? `可选项：\n${options.join('\n')}` : '请直接回复你的答案。',
        extraContext ? `上下文：${extraContext}` : '',
      ].filter(Boolean).join('\n\n'),
      icon: '❓',
      level: 'detailed',
    },
  };

  await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
}

/**
 * 处理 agent_step_completed 事件（step 批量推送）
 */
export async function handleStepCompleted(
  event: RuntimeEvent,
  ctx: HandlerContext,
): Promise<void> {
  const sessionId = event.sessionId;
  const mapping = ctx.resolveEnvelopeMapping(sessionId);
  if (!mapping) return;

  let stepBatch = ctx.stepBatchDefault;
  let stepUpdatesEnabled = true;
  if (ctx.channelBridgeManager) {
    const pushSettings = ctx.channelBridgeManager.getPushSettings(mapping.envelope.channel);
    stepUpdatesEnabled = pushSettings.stepUpdates;
    stepBatch = Math.max(1, pushSettings.stepBatch);
  }
  if (!stepUpdatesEnabled) return;

  const payload = event.payload as {
    round?: number;
    thought?: string;
    action?: string;
    observation?: string;
    success?: boolean;
  };
  const round = payload.round ?? 0;
  const action = (payload.action || '').trim();
  const thought = (payload.thought || '').trim();
  const observation = (payload.observation || '').trim();

  // Jason 要求：reasoning 不要批量，收到就立刻推送
  if (thought && ctx.sendReasoningUpdate) {
    const stepAgentId = typeof (event as { agentId?: unknown }).agentId === 'string'
      ? ((event as { agentId?: string }).agentId as string)
      : (ctx.primaryAgentId || 'unknown-agent');
    await ctx.sendReasoningUpdate(sessionId, stepAgentId, thought);
  }

  const actionSummary = action
    ? (observation ? `操作: ${action}\n观察: ${observation}` : `操作: ${action}`)
    : '';
  const summary = actionSummary || (!thought ? `步骤 ${round}` : '');
  if (!summary) {
    return;
  }

  const buffer = ctx.stepBuffer.get(sessionId) || [];
  buffer.push({ index: round, summary, timestamp: event.timestamp as string });
  ctx.stepBuffer.set(sessionId, buffer);

  if (buffer.length >= stepBatch) {
    await flushStepBuffer(sessionId, mapping, ctx);
  }
}

/**
 * 刷新 step buffer，批量发送到通道
 */
export async function flushStepBuffer(
  sessionId: string,
  mapping: SessionEnvelopeMapping,
  ctx: HandlerContext,
): Promise<void> {
  const buffer = ctx.stepBuffer.get(sessionId);
  if (!buffer || buffer.length === 0) return;

  ctx.stepBuffer.delete(sessionId);

  if (!ctx.messageHub) return;

  const lines = buffer.map((s, i) => `${i + 1}) ${s.summary}`).join('\n');
  const content = `📋 中间步骤（${buffer.length}）:\n${lines}`;

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: `batch-steps-${Date.now()}`,
    timestamp: new Date().toISOString(),
    sessionId,
    agent: { agentId: 'batch-steps' },
    task: { taskDescription: `执行了 ${buffer.length} 个步骤` },
    status: {
      state: 'running',
      summary: `执行了 ${buffer.length} 个步骤`,
    },
    display: {
      title: '📋 中间步骤',
      subtitle: content,
      icon: '🔄',
      level: 'detailed',
    },
  };

  await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
  log.debug(`[AgentStatusSubscriber] Flushed ${buffer.length} steps for session ${sessionId}`);
}
