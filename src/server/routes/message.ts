import type { Express, Request } from 'express';
import { loadOrchestrationConfig, type OrchestrationProfile } from '../../orchestration/orchestration-config.js';
import { buildOrchestrationDispatchPrompt, type OrchestrationPromptAgent } from '../../orchestration/orchestration-prompt.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import { __chatCodexInternals } from '../../agents/chat-codex/chat-codex-module.js';
import type { Mailbox } from '../mailbox.js';
import { getActiveReviewPolicy } from '../orchestration/review-policy.js';
import { isObjectRecord } from '../common/object.js';
import {
  extractSessionIdFromMessagePayload,
  shouldClientPersistSession,
  extractMessageTextForSession,
  extractResultTextForSession,
  withSessionWorkspaceDefaults,
  shouldRetryBlockingMessage,
  resolveBlockingErrorStatus,
} from '../modules/message-session.js';
import type { SessionWorkspaceManager } from '../modules/session-workspaces.js';

export interface MessageRouteDeps {
  hub: MessageHub;
  mailbox: Mailbox;
  runtime: RuntimeFacade;
  sessionManager: SessionManager;
  sessionWorkspaces: SessionWorkspaceManager;
  broadcast: (message: Record<string, unknown>) => void;
  writeMessageErrorSample: (payload: Record<string, unknown>) => void;
  blockingTimeoutMs: number;
  blockingMaxRetries: number;
  blockingRetryBaseMs: number;
  allowDirectAgentRoute: boolean;
  primaryOrchestratorTarget: string;
  primaryOrchestratorAgentId: string;
  primaryOrchestratorGatewayId: string;
  legacyOrchestratorAgentId: string;
  legacyOrchestratorGatewayId: string;
}

function resolveActiveOrchestrationProfile(config: { activeProfileId: string; profiles: OrchestrationProfile[] }): OrchestrationProfile | null {
  const activeId = config.activeProfileId;
  return config.profiles.find((item) => item.id === activeId) ?? null;
}

function shouldInjectProfileReviewPolicy(target: string, deps: MessageRouteDeps): boolean {
  const normalized = target.trim();
  return normalized === deps.primaryOrchestratorTarget
    || normalized === deps.primaryOrchestratorAgentId
    || normalized === deps.primaryOrchestratorGatewayId
    || normalized === deps.legacyOrchestratorAgentId
    || normalized === deps.legacyOrchestratorGatewayId;
}

function withDefaultProfileReviewPolicy(target: string, message: unknown, deps: MessageRouteDeps): unknown {
  if (!shouldInjectProfileReviewPolicy(target, deps)) return message;
  const reviewPolicy = getActiveReviewPolicy();
  if (reviewPolicy.enabled !== true) return message;
  if (!isObjectRecord(message)) return message;
  const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
  if (isObjectRecord(metadata.review)) return message;
  return {
    ...message,
    metadata: {
      ...metadata,
      review: {
        enabled: true,
        ...(Array.isArray(reviewPolicy.stages) && reviewPolicy.stages.length > 0 ? { stages: reviewPolicy.stages } : {}),
        ...(typeof reviewPolicy.strictness === 'string' && reviewPolicy.strictness.trim().length > 0
          ? { strictness: reviewPolicy.strictness.trim() }
          : {}),
      },
    },
  };
}

function isPrimaryOrchestratorTarget(target: string, deps: MessageRouteDeps): boolean {
  const normalized = target.trim();
  if (normalized.length === 0) return false;
  return normalized === deps.primaryOrchestratorTarget
    || normalized === deps.primaryOrchestratorAgentId
    || normalized === deps.primaryOrchestratorGatewayId
    || normalized === deps.legacyOrchestratorAgentId
    || normalized === deps.legacyOrchestratorGatewayId;
}

function isDirectAgentRouteAllowed(req: Request, deps: MessageRouteDeps): boolean {
  if (deps.allowDirectAgentRoute) return true;
  if (process.env.NODE_ENV === 'test') return true;
  const mode = req.header('x-finger-route-mode');
  return typeof mode === 'string' && mode.trim().toLowerCase() === 'test';
}

function buildOrchestrationPromptInjection(
  message: unknown,
  profile: OrchestrationProfile | null,
  deps: MessageRouteDeps,
): {
  updatedMessage: unknown;
  injectedPrompt: string | null;
  agents: OrchestrationPromptAgent[];
} {
  if (!profile || !isObjectRecord(message)) {
    return { updatedMessage: message, injectedPrompt: null, agents: [] };
  }
  const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
  const { prompt, agents } = buildOrchestrationDispatchPrompt(profile, { selfAgentId: deps.primaryOrchestratorAgentId });
  if (!prompt) {
    return { updatedMessage: message, injectedPrompt: null, agents };
  }
  const existing = typeof metadata.developerInstructions === 'string' && metadata.developerInstructions.trim().length > 0
    ? metadata.developerInstructions.trim()
    : typeof metadata.developer_instructions === 'string' && metadata.developer_instructions.trim().length > 0
      ? metadata.developer_instructions.trim()
      : '';
  const mergedDeveloperInstructions = existing ? `${prompt}\n\n${existing}` : prompt;
  return {
    updatedMessage: {
      ...message,
      metadata: {
        ...metadata,
        developerInstructions: mergedDeveloperInstructions,
      },
    },
    injectedPrompt: prompt,
    agents,
  };
}

function resolveDryRunFlag(req: Request, message: unknown): boolean {
  const queryFlag = typeof req.query.dryrun === 'string'
    ? req.query.dryrun.trim().toLowerCase()
    : undefined;
  if (queryFlag === '1' || queryFlag === 'true' || queryFlag === 'yes') return true;
  const headerFlag = req.header('x-finger-dryrun');
  if (typeof headerFlag === 'string') {
    const normalized = headerFlag.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
  }
  if (isObjectRecord(message)) {
    const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
    const metaFlag = metadata.dryRun ?? metadata.dryrun ?? metadata.dry_run;
    if (typeof metaFlag === 'boolean') return metaFlag;
    if (typeof metaFlag === 'string') {
      const normalized = metaFlag.trim().toLowerCase();
      if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
    }
  }
  return false;
}

function ensureSessionExists(sessionManager: SessionManager, sessionId: string, nameHint?: string): void {
  const existing = sessionManager.getSession(sessionId);
  if (existing) return;
  sessionManager.ensureSession(sessionId, process.cwd(), nameHint);
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

    const sender = typeof body.sender === 'string' ? body.sender.trim().toLowerCase() : '';
    const isCliRoute = sender === 'cli' || sender.startsWith('cli-');
    if (!isPrimaryOrchestratorTarget(body.target, deps) && !isCliRoute && !isDirectAgentRouteAllowed(req, deps)) {
      res.status(403).json({
        error: `Direct target routing is disabled. Use primary orchestrator target: ${deps.primaryOrchestratorTarget}`,
        code: 'DIRECT_ROUTE_DISABLED',
        target: body.target,
        primaryTarget: deps.primaryOrchestratorTarget,
      });
      return;
    }

    const requestMessageWithPolicy = withDefaultProfileReviewPolicy(body.target, body.message, deps);
    const shouldDryRun = resolveDryRunFlag(req, requestMessageWithPolicy);
    let injectedPrompt: string | null = null;
    let injectedAgents: OrchestrationPromptAgent[] = [];
    let requestMessage = requestMessageWithPolicy;
    if (shouldInjectProfileReviewPolicy(body.target, deps)) {
      try {
        const loaded = loadOrchestrationConfig();
        const activeProfile = resolveActiveOrchestrationProfile(loaded.config);
        const injected = buildOrchestrationPromptInjection(requestMessage, activeProfile, deps);
        requestMessage = injected.updatedMessage;
        injectedPrompt = injected.injectedPrompt;
        injectedAgents = injected.agents;
      } catch (error) {
        console.error('[Server] orchestration prompt injection failed:', error);
      }
    }

    if (shouldDryRun) {
      const metadata = isObjectRecord(requestMessage)
        ? (isObjectRecord(requestMessage.metadata) ? requestMessage.metadata : {})
        : {};
      const roleProfile = typeof metadata.roleProfile === 'string' && metadata.roleProfile.trim().length > 0
        ? metadata.roleProfile.trim()
        : 'orchestrator';
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
            : roleProfile === 'orchestrator',
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
        target: body.target,
        injectedPrompt,
        injectedAgents,
        developerInstructions,
      });
      return;
    }

    const requestSessionId = extractSessionIdFromMessagePayload(requestMessage);
    if (requestSessionId) {
      ensureSessionExists(deps.sessionManager, requestSessionId, body.target);
    }
    requestMessage = withSessionWorkspaceDefaults(requestMessage, requestSessionId, deps.sessionWorkspaces);
    if (requestSessionId) {
      deps.runtime.setCurrentSession(requestSessionId);
    }
    const shouldPersistSession = !!requestSessionId && !shouldClientPersistSession(requestMessage);
    if (shouldPersistSession && requestSessionId) {
      const content = extractMessageTextForSession(requestMessage)
        ?? JSON.stringify(requestMessage);
      if (content.trim().length > 0) {
        deps.sessionManager.addMessage(requestSessionId, 'user', content);
      }
    }

    const messageId = deps.mailbox.createMessage(body.target, requestMessage, body.sender, body.callbackId);
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
            primaryResult = await Promise.race([
              deps.hub.sendToModule(body.target, requestMessage),
              new Promise<never>((_, reject) => {
                setTimeout(
                  () => reject(new Error(`Timed out waiting for module response: ${body.target}`)),
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
              target: body.target,
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
            console.log('[Server] Callback result sent to sender', body.sender, 'Response:', senderResponse);
          } catch (err) {
            console.error('[Server] Failed to route callback result to sender', body.sender, err);
          }
        }

        const actualResult = primaryResult;
        if (shouldPersistSession && requestSessionId) {
          const assistantContent = extractResultTextForSession(actualResult);
          if (assistantContent && assistantContent.trim().length > 0) {
            deps.sessionManager.addMessage(requestSessionId, 'assistant', assistantContent);
          }
        }
        deps.mailbox.updateStatus(messageId, 'completed', actualResult);

        deps.broadcast({ type: 'messageCompleted', messageId, result: actualResult, callbackResult: senderResponse });
        res.json({ messageId, status: 'completed', result: actualResult, callbackResult: senderResponse });
        return;
      }

      deps.hub.sendToModule(body.target, requestMessage, body.sender ? (result: any) => {
        deps.hub.sendToModule(body.sender!, { type: 'callback', payload: result, originalMessageId: messageId })
          .catch(() => { /* Ignore sender callback errors */ });
        return result;
      } : undefined)
        .then((result) => {
          if (shouldPersistSession && requestSessionId) {
            const assistantContent = extractResultTextForSession(result);
            if (assistantContent && assistantContent.trim().length > 0) {
              deps.sessionManager.addMessage(requestSessionId, 'assistant', assistantContent);
            }
          }
          deps.mailbox.updateStatus(messageId, 'completed', result);
          deps.broadcast({ type: 'messageCompleted', messageId, result });
        })
        .catch((err) => {
          console.error('[Hub] Send error:', err);
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
          target: body.target,
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
