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
import { parseSuperCommand } from '../middleware/super-command-parser.js';
import { validateSystemCommand } from '../middleware/system-auth.js';
import { getChannelContextManager } from '../../orchestration/channel-context-manager.js';
import { SYSTEM_PROJECT_PATH, getSystemSessionPath } from '../../agents/finger-system-agent/index.js';
import path from 'path';

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

function ensureSessionExists(sessionManager: SessionManager, sessionId: string, nameHint?: string, projectPathOverride?: string): void {
  const existing = sessionManager.getSession(sessionId);
  if (existing) return;
  const currentSession = sessionManager.getCurrentSession();
  const fallbackProjectPath = projectPathOverride ?? currentSession?.projectPath ?? process.cwd();
  sessionManager.ensureSession(sessionId, fallbackProjectPath, nameHint);
}

function buildChannelId(req: Request, sender: string): string {
  const headerChannel = req.header('x-finger-channel');
  if (typeof headerChannel === 'string' && headerChannel.trim().length > 0) {
    return headerChannel.trim();
  }
  if (sender.length > 0) return sender;
  return 'webui';
}

function withMessageContent(message: unknown, content: string): unknown {
  if (typeof message === 'string') return content;
  if (!isObjectRecord(message)) return { content };
  const metadata = isObjectRecord(message.metadata) ? message.metadata : {};
  return {
    ...message,
    content,
    text: content,
    metadata,
  };
}

function buildAgentEnvelope(agentId: string) {
  if (agentId === 'finger-system-agent') {
    return { id: 'finger-system-agent', name: 'SystemBot', role: 'system', mode: 'system' as const };
  }
  if (agentId === 'finger-orchestrator') {
    return { id: 'finger-orchestrator', name: 'Orchestrator', role: 'orchestrator', mode: 'business' as const };
  }
  return { id: agentId, name: agentId, role: 'agent', mode: 'business' as const };
}

function prefixAgentResponse(agentId: string, text: string): string {
  const normalized = text.trim();
  if (agentId === 'finger-system-agent') {
    if (normalized.toLowerCase().startsWith('systembot:')) return normalized
    return `SystemBot: ${normalized}`;
  }
  if (agentId === 'finger-orchestrator') {
    if (normalized.toLowerCase().startsWith('orchestrator:')) return normalized
    return `Orchestrator: ${normalized}`;
  }
  return normalized;
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

    const channelId = buildChannelId(req, sender);
    const contextManager = getChannelContextManager();
    const incomingContent = extractMessageTextForSession(body.message) ?? '';
    const parsedCommand = parseSuperCommand(incomingContent);

    if (parsedCommand.type === 'super_command' && parsedCommand.blocks && parsedCommand.blocks.length > 0) {
      const firstBlock = parsedCommand.blocks[0];
      if (firstBlock.type === 'system') {
        const auth = await validateSystemCommand(firstBlock, channelId);
        if (!auth.ok) {
          res.status(403).json({ error: auth.error, code: 'SYSTEM_AUTH_FAILED' });
          return;
        }
      }

      // Handle project/session commands
      if (firstBlock.type === 'project_list') {
        const sessions = deps.sessionManager.listSessions();
        const projectMap = new Map<string, number>();
        for (const s of sessions) {
          projectMap.set(s.projectPath, (projectMap.get(s.projectPath) ?? 0) + 1);
        }
        const projects = Array.from(projectMap.entries()).map(([path, count]) => ({ path, sessionCount: count }));
        res.json({ type: 'project_list', projects });
        return;
      }

      if (firstBlock.type === 'project_switch' && firstBlock.path) {
        res.json({ type: 'project_switch', path: firstBlock.path, message: 'Project switched' });
        return;
      }

      if (firstBlock.type === 'session_list') {
        const currentProject = deps.sessionManager.getCurrentSession()?.projectPath ?? process.cwd();
        const sessions = deps.sessionManager.listSessions().filter(s => s.projectPath === currentProject);
        const sessionList = sessions.map(s => ({
          id: s.id,
          name: s.name,
          lastAccessed: s.lastAccessedAt,
          preview: (s.messages[s.messages.length - 1]?.content ?? '').slice(0, 100),
        }));
        res.json({ type: 'session_list', sessions: sessionList });
        return;
      }

      if (firstBlock.type === 'session_switch' && firstBlock.sessionId) {
        const session = deps.sessionManager.getSession(firstBlock.sessionId);
        if (session) {
          deps.sessionManager.setCurrentSession(firstBlock.sessionId);
          res.json({ type: 'session_switch', sessionId: firstBlock.sessionId, message: 'Session switched' });
        } else {
          res.status(404).json({ error: 'Session not found', sessionId: firstBlock.sessionId });
        }
        return;
      }

      if (parsedCommand.shouldSwitch && parsedCommand.targetAgent) {
        const currentSession = deps.sessionManager.getCurrentSession();
        const previousContext = currentSession ? {
          agentId: contextManager.getTargetAgent(channelId, { type: 'normal', targetAgent: '' }),
          sessionId: currentSession.id,
          projectPath: currentSession.projectPath,
        } : undefined;

        if (parsedCommand.targetAgent === 'finger-system-agent') {
          contextManager.updateContext(channelId, 'system', 'finger-system-agent', previousContext);
        } else if (parsedCommand.targetAgent === 'finger-orchestrator') {
          contextManager.updateContext(channelId, 'business', 'finger-orchestrator');
        }
      }
    }

   const routedTarget = contextManager.getTargetAgent(channelId, parsedCommand);
   body.target = routedTarget;
    const isSystemRoute = routedTarget === 'finger-system-agent';
    const systemProjectPath = isSystemRoute ? SYSTEM_PROJECT_PATH : undefined;
   const effectiveMessage = parsedCommand.type === 'super_command'
     ? withMessageContent(body.message, parsedCommand.effectiveContent)
     : body.message;

    const requestMessageWithPolicy = withDefaultProfileReviewPolicy(body.target, effectiveMessage, deps);
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
      const sessionProjectPath = isSystemRoute ? SYSTEM_PROJECT_PATH : undefined;
      ensureSessionExists(deps.sessionManager, requestSessionId, body.target, sessionProjectPath);
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

    const messageId = deps.mailbox.createMessage(body.target, requestMessage, {
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
        const agentTarget = body.target ?? deps.primaryOrchestratorAgentId;
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
              from: parsedCommand.targetAgent === 'finger-system-agent' ? 'finger-orchestrator' : 'finger-system-agent',
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
            deps.sessionManager.addMessage(requestSessionId, 'assistant', assistantContent, {
              agentId: agentTarget,
              metadata: { channelId, mode: agentInfo.mode },
            });
          }
        }
        deps.mailbox.updateStatus(messageId, 'completed', responsePayload);

        deps.broadcast({ type: 'messageCompleted', messageId, result: responsePayload, callbackResult: senderResponse });
        res.json({ messageId, status: 'completed', result: responsePayload, callbackResult: senderResponse });
        return;
      }

      deps.hub.sendToModule(body.target, requestMessage, body.sender ? (result: any) => {
        deps.hub.sendToModule(body.sender!, { type: 'callback', payload: result, originalMessageId: messageId })
          .catch(() => { /* Ignore sender callback errors */ });
        return result;
      } : undefined)
        .then((result) => {
          const agentTarget = body.target ?? deps.primaryOrchestratorAgentId;
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
                from: parsedCommand.targetAgent === 'finger-system-agent' ? 'finger-orchestrator' : 'finger-system-agent',
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
              deps.sessionManager.addMessage(requestSessionId, 'assistant', assistantContent, {
                agentId: agentTarget,
                metadata: { channelId, mode: agentInfo.mode },
              });
            }
          }
          deps.mailbox.updateStatus(messageId, 'completed', responsePayload);
          deps.broadcast({ type: 'messageCompleted', messageId, result: responsePayload });
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
