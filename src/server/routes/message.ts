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

    if (channelPolicy === 'mailbox') {
      const messageId = deps.mailbox.createMessage(targetId, effectiveMessage, {
        sender: body.sender,
        callbackId: body.callbackId,
      });
      deps.mailbox.updateStatus(messageId, 'pending');
      res.json({ messageId, status: 'queued' });
      return;
    }

    const isSystemRoute = routedTarget === 'finger-system-agent';
    const systemProjectPath = isSystemRoute ? SYSTEM_PROJECT_PATH : undefined;

    const requestMessageWithPolicy = withDefaultProfileReviewPolicy(targetId, effectiveMessage, deps);
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
       metadata.role = 'system';
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

    log.info('Session reuse decision', {
      sessionId: requestSessionId ?? 'none',
      action: requestSessionId ? 'reuse' : 'new',
      target: targetId,
    });
    if (requestSessionId) {
      const sessionProjectPath = isSystemRoute ? SYSTEM_PROJECT_PATH : undefined;
      ensureSessionExists(deps.sessionManager, requestSessionId, body.target, sessionProjectPath);
    }
    requestMessage = withSessionWorkspaceDefaults(requestMessage, requestSessionId, deps.sessionWorkspaces);
    if (requestSessionId) {
      deps.runtime.setCurrentSession(requestSessionId);
    }
    // 记录当前渠道授权策略（供工具调用时使用）

    const shouldPersistSession = !!requestSessionId && !shouldClientPersistSession(requestMessage);
    if (shouldPersistSession && requestSessionId) {
      const content = extractMessageTextForSession(requestMessage)
        ?? JSON.stringify(requestMessage);
      if (content.trim().length > 0) {
        void deps.sessionManager.addMessage(requestSessionId, 'user', content);
      }
    }

    // 输入同步：将用户输入发送到指定的其他渠道
    if (inputChannels.length > 0) {
      const userContent = extractMessageTextForSession(requestMessage)
        ?? JSON.stringify(requestMessage);
      sendInputSync(deps.channelBridgeManager, inputChannels, userContent).catch(() => {});
    }

    const messageId = deps.mailbox.createMessage(targetId, requestMessage, {
      sender: body.sender,
      callbackId: body.callbackId
    });
    deps.mailbox.updateStatus(messageId, 'processing');

    deps.broadcast({ type: 'messageCreated', messageId, status: 'processing' });

    try {
      if (body.blocking) {
        let primaryResult: unknown;
        let senderResponse: unknown | undefined;
        let attempt = 0;
        let lastError: Error | null = null;
        while (attempt <= deps.blockingMaxRetries) {
          try {
            log.info('Sending to module', { targetId, sessionId: requestSessionId ?? 'none', messageId });
            primaryResult = await Promise.race([
              deps.hub.sendToModule(targetId, requestMessage),
              new Promise<never>((_, reject) => {
                setTimeout(
                  () => {
        log.warn('Module response timed out', { targetId, sessionId: requestSessionId ?? 'none' });
        reject(new Error(`Timed out waiting for module response: ${targetId}`));
      },
                  deps.blockingTimeoutMs,
                );
              }),
            ]);
            lastError = null;
            break;
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            lastError = err instanceof Error ? err : new Error(errorMessage);
            const canRetry = shouldRetryBlockingMessage(errorMessage) && attempt < deps.blockingMaxRetries;
            if (!canRetry) break;
            const backoffMs = Math.min(
              30_000,
              Math.floor(deps.blockingRetryBaseMs * Math.pow(2, attempt)),
            );
            attempt += 1;
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }
        }

        if (lastError) {
          const errorMessage = lastError.message;
          const statusCode = resolveBlockingErrorStatus(errorMessage);
          deps.writeMessageErrorSample({
            phase: 'blocking_send_failed',
            responseStatus: statusCode,
            messageId,
            error: errorMessage,
            request: {
              target: targetId,
              blocking: body.blocking === true,
              sender: body.sender,
              callbackId: body.callbackId,
              message: requestMessage,
              timeoutMs: deps.blockingTimeoutMs,
              retryCount: deps.blockingMaxRetries,
            },
            response: {
              status: 'failed',
              error: errorMessage,
            },
          });
          deps.mailbox.updateStatus(messageId, 'failed', undefined, errorMessage);
          res.status(statusCode).json({ messageId, status: 'failed', error: errorMessage });
          return;
        }

        if (primaryResult === undefined) {
          const errorMessage = `No result returned from module: ${body.target}`;
          deps.mailbox.updateStatus(messageId, 'failed', undefined, errorMessage);
          res.status(502).json({ messageId, status: 'failed', error: errorMessage });
          return;
        }

        if (body.sender) {
          try {
            senderResponse = await deps.hub.sendToModule(body.sender, {
              type: 'callback',
              payload: primaryResult,
              originalMessageId: messageId,
            });
            log.info('Callback result sent to sender', { sender: body.sender });
          } catch (err) {
            log.error(
              'Failed to route callback result to sender',
              err instanceof Error ? err : undefined,
              { sender: body.sender },
            );
          }
        }

        const actualResult = primaryResult;
        const agentTarget = targetId ?? deps.primaryOrchestratorAgentId;
          const agentInfo = buildAgentEnvelope(agentTarget);
        const rawAssistantContent = extractResultTextForSession(actualResult) ?? '';
        const assistantContent = rawAssistantContent.trim().length > 0
          ? prefixAgentResponse(agentTarget, rawAssistantContent)
          : rawAssistantContent;

        const responsePayload = {
          ...(isObjectRecord(actualResult) ? actualResult : { response: assistantContent || actualResult }),
          response: assistantContent || (typeof actualResult === 'string' ? actualResult : extractResultTextForSession(actualResult) ?? ''),
          agent: agentInfo,
          ...(parsedCommand.shouldSwitch ? {
            contextSwitch: {
              from: parsedCommand.targetAgent === 'finger-system-agent' ? 'finger-project-agent' : 'finger-system-agent',
              to: agentTarget,
              previousMode: parsedCommand.targetAgent === 'finger-system-agent' ? 'business' : 'system',
            },
          } : {}),
          timestamp: {
            utc: new Date().toISOString(),
            local: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', ' ') + ' +08:00',
            tz: 'Asia/Shanghai',
            nowMs: Date.now(),
          },
        };

        if (shouldPersistSession && requestSessionId) {
          if (assistantContent && assistantContent.trim().length > 0) {
            void deps.sessionManager.addMessage(requestSessionId, 'assistant', assistantContent, {
              agentId: agentTarget,
              metadata: { channelId, mode: agentInfo.mode },
            });
          }
        }

        if (displayChannels.length > 0) {
          sendDisplayFanout(deps.channelBridgeManager, displayChannels, responsePayload.response)
            .catch((err) => log.error('Failed to send display fanout', err instanceof Error ? err : undefined));
        }
        deps.mailbox.updateStatus(messageId, 'completed', responsePayload);

        deps.broadcast({ type: 'messageCompleted', messageId, result: responsePayload, callbackResult: senderResponse });
        res.json({ messageId, status: 'completed', result: responsePayload, callbackResult: senderResponse });
        return;
      }

      deps.hub.sendToModule(targetId, requestMessage, body.sender ? (result: any) => {
        if (body.sender) {
          deps.hub.sendToModule(body.sender, { type: 'callback', payload: result, originalMessageId: messageId })
            .catch(() => { /* Ignore sender callback errors */ });
        }
        return result;
      } : undefined)
        .then((result) => {
          const agentTarget = targetId ?? deps.primaryOrchestratorAgentId;
          const agentInfo = buildAgentEnvelope(agentTarget);
          const rawAssistantContent = extractResultTextForSession(result) ?? '';
          const assistantContent = rawAssistantContent.trim().length > 0
            ? prefixAgentResponse(agentTarget, rawAssistantContent)
            : rawAssistantContent;
          const responsePayload = {
            ...(isObjectRecord(result) ? result : { response: assistantContent || result }),
            response: assistantContent || (typeof result === 'string' ? result : extractResultTextForSession(result) ?? ''),
            agent: agentInfo,
            ...(parsedCommand.shouldSwitch ? {
              contextSwitch: {
                from: parsedCommand.targetAgent === 'finger-system-agent' ? 'finger-project-agent' : 'finger-system-agent',
                to: agentTarget,
                previousMode: parsedCommand.targetAgent === 'finger-system-agent' ? 'business' : 'system',
              },
            } : {}),
            timestamp: {
              utc: new Date().toISOString(),
              local: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', ' ') + ' +08:00',
              tz: 'Asia/Shanghai',
              nowMs: Date.now(),
            },
          };
          if (shouldPersistSession && requestSessionId) {
            if (assistantContent && assistantContent.trim().length > 0) {
              void deps.sessionManager.addMessage(requestSessionId, 'assistant', assistantContent, {
                agentId: agentTarget,
                metadata: { channelId, mode: agentInfo.mode },
              });
            }
          }

          if (displayChannels.length > 0) {
            sendDisplayFanout(deps.channelBridgeManager, displayChannels, responsePayload.response)
              .catch((err) => log.error('Failed to send display fanout', err instanceof Error ? err : undefined));
          }
          deps.mailbox.updateStatus(messageId, 'completed', responsePayload);
          deps.broadcast({ type: 'messageCompleted', messageId, result: responsePayload });
        })
        .catch((err) => {
          log.error('Hub send error', err instanceof Error ? err : undefined, { target: targetId, messageId });
          deps.mailbox.updateStatus(messageId, 'failed', undefined, err.message);
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
      res.status(400).json({ messageId, status: 'failed', error: errorMessage });
    }
  });
}
