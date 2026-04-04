import { logger } from '../../core/logger.js';
import { appendFile, mkdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { ChatCodexLoopEvent } from '../../agents/finger-general/finger-general-module.js';
import type { AgentDispatchRequest } from '../../server/modules/agent-runtime/types.js';
import type { AgentStatusSubscriber } from '../../server/modules/agent-status-subscriber.js';
import { isObjectRecord } from '../../server/common/object.js';
import {
  buildDispatchFeedbackPayload,
  buildLedgerPointerInfo,
  extractAssistantBodyUpdate,
  extractDispatchResultTags,
  extractDispatchResultTopic,
  extractLoopToolTrace,
  formatLedgerPointerContent,
} from '../../server/modules/event-forwarding-helpers.js';
import {
  isStopReasoningStopTool,
  resolveStopReasoningPolicy,
} from '../../common/stop-reasoning-policy.js';
import { resolveControlBlockPolicy } from '../../common/control-block.js';
import { attachBroadcastHandlers } from '../../server/modules/event-forwarding-handlers.js';
import { buildDispatchResultEnvelope } from '../../server/modules/mailbox-envelope.js';
import { heartbeatMailbox } from '../../server/modules/heartbeat-mailbox.js';
import { normalizeDispatchLedgerSessionId as _normalizeDispatchLedgerSessionId } from '../../server/modules/event-forwarding-session-utils.js';
import { applyExecutionLifecycleTransition } from '../../server/modules/execution-lifecycle.js';
import { getExecutionLifecycleState } from '../../server/modules/execution-lifecycle.js';
import {
  attachControlLifecycleForwarding,
  attachDispatchLifecycleForwarding,
} from '../../server/modules/event-forwarding-runtime-events.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { clockTool } from '../../tools/internal/codex-clock-tool.js';
import { contextBuilderRebuildTool } from '../../tools/internal/context-builder-rebuild-tool.js';

const SYSTEM_AGENT_ID = 'finger-system-agent';
const CONTROL_HOOK_DEDUP_TTL_MS = 60 * 60_000;

type SessionEventRecord = {
  type: 'tool_call' | 'tool_result' | 'tool_error' | 'agent_step' | 'reasoning';
  timestamp?: string;
  agentId?: string;
  toolName?: string;
  toolStatus?: 'success' | 'error';
  toolDurationMs?: number;
  toolInput?: unknown;
  toolOutput?: unknown;
  metadata?: Record<string, unknown>;
};
export interface EventForwardingDeps {
  eventBus: UnifiedEventBus;
  broadcast: (message: unknown) => void;
  sessionManager: SessionManager;
  agentStatusSubscriber?: AgentStatusSubscriber;
  runtimeInstructionBus: { push: (workflowId: string, content: string) => void };
  inferAgentRoleLabel: (agentId: string) => string;
  formatDispatchResultContent: (result: unknown, error?: string) => string;
  asString: (value: unknown) => string | undefined;
  generalAgentId: string;
  isAgentBusy?: (agentId: string) => boolean | Promise<boolean>;
  dispatchTaskToAgent?: (request: AgentDispatchRequest) => Promise<unknown>;
  resolveReviewPolicy?: () => { enabled: boolean; dispatchReviewMode?: 'off' | 'always' };
  runtime?: {
    maybeAutoCompact?: (sessionId: string, contextUsagePercent?: number, turnId?: string) => Promise<boolean>;
    maybeAutoDigestOnStop?: (sessionId: string, turnId?: string) => Promise<boolean>;
  };
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function extractStopSummaryText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const parsedSummary = asTrimmedString(parsed?.summary)
        ?? asTrimmedString(parsed?.message)
        ?? asTrimmedString(parsed?.result);
      return parsedSummary ?? trimmed;
    } catch {
      return trimmed;
    }
  }
  if (!isObjectRecord(value)) return undefined;
  return asTrimmedString(value.summary)
    ?? asTrimmedString(value.message)
    ?? asTrimmedString(value.result)
    ?? undefined;
}

function extractStopSummaryFromToolPayload(
  payload: Record<string, unknown>,
  stopToolNames: string[],
): string | undefined {
  const eventType = asTrimmedString(payload.type)?.toLowerCase();
  if (eventType !== 'tool_result') return undefined;
  const toolName = asTrimmedString(payload.toolName)
    ?? asTrimmedString(payload.tool)
    ?? asTrimmedString(payload.name)
    ?? '';
  if (!toolName || !isStopReasoningStopTool(toolName, stopToolNames)) return undefined;
  return extractStopSummaryText(payload.output)
    ?? extractStopSummaryText(payload.result)
    ?? extractStopSummaryText(payload.response)
    ?? extractStopSummaryText(payload.message);
}

function extractControlHookNames(payload: Record<string, unknown>): string[] {
  const raw = payload.controlHookNames;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .filter((item, index, arr) => arr.indexOf(item) === index)
    .slice(0, 64);
}

function parseInteger(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  }
  return fallback;
}

function toUniqueStringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
  const deduped = normalized.filter((item, index, arr) => arr.indexOf(item) === index);
  return deduped.slice(0, limit);
}

function normalizeReasoningForHistory(text: string): string {
  const source = text.trim();
  if (!source) return '';
  const maxChars = 1600;
  const clipped = source.length > maxChars
    ? `${source.slice(0, maxChars)}\n...[reasoning truncated]`
    : source;
  return [
    '<context_priority tier="P2.reasoning" foldable="true">',
    clipped,
    '</context_priority>',
  ].join('\n');
}

function isTerminalLifecycleStage(stage: unknown): stage is 'completed' | 'failed' | 'interrupted' {
  return stage === 'completed' || stage === 'failed' || stage === 'interrupted';
}

function shouldIgnoreStaleKernelEventAfterTerminal(params: {
  sessionManager: SessionManager;
  sessionId: string;
  payload: Record<string, unknown>;
}): boolean {
  const lifecycle = getExecutionLifecycleState(params.sessionManager, params.sessionId);
  if (!lifecycle || !isTerminalLifecycleStage(lifecycle.stage)) return false;

  const payloadTurnId = asTrimmedString(params.payload.responseId)
    ?? asTrimmedString(params.payload.turnId)
    ?? undefined;
  const lifecycleTurnId = asTrimmedString(lifecycle.turnId);

  // Guard against out-of-order kernel events arriving after terminal turn closure.
  // We only allow through when payload explicitly carries a different turn id
  // (possible new turn telemetry). Missing/identical turn id is treated as stale.
  if (!payloadTurnId || !lifecycleTurnId || payloadTurnId === lifecycleTurnId) {
    return true;
  }
  return false;
}

function asControlBlockRecord(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!isObjectRecord(payload.controlBlock)) return undefined;
  return payload.controlBlock;
}

async function appendMarkdownEntry(params: {
  filePath: string;
  title: string;
  idempotencyKey: string;
  lines: string[];
}): Promise<{ written: boolean; filePath: string }> {
  const normalizedLines = params.lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (normalizedLines.length === 0) {
    return { written: false, filePath: params.filePath };
  }

  await mkdir(dirname(params.filePath), { recursive: true });
  let existing = '';
  try {
    existing = await readFile(params.filePath, 'utf-8');
  } catch {
    existing = '';
  }
  if (existing.includes(`idempotency_key: ${params.idempotencyKey}`)) {
    return { written: false, filePath: params.filePath };
  }
  const ts = new Date().toISOString();
  const section = [
    '',
    `## ${params.title}`,
    `- idempotency_key: ${params.idempotencyKey}`,
    `- updated_at: ${ts}`,
    ...normalizedLines.map((line) => `- ${line}`),
    '',
  ].join('\n');
  await appendFile(params.filePath, section, 'utf-8');
  return { written: true, filePath: params.filePath };
}


export function attachEventForwarding(deps: EventForwardingDeps): {
  emitLoopEventToEventBus: (event: ChatCodexLoopEvent) => void;
} {
  const {
    eventBus,
    broadcast,
    sessionManager,
    agentStatusSubscriber,
    runtimeInstructionBus,
    inferAgentRoleLabel,
    formatDispatchResultContent,
    asString,
    generalAgentId,
    isAgentBusy,
    dispatchTaskToAgent,
    resolveReviewPolicy,
    runtime,
  } = deps;
  const latestBodyBySession = new Map<string, string>();
  const latestStopSummaryBySession = new Map<string, string>();
  const stopToolSeenBySession = new Map<string, boolean>();
  const sessionPersistQueue = new Map<string, Promise<void>>();
  const finalReplyDedupKeys = new Map<string, string>();
  const dispatchLedgerDedup = new Map<string, number>();
  const controlHookActionDedup = new Map<string, number>();
  const DISPATCH_LEDGER_DEDUP_TTL_MS = 10 * 60_000;

  const normalizeDispatchLedgerSessionId = (rawSessionId: string | undefined) =>
    _normalizeDispatchLedgerSessionId(sessionManager, rawSessionId);

  const resolveSessionOwnerAgentId = (sessionId: string): string => {
    if (typeof (sessionManager as SessionManager & { getSession?: unknown }).getSession !== 'function') {
      return generalAgentId;
    }
    const session = sessionManager.getSession(sessionId);
    if (session && isObjectRecord(session.context)) {
      const owner = asTrimmedString(session.context.ownerAgentId);
      if (owner) return owner;
    }
    return generalAgentId;
  };


  const shouldSkipDispatchLedgerEntry = (key: string): boolean => {
    const now = Date.now();
    for (const [existingKey, ts] of dispatchLedgerDedup.entries()) {
      if (now - ts > DISPATCH_LEDGER_DEDUP_TTL_MS) {
        dispatchLedgerDedup.delete(existingKey);
      }
    }
    if (dispatchLedgerDedup.has(key)) return true;
    dispatchLedgerDedup.set(key, now);
    return false;
  };

  const shouldSkipControlHookAction = (key: string): boolean => {
    const now = Date.now();
    for (const [existingKey, ts] of controlHookActionDedup.entries()) {
      if (now - ts > CONTROL_HOOK_DEDUP_TTL_MS) {
        controlHookActionDedup.delete(existingKey);
      }
    }
    if (controlHookActionDedup.has(key)) return true;
    controlHookActionDedup.set(key, now);
    return false;
  };

  const emitControlHookActionNotice = (
    event: ChatCodexLoopEvent,
    hook: string,
    action: string,
    detail?: Record<string, unknown>,
  ): void => {
    void eventBus.emit({
      type: 'system_notice',
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      payload: {
        source: 'control_hook_action',
        hook,
        action,
        ...(detail ?? {}),
      },
    });
  };

  const executeControlHookActions = async (event: ChatCodexLoopEvent): Promise<void> => {
    if (event.phase !== 'turn_complete') return;
    if (!isObjectRecord(event.payload)) return;
    const payload = event.payload as Record<string, unknown>;
    const hooks = extractControlHookNames(payload);
    if (hooks.length === 0) return;
    const hookSet = new Set(hooks);
    const waitingUserHookActive = hookSet.has('hook.waiting_user');
    const controlBlock = asControlBlockRecord(payload);
    const turnId = asTrimmedString(payload.responseId) ?? `turn-${Date.now()}`;
    const session = sessionManager.getSession(event.sessionId);
    const projectPath = session?.projectPath || process.cwd();
    const ownerAgentId = session && isObjectRecord(session.context) && typeof session.context.ownerAgentId === 'string'
      ? session.context.ownerAgentId.trim() || generalAgentId
      : generalAgentId;
    const controlHint = controlBlock && typeof controlBlock.context_review_hint === 'string'
      ? controlBlock.context_review_hint.trim().toLowerCase()
      : 'none';
    const controlWait = controlBlock && isObjectRecord(controlBlock.wait) ? controlBlock.wait : undefined;
    const userSignal = controlBlock && isObjectRecord(controlBlock.user_signal) ? controlBlock.user_signal : undefined;
    const learning = controlBlock && isObjectRecord(controlBlock.learning) ? controlBlock.learning : undefined;
    const flowPatch = learning && isObjectRecord(learning.flow_patch) ? learning.flow_patch : undefined;
    const memoryPatch = learning && isObjectRecord(learning.memory_patch) ? learning.memory_patch : undefined;
    const userProfilePatch = learning && isObjectRecord(learning.user_profile_patch) ? learning.user_profile_patch : undefined;
    const antiPatterns = toUniqueStringArray(controlBlock?.anti_patterns, 32);
    const sessionManagerWithLedgerRoot = sessionManager as SessionManager & {
      resolveLedgerRootForSession?: (sessionId: string) => string | null;
    };
    const sessionLedgerRoot = typeof sessionManagerWithLedgerRoot.resolveLedgerRootForSession === 'function'
      ? sessionManagerWithLedgerRoot.resolveLedgerRootForSession(event.sessionId) ?? undefined
      : undefined;

    for (const hook of hooks) {
      const dedupeKey = `${event.sessionId}|${turnId}|${hook}`;
      if (shouldSkipControlHookAction(dedupeKey)) continue;
      try {
        if (hook === 'hook.waiting_user') {
          await eventBus.emit({
            type: 'waiting_for_user',
            workflowId: event.sessionId,
            sessionId: event.sessionId,
            timestamp: event.timestamp,
            payload: {
              reason: 'confirmation_required',
              options: [],
              context: {
                question: '模型标记当前轮需要用户输入，等待用户回复后继续。',
                source: 'control_hook',
                hook,
                controlBlockValid: payload.controlBlockValid === true,
              },
            },
          });
          emitControlHookActionNotice(event, hook, 'emitted_waiting_for_user');
          continue;
        }

        if (hook === 'hook.scheduler.wait') {
          const waitEnabled = controlWait ? controlWait.enabled === true : false;
          const waitSeconds = Math.max(1, Math.min(86_400, parseInteger(controlWait?.seconds, 0)));
          if (!waitEnabled || waitSeconds <= 0) {
            emitControlHookActionNotice(event, hook, 'skipped_invalid_wait_config');
            continue;
          }
          const waitReason = typeof controlWait?.reason === 'string' ? controlWait.reason.trim() : '';
          const waitPrompt = [
            '[CONTROL HOOK RESUME]',
            `source_session=${event.sessionId}`,
            `source_turn=${turnId}`,
            `hook=${hook}`,
            waitReason ? `reason=${waitReason}` : '',
            'Please resume the unfinished task and continue execution from the latest state.',
          ].filter((line) => line.length > 0).join('\n');
          const timerResult = await clockTool.execute(
            {
              action: 'create',
              payload: {
                message: `control_hook.wait ${event.sessionId}`,
                schedule_type: 'delay',
                delay_seconds: waitSeconds,
                repeat: false,
                inject: {
                  agentId: ownerAgentId,
                  sessionId: event.sessionId,
                  projectPath,
                  prompt: waitPrompt,
                },
              },
            },
            {
              invocationId: `control-hook-wait-${Date.now()}`,
              cwd: projectPath,
              timestamp: new Date().toISOString(),
              sessionId: event.sessionId,
              agentId: ownerAgentId,
              channelId: 'system',
            },
          );
          emitControlHookActionNotice(event, hook, 'scheduled_wait_resume', {
            waitSeconds,
            timerId: timerResult.timer_id,
          });
          continue;
        }

        if (hook === 'hook.context.review') {
          const mode = controlHint === 'aggressive' ? 'aggressive' : 'moderate';
          const rebuildResult = await contextBuilderRebuildTool.execute(
            {
              session_id: event.sessionId,
              agent_id: ownerAgentId,
              mode,
              current_prompt: typeof payload.replyPreview === 'string' ? payload.replyPreview : undefined,
              _runtime_context: {
                ...(sessionLedgerRoot ? { root_dir: sessionLedgerRoot } : {}),
              },
            },
            {
              invocationId: `control-hook-rebuild-${Date.now()}`,
              cwd: projectPath,
              timestamp: new Date().toISOString(),
              sessionId: event.sessionId,
              agentId: ownerAgentId,
              channelId: 'system',
            },
          );
          emitControlHookActionNotice(event, hook, 'rebuild_applied', {
            buildMode: rebuildResult.buildMode,
            selectedBlockCount: rebuildResult.selectedBlockIds.length,
          });
          continue;
        }

        if (hook === 'hook.digest.negative') {
          const digested = typeof runtime?.maybeAutoDigestOnStop === 'function'
            ? await runtime.maybeAutoDigestOnStop(event.sessionId, `${turnId}:negative`)
            : false;
          emitControlHookActionNotice(event, hook, 'digest_incremental_triggered', { digested });
          continue;
        }

        if (hook === 'hook.digest.defer_positive') {
          emitControlHookActionNotice(event, hook, 'deferred_to_compaction');
          continue;
        }

        if (hook === 'hook.user.profile.update' || hook === 'hook.user.guardrails.candidate') {
          const userPatchItems = toUniqueStringArray(userProfilePatch?.items, 64);
          const why = typeof userSignal?.why === 'string' ? userSignal.why.trim() : '';
          const negativeScore = parseInteger(userSignal?.negative_score, 0);
          const lines = [
            `source_session: ${event.sessionId}`,
            `source_turn: ${turnId}`,
            `hook: ${hook}`,
            `negative_score: ${negativeScore}`,
            ...(why ? [`reason: ${why}`] : []),
            ...antiPatterns.map((item) => `anti_pattern: ${item}`),
            ...userPatchItems.map((item) => `profile_patch: ${item}`),
          ];
          const writeResult = await appendMarkdownEntry({
            filePath: join(FINGER_PATHS.home, 'USER.md'),
            title: `Control Hook Update (${hook})`,
            idempotencyKey: dedupeKey,
            lines,
          });
          emitControlHookActionNotice(event, hook, writeResult.written ? 'user_profile_appended' : 'user_profile_skipped', {
            filePath: writeResult.filePath,
          });
          continue;
        }

        if (hook === 'hook.dispatch' || hook === 'hook.reviewer') {
          if (waitingUserHookActive) {
            emitControlHookActionNotice(event, hook, 'skipped_due_to_waiting_user');
            continue;
          }
          if (typeof dispatchTaskToAgent !== 'function') {
            emitControlHookActionNotice(event, hook, 'skipped_dispatch_bridge_unavailable');
            continue;
          }
          const enforcePrompt = [
            '[CONTROL HOOK ENFORCEMENT]',
            `hook=${hook}`,
            `session=${event.sessionId}`,
            `turn=${turnId}`,
            'The previous turn indicates mandatory control action is still pending.',
            hook === 'hook.dispatch'
              ? 'You must perform required task dispatch now and keep task identity/ownership consistent.'
              : 'You must trigger required reviewer path now with explicit review payload and evidence.',
          ].join('\n');
          const dispatchResult = await dispatchTaskToAgent({
            sourceAgentId: 'control-hook-enforcer',
            targetAgentId: ownerAgentId,
            task: { prompt: enforcePrompt },
            sessionId: event.sessionId,
            metadata: {
              source: 'control_hook',
              role: 'system',
              controlHook: hook,
              controlHookTurnId: turnId,
              controlHookEnforced: true,
            },
            blocking: false,
            queueOnBusy: true,
            maxQueueWaitMs: 60_000,
          });
          emitControlHookActionNotice(event, hook, 'enforcement_dispatched', {
            targetAgentId: ownerAgentId,
            result: isObjectRecord(dispatchResult) ? dispatchResult.status ?? dispatchResult.ok : undefined,
          });
          continue;
        }

        if (hook === 'hook.project.flow.update') {
          const changes = toUniqueStringArray(flowPatch?.changes, 64);
          const lines = [
            `source_session: ${event.sessionId}`,
            `source_turn: ${turnId}`,
            ...changes.map((item) => `flow_change: ${item}`),
          ];
          const writeResult = await appendMarkdownEntry({
            filePath: join(projectPath, 'FLOW.md'),
            title: 'Control Hook Flow Patch',
            idempotencyKey: dedupeKey,
            lines,
          });
          emitControlHookActionNotice(event, hook, writeResult.written ? 'flow_appended' : 'flow_skipped', {
            filePath: writeResult.filePath,
          });
          continue;
        }

        if (hook === 'hook.project.memory.update') {
          const longTerm = toUniqueStringArray(memoryPatch?.long_term_items, 64);
          const shortTerm = toUniqueStringArray(memoryPatch?.short_term_items, 64);
          const lines = [
            `source_session: ${event.sessionId}`,
            `source_turn: ${turnId}`,
            ...longTerm.map((item) => `long_term: ${item}`),
            ...shortTerm.map((item) => `short_term: ${item}`),
          ];
          const writeResult = await appendMarkdownEntry({
            filePath: join(projectPath, 'MEMORY.md'),
            title: 'Control Hook Memory Patch',
            idempotencyKey: dedupeKey,
            lines,
          });
          emitControlHookActionNotice(event, hook, writeResult.written ? 'memory_appended' : 'memory_skipped', {
            filePath: writeResult.filePath,
          });
          continue;
        }

        // For remaining hooks, emit explicit action notice to make it auditable.
        emitControlHookActionNotice(event, hook, 'acknowledged_noop');
      } catch (error) {
        logger.module('event-forwarding').warn('Failed to execute control hook action', {
          sessionId: event.sessionId,
          hook,
          turnId,
          error: error instanceof Error ? error.message : String(error),
        });
        emitControlHookActionNotice(event, hook, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const enqueueSessionPersist = (sessionId: string, task: () => Promise<void>): Promise<void> => {
    const previous = sessionPersistQueue.get(sessionId);
    const runTask = () => task();
    const chained = (previous
      ? previous.catch(() => undefined).then(runTask)
      : (() => {
        try {
          return Promise.resolve(runTask());
        } catch (error) {
          return Promise.reject(error);
        }
      })())
      .catch((error) => {
        logger.module('event-forwarding').warn('Session event persistence failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (sessionPersistQueue.get(sessionId) === chained) {
          sessionPersistQueue.delete(sessionId);
        }
      });
    sessionPersistQueue.set(sessionId, chained);
    return chained;
  };

  const persistSessionEventMessage = (
    sessionId: string,
    content: string,
    detail: SessionEventRecord,
    role: 'user' | 'assistant' | 'system' | 'orchestrator' = 'system',
  ): Promise<void> => {
    if (!sessionId || sessionId.trim().length === 0) return Promise.resolve();
    return enqueueSessionPersist(sessionId, async () => {
      await sessionManager.addMessage(sessionId, role, content, {
        ...detail,
        ...(detail.timestamp ? { timestamp: detail.timestamp } : {}),
      });
    });
  };

  const hasLedgerPointerMessage = (sessionId: string, label: string): boolean => {
    const messages = sessionManager.getMessages(sessionId, 0);
    return messages.some((message) => message.type === 'ledger_pointer'
      && isObjectRecord(message.metadata)
      && isObjectRecord(message.metadata.ledgerPointer)
      && message.metadata.ledgerPointer.label === label);
  };

  const addLedgerPointerMessage = (sessionId: string, label: string, agentId: string): void => {
    if (!sessionId || sessionId.trim().length === 0) return;
    if (hasLedgerPointerMessage(sessionId, label)) return;
    const pointerInfo = buildLedgerPointerInfo({ sessionId, agentId });
    const content = formatLedgerPointerContent(pointerInfo, label);
    void sessionManager.addMessage(sessionId, 'system', content, {
      type: 'ledger_pointer',
      agentId,
      metadata: {
        ledgerPointer: {
          label,
          ...pointerInfo,
        },
      },
    });
  };

  const resolveStopGateState = (event: ChatCodexLoopEvent): {
    requiresStopTool: boolean;
    stopToolSeen: boolean;
    stopToolGateApplied: boolean;
    stopToolGateAttempt: number;
    stopToolMaxAutoContinueTurns: number;
    stopToolGateDisabled: boolean;
    stopToolGateExhausted: boolean;
    controlGateHold: boolean;
    controlBlockGateApplied: boolean;
    controlBlockGateAttempt: number;
    controlBlockMaxAutoContinueTurns: number;
    controlGateDisabled: boolean;
    controlGateExhausted: boolean;
    holding: boolean;
    holdReason?: string;
  } => {
    const policy = resolveStopReasoningPolicy(event.payload);
    const requiresStopTool = policy.requireToolForStop;
    const stopToolSeen = stopToolSeenBySession.get(event.sessionId) === true;
    const stopToolMaxAutoContinueTurns = Math.max(
      0,
      parseInteger(event.payload.stopToolMaxAutoContinueTurns, policy.maxAutoContinueTurns),
    );
    const stopToolGateAttempt = Math.max(0, parseInteger(event.payload.stopToolGateAttempt, 0));
    const stopToolGateApplied = event.payload.stopToolGateApplied === true || stopToolGateAttempt > 0;
    const stopToolGateDisabled = stopToolMaxAutoContinueTurns <= 0;
    const stopToolGateExhausted = stopToolGateApplied
      && stopToolMaxAutoContinueTurns > 0
      && stopToolGateAttempt >= stopToolMaxAutoContinueTurns;

    const controlPolicy = resolveControlBlockPolicy(event.payload);
    const controlBlockMaxAutoContinueTurns = Math.max(
      0,
      parseInteger(event.payload.controlBlockMaxAutoContinueTurns, controlPolicy.maxAutoContinueTurns),
    );
    const controlBlockGateAttempt = Math.max(0, parseInteger(event.payload.controlBlockGateAttempt, 0));
    const controlBlockGateApplied = event.payload.controlBlockGateApplied === true || controlBlockGateAttempt > 0;
    const controlGateDisabled = controlBlockMaxAutoContinueTurns <= 0;
    const controlGateExhausted = controlBlockGateApplied
      && controlBlockMaxAutoContinueTurns > 0
      && controlBlockGateAttempt >= controlBlockMaxAutoContinueTurns;

    const finishReason = event.phase === 'turn_complete' && typeof event.payload.finishReason === 'string'
      ? event.payload.finishReason.trim().toLowerCase()
      : '';
    const pendingInputAccepted = event.phase === 'turn_complete' && event.payload.pendingInputAccepted === true;
    const stopToolHoldingCandidate = event.phase === 'turn_complete'
      && finishReason === 'stop'
      && !pendingInputAccepted
      && requiresStopTool
      && !stopToolSeen;
    const stopToolHolding = stopToolHoldingCandidate
      && !stopToolGateDisabled
      && !stopToolGateExhausted;
    const controlGateHoldCandidate = event.phase === 'turn_complete'
      && finishReason === 'stop'
      && !pendingInputAccepted
      && parseBoolean(event.payload.controlGateHold, false);
    const controlGateHold = controlGateHoldCandidate
      && !controlGateDisabled
      && !controlGateExhausted;
    const holding = stopToolHolding || controlGateHold;
    const holdReason = stopToolHolding
      ? 'finish_reason=stop but reasoning.stop was not called'
      : controlGateHold
        ? 'finish_reason=stop but control block is missing/invalid or evidence is not ready'
        : undefined;
    return {
      requiresStopTool,
      stopToolSeen,
      stopToolGateApplied,
      stopToolGateAttempt,
      stopToolMaxAutoContinueTurns,
      stopToolGateDisabled,
      stopToolGateExhausted,
      controlGateHold,
      controlBlockGateApplied,
      controlBlockGateAttempt,
      controlBlockMaxAutoContinueTurns,
      controlGateDisabled,
      controlGateExhausted,
      holding,
      holdReason,
    };
  };
  const emitLoopEventToEventBus = (event: ChatCodexLoopEvent): void => {
    if (!event.sessionId || event.sessionId === 'unknown') return;
    if (event.phase === 'turn_start') {
      stopToolSeenBySession.set(event.sessionId, false);
      latestStopSummaryBySession.delete(event.sessionId);
      applyExecutionLifecycleTransition(sessionManager, event.sessionId, {
        stage: 'running',
        substage: 'turn_start',
        updatedBy: 'event-forwarding',
        finishReason: null,
        allowFromTerminal: true,
      });
    } else if (event.phase === 'turn_complete') {
      const pendingInputAccepted = event.payload.pendingInputAccepted === true;
      const finishReason = typeof event.payload.finishReason === 'string' && event.payload.finishReason.trim().length > 0
        ? event.payload.finishReason.trim()
        : undefined;
      const isFinishedStop = finishReason === 'stop';
      const stopGateState = resolveStopGateState(event);
      applyExecutionLifecycleTransition(sessionManager, event.sessionId, {
        stage: pendingInputAccepted
          ? 'running'
          : isFinishedStop
            ? 'completed'
            : 'interrupted',
        substage: pendingInputAccepted
          ? 'pending_input_queued'
          : isFinishedStop
            ? stopGateState.holding
              ? 'turn_complete_gate_warning'
              : 'turn_complete'
            : 'turn_incomplete',
        updatedBy: 'event-forwarding',
        turnId: typeof event.payload.responseId === 'string' ? event.payload.responseId : undefined,
        finishReason: finishReason ?? null,
        detail: pendingInputAccepted
          ? (typeof event.payload.pendingTurnId === 'string' ? `pendingTurn=${event.payload.pendingTurnId}` : 'pending input accepted')
          : typeof event.payload.replyPreview === 'string'
            ? event.payload.replyPreview.slice(0, 120)
            : stopGateState.holdReason,
        lastError: null,
      });
    } else if (event.phase === 'turn_error') {
      const errorMessage = typeof event.payload.error === 'string' ? event.payload.error : 'turn_error';
      const normalizedError = errorMessage.toLowerCase();
      applyExecutionLifecycleTransition(sessionManager, event.sessionId, {
        stage: normalizedError.includes('interrupt') ? 'interrupted' : 'failed',
        substage: normalizedError.includes('interrupt') ? 'turn_interrupted' : 'turn_error',
        updatedBy: 'event-forwarding',
        lastError: normalizedError.includes('interrupt') ? null : errorMessage,
        detail: errorMessage,
        timeoutMs: typeof event.payload.timeoutMs === 'number' ? event.payload.timeoutMs : undefined,
        recoveryAction: asString(event.payload.recoveryAction)
          ?? (normalizedError.includes('interrupt') ? 'interrupted' : 'failed'),
      });
    } else if (event.phase === 'kernel_event' && isObjectRecord(event.payload)) {
      if (shouldIgnoreStaleKernelEventAfterTerminal({
        sessionManager,
        sessionId: event.sessionId,
        payload: event.payload,
      })) {
        logger.module('event-forwarding').debug('[EventForwarding] Ignore stale kernel_event after terminal lifecycle', {
          sessionId: event.sessionId,
          payloadType: asTrimmedString(event.payload.type) ?? 'unknown',
          payloadTurnId: asTrimmedString(event.payload.responseId) ?? asTrimmedString(event.payload.turnId),
        });
        return;
      }
      if (event.payload.type === 'tool_call') {
        const toolName = typeof event.payload.toolName === 'string' ? event.payload.toolName.trim() : '';
        const policy = resolveStopReasoningPolicy();
        if (isStopReasoningStopTool(toolName, policy.stopToolNames)) {
          stopToolSeenBySession.set(event.sessionId, true);
        }
      } else if (event.payload.type === 'tool_result') {
        const policy = resolveStopReasoningPolicy();
        const stopSummary = extractStopSummaryFromToolPayload(event.payload, policy.stopToolNames);
        if (typeof stopSummary === 'string' && stopSummary.trim().length > 0) {
          latestStopSummaryBySession.set(event.sessionId, stopSummary.trim());
        }
      }
      if (event.payload.type === 'tool_call') {
        applyExecutionLifecycleTransition(sessionManager, event.sessionId, {
          stage: 'waiting_tool',
          substage: 'tool_call',
          updatedBy: 'event-forwarding',
          toolName: asString(event.payload.toolName),
          detail: asString(event.payload.toolId),
        });
      } else if (
        event.payload.type === 'tool_result'
        || event.payload.type === 'tool_error'
        || event.payload.type === 'model_round'
        || event.payload.type === 'reasoning'
      ) {
        applyExecutionLifecycleTransition(sessionManager, event.sessionId, {
          stage: 'waiting_model',
          substage: event.payload.type,
          updatedBy: 'event-forwarding',
          toolName: event.payload.type === 'tool_result' || event.payload.type === 'tool_error'
            ? asString(event.payload.toolName)
            : undefined,
          turnId: event.payload.type === 'model_round' ? asString(event.payload.responseId) : undefined,
          detail: event.payload.type === 'tool_error'
            ? asString(event.payload.error)
            : event.payload.type === 'reasoning'
              ? asString(event.payload.text)?.slice(0, 120)
              : undefined,
          lastError: event.payload.type === 'tool_error' ? asString(event.payload.error) : null,
        });
      } else if (event.payload.type === 'turn_retry') {
        applyExecutionLifecycleTransition(sessionManager, event.sessionId, {
          stage: 'retrying',
          substage: 'turn_retry',
          updatedBy: 'event-forwarding',
          detail: typeof event.payload.attempt === 'number' ? `attempt=${event.payload.attempt}` : undefined,
          lastError: asString(event.payload.error),
          timeoutMs: typeof event.payload.timeoutMs === 'number' ? event.payload.timeoutMs : undefined,
          retryDelayMs: typeof event.payload.retryDelayMs === 'number' ? event.payload.retryDelayMs : undefined,
          recoveryAction: asString(event.payload.recoveryAction) ?? 'retry',
          incrementRetry: true,
        });
      }
    }
    if (event.phase === 'turn_complete' || event.phase === 'turn_error') {
      if (event.phase === 'turn_complete' && isObjectRecord(event.payload)) {
        const controlHooks = extractControlHookNames(event.payload);
        if (controlHooks.length > 0) {
          for (const hookName of controlHooks) {
            void eventBus.emit({
              type: 'system_notice',
              sessionId: event.sessionId,
              timestamp: event.timestamp,
              payload: {
                source: 'control_hook',
                hook: hookName,
                controlBlockValid: event.payload.controlBlockValid === true,
              },
            });
          }
          void executeControlHookActions(event);
        }
      }
      const stopGateState = resolveStopGateState(event);
      const shouldFinalizeTurn = event.phase === 'turn_error' || event.phase === 'turn_complete';
      const finalizeFinishReason = event.phase === 'turn_complete'
        && typeof event.payload.finishReason === 'string'
        ? event.payload.finishReason
        : undefined;
      const finalizeTurnId = event.phase === 'turn_complete'
        && typeof event.payload.responseId === 'string'
        && event.payload.responseId.trim().length > 0
        ? event.payload.responseId.trim()
        : undefined;
      if (event.phase === 'turn_complete' && stopGateState.holding) {
        void eventBus.emit({
          type: 'system_notice',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          payload: {
            source: 'stop_gate',
            hold: true,
            nonBlocking: true,
            holdReason: stopGateState.holdReason ?? null,
            controlGateHold: stopGateState.controlGateHold,
            requiresStopTool: stopGateState.requiresStopTool,
            stopToolSeen: stopGateState.stopToolSeen,
            stopToolGateApplied: stopGateState.stopToolGateApplied,
            stopToolGateAttempt: stopGateState.stopToolGateAttempt,
            stopToolMaxAutoContinueTurns: stopGateState.stopToolMaxAutoContinueTurns,
            stopToolGateDisabled: stopGateState.stopToolGateDisabled,
            stopToolGateExhausted: stopGateState.stopToolGateExhausted,
            controlBlockGateApplied: stopGateState.controlBlockGateApplied,
            controlBlockGateAttempt: stopGateState.controlBlockGateAttempt,
            controlBlockMaxAutoContinueTurns: stopGateState.controlBlockMaxAutoContinueTurns,
            controlGateDisabled: stopGateState.controlGateDisabled,
            controlGateExhausted: stopGateState.controlGateExhausted,
          },
        });
      }

      if (shouldFinalizeTurn) {
        if (event.phase === 'turn_complete' && finalizeFinishReason === 'stop' && runtime?.maybeAutoDigestOnStop) {
          void runtime.maybeAutoDigestOnStop(event.sessionId, finalizeTurnId).catch((error) => {
            logger.module('event-forwarding').warn('Failed to run auto stop digest', {
              sessionId: event.sessionId,
              turnId: finalizeTurnId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        const sessionManagerWithTransientFinalize = sessionManager as {
          finalizeTransientLedgerMode?: (
            sessionId: string,
            options?: { finishReason?: string; keepOnFailure?: boolean },
          ) => Promise<unknown>;
        };
        if (typeof sessionManagerWithTransientFinalize.finalizeTransientLedgerMode === 'function') {
          void sessionManagerWithTransientFinalize.finalizeTransientLedgerMode(event.sessionId, {
            finishReason: finalizeFinishReason,
            keepOnFailure: event.phase === 'turn_error',
          }).catch((err) => {
            logger.module('event-forwarding').warn('Failed to finalize transient ledger mode', {
              sessionId: event.sessionId,
              finishReason: finalizeFinishReason,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        const latestBody = latestBodyBySession.get(event.sessionId);
        const stopSummary = event.phase === 'turn_complete'
          && finalizeFinishReason === 'stop'
          ? latestStopSummaryBySession.get(event.sessionId)
          : undefined;
        const finalReply = event.phase === 'turn_complete'
          ? (stopSummary
            || latestBody
            || (typeof event.payload.replyPreview === 'string' ? event.payload.replyPreview : ''))
          : (typeof event.payload.error === 'string' ? `处理失败：${event.payload.error}` : '处理失败，请稍后再试');
        const normalizedFinalReply = finalReply.trim();
        const finalizeAgentId = asString(event.payload.agentId) ?? resolveSessionOwnerAgentId(event.sessionId);
        let finalReplyPersistPromise: Promise<void> = Promise.resolve();
        if (normalizedFinalReply.length > 0) {
          const dedupTurnKey = `${event.sessionId}::${finalizeTurnId ?? 'no-turn-id'}::${normalizedFinalReply}`;
          const dedupSeen = finalReplyDedupKeys.get(event.sessionId);
          const alreadySeenByTurn = dedupSeen === dedupTurnKey;
          const recentMessages = sessionManager.getMessages(event.sessionId, 8);
          const duplicated = recentMessages.some((message) => (
            message.role === 'assistant'
            && typeof message.content === 'string'
            && message.content.trim() === normalizedFinalReply
            && isObjectRecord(message.metadata)
            && message.metadata.source === 'turn_final_reply'
          ));
          if (!duplicated && !alreadySeenByTurn) {
            finalReplyDedupKeys.set(event.sessionId, dedupTurnKey);
            finalReplyPersistPromise = persistSessionEventMessage(
              event.sessionId,
              normalizedFinalReply,
              {
                type: 'agent_step',
                timestamp: event.timestamp,
                agentId: finalizeAgentId,
                metadata: {
                  source: 'turn_final_reply',
                  phase: event.phase,
                  finishReason: finalizeFinishReason ?? null,
                  hasStopSummary: Boolean(stopSummary),
                  hasLatestBody: Boolean(latestBody),
                },
              },
              'assistant',
            );
          }
        }
        if (agentStatusSubscriber) {
          void finalReplyPersistPromise.finally(() => {
            agentStatusSubscriber.finalizeChannelTurn(
              event.sessionId,
              finalReply,
              finalizeAgentId,
              event.phase === 'turn_complete' && typeof event.payload.finishReason === 'string'
                ? event.payload.finishReason
                : undefined,
            ).catch((err) => {
              logger.module('event-forwarding').error(
                'Failed to finalize channel turn',
                err instanceof Error ? err : new Error(String(err)),
              );
            });
          });
        }
        latestBodyBySession.delete(event.sessionId);
        latestStopSummaryBySession.delete(event.sessionId);
        stopToolSeenBySession.delete(event.sessionId);
      }
    }
    // TODO: implement emitToolStepEventsFromLoopEvent
    // emitToolStepEventsFromLoopEvent(event);

    broadcast({
      type: 'chat_codex_turn',
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      payload: {
        phase: event.phase,
        ...event.payload,
      },
    });

    // On turn_start, inject main session ledger pointer
    if (event.phase === 'turn_start') {
      addLedgerPointerMessage(event.sessionId, 'main', resolveSessionOwnerAgentId(event.sessionId));
    }

    // Reasoning is persisted as lower-priority foldable context (P2),
    // while core dialog (user/assistant final replies) remains highest priority.
    if (event.phase === 'kernel_event' && event.payload.type === 'reasoning') {
      const reasoningText = typeof event.payload.text === 'string'
        ? event.payload.text.trim()
        : '';
      if (reasoningText.length > 0) {
        const reasoningAgentId = typeof event.payload.agentId === 'string' && event.payload.agentId.trim().length > 0
          ? event.payload.agentId.trim()
          : resolveSessionOwnerAgentId(event.sessionId);

        void persistSessionEventMessage(
          event.sessionId,
          normalizeReasoningForHistory(reasoningText),
          {
            type: 'reasoning',
            timestamp: event.timestamp,
            agentId: reasoningAgentId,
            metadata: {
              source: 'kernel_reasoning',
              contextPriority: 'P2.reasoning',
              foldable: true,
              roleProfile: typeof event.payload.roleProfile === 'string' ? event.payload.roleProfile : undefined,
            },
          },
          'system',
        );

        // Send reasoning to channel bridge (QQBot) based on pushSettings.reasoning config
        if (agentStatusSubscriber) {
          agentStatusSubscriber.sendReasoningUpdate(event.sessionId, reasoningAgentId, reasoningText)
            .catch((err) => {
              logger.module('event-forwarding').error(
                'Failed to send reasoning to channel',
                err instanceof Error ? err : new Error(String(err))
              );
            });
        }
      }
    }

    if (event.phase === 'kernel_event' && isObjectRecord(event.payload)) {
      const bodyUpdate = extractAssistantBodyUpdate(event.payload);
      if (bodyUpdate && agentStatusSubscriber) {
        const normalized = bodyUpdate.trim();
        if (normalized.length > 0 && latestBodyBySession.get(event.sessionId) !== normalized) {
          latestBodyBySession.set(event.sessionId, normalized);
          const bodyAgentId = asString(event.payload.agentId) ?? resolveSessionOwnerAgentId(event.sessionId);
          agentStatusSubscriber.sendBodyUpdate(event.sessionId, bodyAgentId, normalized)
            .catch((err) => {
              logger.module('event-forwarding').error(
                'Failed to send body update to channel',
                err instanceof Error ? err : new Error(String(err))
              );
            });
        }
      }
    }

    if (event.phase === 'kernel_event' && event.payload.type === 'model_round') {
      const contextUsagePercent = typeof event.payload.contextUsagePercent === 'number'
        ? event.payload.contextUsagePercent
        : undefined;
      const estimatedTokensInContextWindow =
        typeof event.payload.estimatedTokensInContextWindow === 'number'
          ? event.payload.estimatedTokensInContextWindow
          : undefined;
      const maxInputTokens =
        typeof event.payload.maxInputTokens === 'number'
          ? event.payload.maxInputTokens
          : undefined;
      const contextBreakdown =
        isObjectRecord(event.payload.contextBreakdown)
          ? event.payload.contextBreakdown
          : undefined;
      const turnId = typeof event.payload.responseId === 'string' && event.payload.responseId.trim().length > 0
        ? event.payload.responseId.trim()
        : typeof event.payload.round === 'number'
          ? `round-${event.payload.round}`
          : undefined;
      const modelRoundAgentId = typeof event.payload.agentId === 'string' && event.payload.agentId.trim().length > 0
        ? event.payload.agentId.trim()
        : resolveSessionOwnerAgentId(event.sessionId);
      const hasModelRoundContextStats = contextUsagePercent !== undefined
        || typeof estimatedTokensInContextWindow === 'number'
        || typeof maxInputTokens === 'number'
        || !!contextBreakdown;
      if (hasModelRoundContextStats) {
        void deps.eventBus.emit({
          type: 'system_notice',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          payload: {
            source: 'auto_compact_probe',
            agentId: modelRoundAgentId,
            contextUsagePercent,
            ...(typeof estimatedTokensInContextWindow === 'number'
              ? { estimatedTokensInContextWindow }
              : {}),
            ...(typeof maxInputTokens === 'number' ? { maxInputTokens } : {}),
            ...(contextBreakdown ? { contextBreakdown } : {}),
            turnId,
          },
        });
        if (runtime?.maybeAutoCompact) {
          void runtime.maybeAutoCompact(event.sessionId, contextUsagePercent, turnId)
            .catch((error) => {
              logger.module('event-forwarding').warn('Failed to run auto compact probe', {
                sessionId: event.sessionId,
                contextUsagePercent,
                turnId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        }
      }
    }

    if (event.phase === 'turn_error') {
      void eventBus.emit({
        type: 'system_error',
        sessionId: event.sessionId,
        timestamp: event.timestamp,
        payload: {
          error: typeof event.payload.error === 'string' ? event.payload.error : 'finger-project-agent runner error',
          component: 'finger-project-agent-runner',
          recoverable: true,
        },
      });
    }
  };



  // WebSocket broadcast handlers (extracted to event-forwarding-handlers.ts)
  attachBroadcastHandlers({ eventBus, broadcast, generalAgentId, persistSessionEventMessage });
  attachDispatchLifecycleForwarding({
    eventBus,
    broadcast,
    sessionManager,
    runtimeInstructionBus,
    inferAgentRoleLabel,
    formatDispatchResultContent,
    asString,
    normalizeDispatchLedgerSessionId,
    shouldSkipDispatchLedgerEntry,
    addLedgerPointerMessage,
    isAgentBusy,
    dispatchTaskToAgent,
    resolveReviewPolicy,
  });

  attachControlLifecycleForwarding({
    eventBus,
    sessionManager,
    asString,
  });

  logger.module('event-forwarding').info('EventBus orchestrator feedback forwarding enabled: agent_runtime_dispatch');

  return { emitLoopEventToEventBus };
}
