import type { Express, Request } from 'express';
import { logger } from '../../core/logger.js';

const log = logger.module('message-route');
import { loadOrchestrationConfig } from '../../orchestration/orchestration-config.js';
import type { OrchestrationPromptAgent } from '../../orchestration/orchestration-prompt.js';
import { __chatCodexInternals } from '../../agents/chat-codex/chat-codex-module.js';
import { isObjectRecord } from '../common/object.js';
import { parseSuperCommand } from '../middleware/super-command-parser.js';
import {
  extractSessionIdFromMessagePayload,
  shouldClientPersistSession,
  extractMessageTextForSession,
  extractResultTextForSession,
  withSessionWorkspaceDefaults,
  shouldRetryBlockingMessage,
  resolveBlockingErrorStatus,
} from '../modules/message-session.js';
import { loadFingerConfig, getChannelAuth } from '../../core/config/channel-config.js';
import { getChannelContextManager } from '../../orchestration/channel-context-manager.js';
import { loadUserSettings } from '../../core/user-settings.js';
import { SYSTEM_PROJECT_PATH, getSystemSessionPath } from '../../agents/finger-system-agent/index.js';
import path from 'path';
import type { MessageRouteDeps } from './message-types.js';
import { handleSuperCommand } from './message-super-command.js';
import { handleSystemRouteDelegation } from './message-delegation.js';
import { normalizeDisplayChannels, sendDisplayFanout, sendInputSync } from './message-display.js';
import {
  resolveActiveOrchestrationProfile,
  shouldInjectProfileReviewPolicy,
  withDefaultProfileReviewPolicy,
  isPrimaryOrchestratorTarget,
  isDirectAgentRouteAllowed,
  buildOrchestrationPromptInjection,
  resolveDryRunFlag,
  ensureSessionExists,
  buildChannelId,
  withMessageContent,
  buildAgentEnvelope,
  prefixAgentResponse,
} from './message-helpers.js';

import { inferInboundRole, ensureMessageMetadataRole } from './message-role-utils.js';
import { normalizeProgressDeliveryPolicy } from '../../common/progress-delivery-policy.js';
import { applyExecutionLifecycleTransition } from '../modules/execution-lifecycle.js';
import { mergeSystemTaskState, parseSystemTaskState } from '../../common/system-task-state.js';
import {
  mergeProjectTaskState,
  parseDelegatedProjectTaskRegistry,
  parseProjectTaskState,
  pruneDelegatedRegistryForContextAfterTaskClosed,
} from '../../common/project-task-state.js';
import { appendClosedProjectTaskArchive } from '../../core/project-task-archive.js';
import {
  executeAsyncMessageRoute,
  executeBlockingMessageRoute,
} from './message-route-execution.js';

const TRANSIENT_LEDGER_SOURCE_ALLOWLIST = new Set([
  'system-heartbeat',
  'mailbox-check',
  'clock',
  'news-cron',
  'email-cron',
  'user_notification',
  'mailbox-cli',
]);

function parseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

function isHeartbeatControlSession(session: { id?: string; context?: Record<string, unknown> } | null | undefined): boolean {
  if (!session) return false;
  const sessionId = typeof session.id === 'string' ? session.id.trim() : '';
  const context = session.context && typeof session.context === 'object'
    ? session.context
    : {};
  const sessionTier = typeof context.sessionTier === 'string' ? context.sessionTier.trim() : '';
  const controlPath = typeof context.controlPath === 'string' ? context.controlPath.trim().toLowerCase() : '';
  const controlSession = context.controlSession === true;
  const userInputAllowed = context.userInputAllowed;
  if (sessionTier === 'heartbeat-control') return true;
  if (controlPath === 'heartbeat') return true;
  if (controlSession) return true;
  if (typeof userInputAllowed === 'boolean' && userInputAllowed === false) return true;
  return sessionId.startsWith('hb-session-');
}

function shouldUseTransientLedgerForInboundMessage(message: unknown): {
  enabled: boolean;
  source?: string;
} {
  if (!isObjectRecord(message)) return { enabled: false };
  const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
  const source = typeof metadata.source === 'string' ? metadata.source.trim().toLowerCase() : '';
  const explicit = parseBooleanFlag(metadata.transientLedger ?? metadata.transient_ledger);
  if (explicit === true) return { enabled: true, ...(source ? { source } : {}) };
  if (explicit === false) return { enabled: false, ...(source ? { source } : {}) };
  if (metadata.systemDirectInject === true) return { enabled: true, ...(source ? { source } : {}) };
  if (source && TRANSIENT_LEDGER_SOURCE_ALLOWLIST.has(source)) {
    return { enabled: true, source };
  }
  return { enabled: false, ...(source ? { source } : {}) };
}

function buildSystemTaskSeedFromInboundRequest(requestMessage: unknown): {
  taskName?: string;
  summary?: string;
} {
  const content = (extractMessageTextForSession(requestMessage) ?? '').trim();
  if (!content) return {};
  const firstLine = content.split('\n').find((line) => line.trim().length > 0)?.trim() ?? '';
  const taskName = firstLine ? firstLine.slice(0, 120) : content.slice(0, 120);
  const summary = content.slice(0, 280);
  return {
    ...(taskName ? { taskName } : {}),
    ...(summary ? { summary } : {}),
  };
}

function isExplicitTaskCloseApproval(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  const shortApproveOnly = new Set(['ok', 'okay', 'yes', '同意', '可以', '通过', '批准', 'approve', 'approved']);
  if (normalized.length <= 16 && shortApproveOnly.has(normalized)) return true;
  const approvalHints = /(approve|approved|同意|通过|批准|确认)/i;
  const closeHints = /(close|closed|closure|关闭|结案|收口|归档)/i;
  return approvalHints.test(normalized) && closeHints.test(normalized);
}

export function registerMessageRoutes(app: Express, deps: MessageRouteDeps): void {
  app.post('/api/v1/message', async (req, res) => {
    const body = req.body as { target?: string; message?: unknown; blocking?: boolean; sender?: string; callbackId?: string };
    if (!body.target || body.message === undefined) {
      deps.writeMessageErrorSample({
        phase: 'request_validation',
        responseStatus: 400,
        error: 'Missing target or message',
        request: {
          target: body.target,
          blocking: body.blocking === true,
          sender: body.sender,
          callbackId: body.callbackId,
          message: body.message,
        },
      });
      res.status(400).json({ error: 'Missing target or message' });
      return;
    }

    let targetId = body.target;
    const sender = typeof body.sender === 'string' ? body.sender.trim().toLowerCase() : '';
    const isCliRoute = sender === 'cli' || sender.startsWith('cli-');
    const isSystemAgentTarget = targetId === 'finger-system-agent';
    if (!isPrimaryOrchestratorTarget(body.target, deps) && !isCliRoute && !isSystemAgentTarget && !isDirectAgentRouteAllowed(req, deps)) {
     res.status(403).json({
        error: `Direct target routing is disabled. Use primary orchestrator target: ${deps.primaryOrchestratorTarget}`,
        code: 'DIRECT_ROUTE_DISABLED',
        target: body.target,
        primaryTarget: deps.primaryOrchestratorTarget,
      });
      return;
    }

    const channelId = buildChannelId(req, sender);
    const displayChannels = normalizeDisplayChannels((body as Record<string, unknown>)?.displayChannels);
    const inputChannels = normalizeDisplayChannels((body as Record<string, unknown>)?.inputChannels);
    const incomingContent = extractMessageTextForSession(body.message) ?? '';
    const parsedCommand = parseSuperCommand(incomingContent);
    const fingerConfig = await loadFingerConfig();
    const channelPolicy = getChannelAuth(fingerConfig, channelId);

    const superCmd = await handleSuperCommand(incomingContent, channelId, deps);
    if (superCmd.handled && superCmd.response) {
      if ('error' in (superCmd.response as Record<string, unknown>) && 'code' in (superCmd.response as Record<string, unknown>)) {
        res.status(403).json(superCmd.response);
      } else {
        res.json(superCmd.response);
      }
      return;
    }

    const directSystemTarget = targetId === 'finger-system-agent';
    const contextManager = getChannelContextManager();
    if (directSystemTarget) {
      contextManager.updateContext(channelId, 'system', 'finger-system-agent');
    }
    const routedTarget = directSystemTarget
      ? 'finger-system-agent'
      : contextManager.getTargetAgent(channelId, parsedCommand);
    targetId = routedTarget;
    body.target = routedTarget;
    const effectiveMessage = parsedCommand.type === 'super_command'
      ? withMessageContent(body.message, parsedCommand.effectiveContent)
      : body.message;
    const inferredRole = inferInboundRole(effectiveMessage, sender);
    const effectiveMessageWithRole = ensureMessageMetadataRole(effectiveMessage, inferredRole);
    if (channelPolicy === 'mailbox') {
      const messageId = deps.mailbox.createMessage(targetId, effectiveMessageWithRole, {
        sender: body.sender,
        callbackId: body.callbackId,
      });
      deps.mailbox.updateStatus(messageId, 'pending');
      res.json({ messageId, status: 'queued' });
      return;
    }

    const isSystemRoute = routedTarget === 'finger-system-agent';
    const systemProjectPath = isSystemRoute ? SYSTEM_PROJECT_PATH : undefined;

    const requestMessageWithPolicy = withDefaultProfileReviewPolicy(targetId, effectiveMessageWithRole, deps);
    const shouldDryRun = resolveDryRunFlag(req, requestMessageWithPolicy);
    let injectedPrompt: string | null = null;
    let injectedAgents: OrchestrationPromptAgent[] = [];
    let requestMessage = requestMessageWithPolicy;
    if (!isSystemRoute && shouldInjectProfileReviewPolicy(targetId, deps)) {
      try {
        const loaded = loadOrchestrationConfig();
        const activeProfile = resolveActiveOrchestrationProfile(loaded.config);
        const injected = buildOrchestrationPromptInjection(requestMessage, activeProfile, deps);
        requestMessage = injected.updatedMessage;
        injectedPrompt = injected.injectedPrompt;
        injectedAgents = injected.agents;
      } catch (error) {
        log.error(
          'orchestration prompt injection failed',
          error instanceof Error ? error : undefined,
          { target: targetId },
        );
      }
    }

    if (shouldDryRun) {
      const metadata = isObjectRecord(requestMessage)
        ? (isObjectRecord(requestMessage.metadata) ? requestMessage.metadata : {})
        : {};
      const roleProfile = typeof metadata.roleProfile === 'string' && metadata.roleProfile.trim().length > 0
        ? metadata.roleProfile.trim()
        : 'project';
      const synthesizedMetadata: Record<string, unknown> = {
        ...metadata,
        roleProfile,
        contextLedgerRole: typeof metadata.contextLedgerRole === 'string' && metadata.contextLedgerRole.trim().length > 0
          ? metadata.contextLedgerRole
          : roleProfile,
        contextLedgerAgentId:
          typeof metadata.contextLedgerAgentId === 'string' && metadata.contextLedgerAgentId.trim().length > 0
            ? metadata.contextLedgerAgentId
            : deps.primaryOrchestratorAgentId,
        contextLedgerEnabled: metadata.contextLedgerEnabled !== false,
        contextLedgerCanReadAll:
          typeof metadata.contextLedgerCanReadAll === 'boolean'
            ? metadata.contextLedgerCanReadAll
            : roleProfile === 'project' || roleProfile === 'system' || roleProfile === 'orchestrator',
        contextLedgerFocusEnabled:
          typeof metadata.contextLedgerFocusEnabled === 'boolean'
            ? metadata.contextLedgerFocusEnabled
            : true,
        contextLedgerFocusMaxChars:
          typeof metadata.contextLedgerFocusMaxChars === 'number'
            ? metadata.contextLedgerFocusMaxChars
            : 20_000,
        kernelMode:
          typeof metadata.kernelMode === 'string' && metadata.kernelMode.trim().length > 0
            ? metadata.kernelMode
            : typeof metadata.mode === 'string' && metadata.mode.trim().length > 0
              ? metadata.mode
              : 'main',
        mode:
          typeof metadata.mode === 'string' && metadata.mode.trim().length > 0
            ? metadata.mode
            : typeof metadata.kernelMode === 'string' && metadata.kernelMode.trim().length > 0
              ? metadata.kernelMode
              : 'main',
      };
      const developerInstructions = __chatCodexInternals.resolveDeveloperInstructions(synthesizedMetadata, undefined, undefined);
      res.json({
        dryrun: true,
        target: targetId,
        injectedPrompt,
        injectedAgents,
        developerInstructions,
      });
      return;
    }

   if (isObjectRecord(requestMessage)) {
     const metadata = isObjectRecord(requestMessage.metadata) ? requestMessage.metadata : {};
     if (isSystemRoute) {
       metadata.responsesStructuredOutput = false;
       metadata.responsesOutputSchemaPreset = 'none';
     }
      // Inject user thinking/reasoning preferences from user-settings
      const userSettings = loadUserSettings();
      if (typeof metadata.responsesReasoningEnabled !== 'boolean') {
        metadata.responsesReasoningEnabled = userSettings.preferences.thinkingEnabled;
      }
      if (typeof metadata.responsesReasoningEffort !== 'string') {
        metadata.responsesReasoningEffort = userSettings.preferences.reasoningEffort ?? 'medium';
      }
      if (typeof metadata.responsesReasoningSummary !== 'string') {
        metadata.responsesReasoningSummary = userSettings.preferences.reasoningSummary ?? 'detailed';
      }
      // Store thinking state in metadata for session recording
      metadata.thinkingEnabled = userSettings.preferences.thinkingEnabled;
      metadata.reasoningEffort = userSettings.preferences.reasoningEffort;
     requestMessage = { ...requestMessage, metadata };
   }

    // Server-side forced delegation for system routes with project paths
    const delegation = await handleSystemRouteDelegation(isSystemRoute, requestMessage, targetId, deps);
    requestMessage = delegation.updatedMessage;
    if (delegation.updatedTarget) {
      targetId = delegation.updatedTarget;
      body.target = delegation.updatedTarget;
    }

    let requestSessionId = extractSessionIdFromMessagePayload(requestMessage);
    if (!requestSessionId) {
      if (isSystemRoute) {
        requestSessionId = deps.sessionManager.getOrCreateSystemSession().id;
      } else {
        const currentSession = deps.sessionManager.getCurrentSession();
        requestSessionId = currentSession?.id ?? null;
      }

      if (requestSessionId && isObjectRecord(requestMessage)) {
        const metadata = isObjectRecord(requestMessage.metadata) ? requestMessage.metadata : {};
        const metaSessionId =
          typeof metadata.sessionId === 'string' && metadata.sessionId.trim().length > 0
            ? metadata.sessionId
            : requestSessionId;
        requestMessage = {
          ...requestMessage,
          sessionId: requestSessionId,
          metadata: {
            ...metadata,
            sessionId: metaSessionId,
          },
        };
      }
    }

    if (requestSessionId && inferredRole === 'user') {
      const current = deps.sessionManager.getSession(requestSessionId);
      if (isHeartbeatControlSession(current)) {
        const fallbackSessionId = isSystemRoute
          ? deps.sessionManager.getOrCreateSystemSession().id
          : deps.sessionManager.getCurrentSession()?.id ?? null;
        const reboundSessionId = (
          typeof fallbackSessionId === 'string'
          && fallbackSessionId.trim().length > 0
          && fallbackSessionId !== requestSessionId
        )
          ? fallbackSessionId
          : null;
        log.warn('Reject user input to heartbeat control session; rebinding session', {
          requestedSessionId: requestSessionId,
          reboundSessionId: reboundSessionId ?? 'auto',
          target: targetId,
          role: inferredRole,
        });
        requestSessionId = reboundSessionId;
        if (isObjectRecord(requestMessage)) {
          const metadata = isObjectRecord(requestMessage.metadata) ? requestMessage.metadata : {};
          const { sessionId: _ignoredSessionId, ...messageWithoutSessionId } = requestMessage;
          const {
            sessionId: _ignoredMetaSessionId,
            session_id: _ignoredMetaUnderscore,
            ...metadataWithoutSessionId
          } = metadata;
          requestMessage = {
            ...messageWithoutSessionId,
            ...(requestSessionId ? { sessionId: requestSessionId } : {}),
            metadata: {
              ...metadataWithoutSessionId,
              ...(requestSessionId ? { sessionId: requestSessionId } : {}),
              controlSessionRejected: true,
            },
          };
        }
      }
    }

    log.info('Session reuse decision', {
      sessionId: requestSessionId ?? 'none',
      action: requestSessionId ? 'reuse' : 'new',
      target: targetId,
    });
    if (requestSessionId) {
      const sessionProjectPath = isSystemRoute ? SYSTEM_PROJECT_PATH : undefined;
      ensureSessionExists(deps.sessionManager, requestSessionId, body.target, sessionProjectPath);
      if (isObjectRecord(requestMessage)) {
        const metadata = isObjectRecord(requestMessage.metadata) ? requestMessage.metadata : {};
        const explicitProgressDelivery = normalizeProgressDeliveryPolicy(
          metadata.progressDelivery ?? metadata.progress_delivery,
        );
        const progressDelivery = explicitProgressDelivery;
        if (progressDelivery) {
          deps.sessionManager.updateContext(requestSessionId, {
            progressDelivery,
            progressDeliveryTransient: true,
            progressDeliveryUpdatedAt: new Date().toISOString(),
          });
        } else {
          const session = deps.sessionManager.getSession(requestSessionId);
          const context = (session?.context && typeof session.context === 'object')
            ? (session.context as Record<string, unknown>)
            : {};
          if (context.progressDeliveryTransient === true) {
            deps.sessionManager.updateContext(requestSessionId, {
              progressDelivery: null,
              progressDeliveryTransient: false,
              progressDeliveryUpdatedAt: null,
            });
          }
        }
      }
    }
    if (requestSessionId && isSystemRoute && inferredRole === 'user') {
      const session = deps.sessionManager.getSession(requestSessionId);
      const context = (session?.context && typeof session.context === 'object')
        ? (session.context as Record<string, unknown>)
        : {};
      const userText = (extractMessageTextForSession(requestMessage) ?? '').trim();
      const currentProjectTaskState = parseProjectTaskState(context.projectTaskState);
      const userApprovedClose = Boolean(
        currentProjectTaskState
        && currentProjectTaskState.active
        && currentProjectTaskState.status === 'reported'
        && isExplicitTaskCloseApproval(userText),
      );
      if (userApprovedClose && currentProjectTaskState) {
        const closedState = mergeProjectTaskState(currentProjectTaskState, {
          active: false,
          status: 'closed',
          note: 'user_approved_close',
          summary: userText.slice(0, 240) || 'user approved final closure',
        });
        const currentRegistry = parseDelegatedProjectTaskRegistry(context.projectTaskRegistry);
        const prunedRegistry = pruneDelegatedRegistryForContextAfterTaskClosed(currentRegistry, closedState);
        appendClosedProjectTaskArchive(session?.projectPath ?? '', closedState);
        deps.sessionManager.updateContext(requestSessionId, {
          projectTaskState: null,
          projectTaskRegistry: prunedRegistry,
        });
      }
      const currentSystemTaskState = parseSystemTaskState(context.systemTaskState);
      const seed = buildSystemTaskSeedFromInboundRequest(requestMessage);
      const nextSystemTaskState = mergeSystemTaskState(currentSystemTaskState, {
        active: !userApprovedClose,
        status: userApprovedClose ? 'completed' : 'planning',
        note: userApprovedClose ? 'user_approved_task_closure' : 'inbound_user_request',
        ...(seed.taskName ? { taskName: seed.taskName } : {}),
        ...(seed.summary ? { summary: seed.summary } : {}),
      });
      deps.sessionManager.updateContext(requestSessionId, {
        systemTaskState: nextSystemTaskState,
      });
    }
    if (requestSessionId && isObjectRecord(requestMessage)) {
      const session = deps.sessionManager.getSession(requestSessionId);
      const sessionContext = (session?.context && typeof session.context === 'object')
        ? (session.context as Record<string, unknown>)
        : {};
      const metadata = isObjectRecord(requestMessage.metadata) ? requestMessage.metadata : {};
      const taskRouterPath = (
        typeof session?.projectPath === 'string' && session.projectPath.trim().length > 0
          ? `${session.projectPath.replace(/\/+$/, '')}/TASK.md`
          : undefined
      );
      requestMessage = {
        ...requestMessage,
        metadata: {
          ...metadata,
          sessionContextSnapshot: {
            executionLifecycle: sessionContext.executionLifecycle,
            projectTaskState: sessionContext.projectTaskState,
            projectTaskRegistry: sessionContext.projectTaskRegistry,
            systemTaskState: sessionContext.systemTaskState,
            ...(taskRouterPath ? { taskRouterPath } : {}),
          },
          ...(taskRouterPath ? { taskRouterPath } : {}),
        },
      };
    }
    requestMessage = withSessionWorkspaceDefaults(requestMessage, requestSessionId, deps.sessionWorkspaces);
    if (requestSessionId) {
      deps.runtime.setCurrentSession(requestSessionId);
      deps.runtime.bindAgentSession(targetId, requestSessionId);
    }
    if (requestSessionId) {
      const transientPolicy = shouldUseTransientLedgerForInboundMessage(requestMessage);
      if (transientPolicy.enabled) {
        const mode = `transient-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        deps.sessionManager.setTransientLedgerMode(requestSessionId, mode, {
          source: transientPolicy.source,
          autoDeleteOnStop: true,
        });
      } else if (inferredRole === 'user') {
        deps.sessionManager.clearTransientLedgerMode(requestSessionId);
      }
    }
    // 记录当前渠道授权策略（供工具调用时使用）

    const shouldPersistSession = !!requestSessionId && !shouldClientPersistSession(requestMessage);
    if (shouldPersistSession && requestSessionId) {
      const content = extractMessageTextForSession(requestMessage)
        ?? JSON.stringify(requestMessage);
      if (content.trim().length > 0) {
        void deps.sessionManager.addMessage(requestSessionId, 'user', content, {
          agentId: targetId,
        });
      }
    }

    // 输入同步：将用户输入发送到指定的其他渠道
    if (inputChannels.length > 0) {
      const userContent = extractMessageTextForSession(requestMessage)
        ?? JSON.stringify(requestMessage);
      sendInputSync(deps.channelBridgeManager, inputChannels, userContent).catch((error) => {
        log.warn('input sync failed', {
          targetId,
          inputChannels,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    const messageId = deps.mailbox.createMessage(targetId, requestMessage, {
      sender: body.sender,
      callbackId: body.callbackId
    });
    deps.mailbox.updateStatus(messageId, 'processing');

    if (requestSessionId) {
      applyExecutionLifecycleTransition(deps.sessionManager, requestSessionId, {
        stage: 'received',
        substage: 'route_accept',
        updatedBy: 'message-route',
        messageId,
        targetAgentId: targetId,
        detail: channelId,
        lastError: null,
      });
      applyExecutionLifecycleTransition(deps.sessionManager, requestSessionId, {
        stage: 'session_bound',
        substage: 'route_bound',
        updatedBy: 'message-route',
        messageId,
        targetAgentId: targetId,
        detail: requestSessionId,
        lastError: null,
      });
    }

    deps.broadcast({ type: 'messageCreated', messageId, status: 'processing' });

    try {
      if (body.blocking) {
        const blockingResult = await executeBlockingMessageRoute({
          deps,
          body,
          targetId,
          requestMessage,
          requestSessionId,
          messageId,
          shouldPersistSession,
          channelId,
          displayChannels,
          parsedCommand,
        });
        res.status(blockingResult.statusCode).json(blockingResult.payload);
        return;
      }

      if (requestSessionId) {
        applyExecutionLifecycleTransition(deps.sessionManager, requestSessionId, {
          stage: 'dispatching',
          substage: 'async_send',
          updatedBy: 'message-route',
          messageId,
          targetAgentId: targetId,
          detail: 'non-blocking',
          lastError: null,
        });
      }

      executeAsyncMessageRoute({
        deps,
        body,
        targetId,
        requestMessage,
        requestSessionId,
        messageId,
        shouldPersistSession,
        channelId,
        displayChannels,
        parsedCommand,
      });

      res.json({ messageId, status: 'queued' });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      deps.writeMessageErrorSample({
        phase: 'message_route_exception',
        responseStatus: 400,
        messageId,
        error: errorMessage,
        request: {
          target: targetId,
          blocking: body.blocking === true,
          sender: body.sender,
          callbackId: body.callbackId,
          message: requestMessage,
        },
        response: {
          status: 'failed',
          error: errorMessage,
        },
      });
      deps.mailbox.updateStatus(messageId, 'failed', undefined, errorMessage);
      if (requestSessionId) {
        applyExecutionLifecycleTransition(deps.sessionManager, requestSessionId, {
          stage: 'failed',
          substage: 'route_exception',
          updatedBy: 'message-route',
          messageId,
          targetAgentId: targetId,
          lastError: errorMessage,
        });
      }
      res.status(400).json({ messageId, status: 'failed', error: errorMessage });
    }
  });
}
