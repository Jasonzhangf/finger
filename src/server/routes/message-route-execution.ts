import { logger } from '../../core/logger.js';
import { isObjectRecord } from '../common/object.js';
import {
  extractKernelMetadataFromAgentResult,
  extractResultTextForSession,
  kernelMetadataHasCompactedProjection,
  resolveBlockingErrorStatus,
  shouldRetryBlockingMessage,
} from '../modules/message-session.js';
import { forceRebuild } from '../../runtime/context-history/index.js';
import { resolveLedgerPath } from '../../runtime/context-ledger-memory-helpers.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import path from 'path';
import { sendDisplayFanout } from './message-display.js';
import {
  buildAgentEnvelope,
  prefixAgentResponse,
} from './message-helpers.js';
import {
  applyExecutionLifecycleTransition,
  resolveLifecycleStageFromResultStatus,
} from '../modules/execution-lifecycle.js';
import type { DisplayChannelRequest, MessageRouteDeps } from './message-types.js';

const log = logger.module('message-route-execution');

function extractPromptFromPayload(input: Record<string, unknown>): string {
  const promptFields = ['prompt', 'query', 'input', 'text', 'content', 'message'];
  for (const field of promptFields) {
    const value = input[field];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

function isPayloadOverflowError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return normalized.includes('need context rebuild')
    || normalized.includes('context_overflow')
    || normalized.includes('range of input')
    || normalized.includes('too many total text tokens')
    || (normalized.includes('http 400') && normalized.includes('invalidparameter'));
}


function buildResponsePayload(params: {
  result: unknown;
  agentTarget: string;
  parsedCommand: { shouldSwitch?: boolean; targetAgent?: string };
}) {
  const agentInfo = buildAgentEnvelope(params.agentTarget);
  const rawAssistantContent = extractResultTextForSession(params.result) ?? '';
  const assistantContent = rawAssistantContent.trim().length > 0
    ? prefixAgentResponse(params.agentTarget, rawAssistantContent)
    : rawAssistantContent;

  return {
    ...(isObjectRecord(params.result) ? params.result : { response: assistantContent || params.result }),
    response: assistantContent || (typeof params.result === 'string' ? params.result : extractResultTextForSession(params.result) ?? ''),
    agent: agentInfo,
    ...(params.parsedCommand.shouldSwitch ? {
      contextSwitch: {
        from: params.parsedCommand.targetAgent === 'finger-system-agent' ? 'finger-project-agent' : 'finger-system-agent',
        to: params.agentTarget,
        previousMode: params.parsedCommand.targetAgent === 'finger-system-agent' ? 'business' : 'system',
      },
    } : {}),
    timestamp: {
      utc: new Date().toISOString(),
      local: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', ' ') + ' +08:00',
      tz: 'Asia/Shanghai',
      nowMs: Date.now(),
    },
    __assistantContent: assistantContent,
    __agentInfo: agentInfo,
  };
}

function maybePersistAssistantMessage(params: {
  deps: MessageRouteDeps;
  shouldPersistSession: boolean;
  requestSessionId: string | null;
  channelId: string;
  agentTarget: string;
  rawResult: unknown;
  responsePayload: ReturnType<typeof buildResponsePayload>;
}): void {
  if (!params.shouldPersistSession || !params.requestSessionId) return;
  const kernelMetadata = extractKernelMetadataFromAgentResult(params.rawResult);
  if (kernelMetadataHasCompactedProjection(kernelMetadata)) {
    const rawAssistantContent = extractResultTextForSession(params.rawResult) ?? '';
    const syncResult = params.deps.sessionManager.syncProjectionFromKernelMetadata(
      params.requestSessionId,
      kernelMetadata,
      {
        agentId: params.agentTarget,
        assistantReply: rawAssistantContent,
      },
    );
    if (syncResult.applied) {
      return;
    }
  }
  const assistantContent = params.responsePayload.__assistantContent;
  const agentInfo = params.responsePayload.__agentInfo;
  if (assistantContent && assistantContent.trim().length > 0) {
    void params.deps.sessionManager.addMessage(params.requestSessionId, 'assistant', assistantContent, {
      agentId: params.agentTarget,
      metadata: { channelId: params.channelId, mode: agentInfo.mode },
    });
  }
}

async function maybeSendCallback(params: {
  deps: MessageRouteDeps;
  sender?: string;
  messageId: string;
  payload: unknown;
}): Promise<unknown | undefined> {
  if (!params.sender) return undefined;
  const nonModuleSenders = ['mailbox-cli', 'cli', 'heartbeat', 'system'];
  const isNonModuleSender = nonModuleSenders.includes(params.sender) || params.sender.startsWith('cli-');
  if (isNonModuleSender) return undefined;
  try {
    return await params.deps.hub.sendToModule(params.sender, {
      type: 'callback',
      payload: params.payload,
      originalMessageId: params.messageId,
    });
  } catch (err) {
    log.error(
      'Failed to route callback result to sender',
      err instanceof Error ? err : undefined,
      { sender: params.sender },
    );
    return undefined;
  }
}

export async function executeBlockingMessageRoute(params: {
  deps: MessageRouteDeps;
  body: { sender?: string; blocking?: boolean };
  targetId: string;
  requestMessage: unknown;
  requestSessionId: string | null;
  messageId: string;
  shouldPersistSession: boolean;
  channelId: string;
  displayChannels: DisplayChannelRequest[];
  parsedCommand: { shouldSwitch?: boolean; targetAgent?: string };
}): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  let primaryResult: unknown;
  let senderResponse: unknown | undefined;
  let attempt = 0;
  let lastError: Error | null = null;
  if (params.requestSessionId) {
    applyExecutionLifecycleTransition(params.deps.sessionManager, params.requestSessionId, {
      stage: 'dispatching',
      substage: 'blocking_send',
      updatedBy: 'message-route',
      messageId: params.messageId,
      targetAgentId: params.targetId,
      detail: params.body.blocking ? 'blocking' : 'non-blocking',
      lastError: null,
    });
  }

  while (attempt <= params.deps.blockingMaxRetries) {
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      log.info('Sending to module', { targetId: params.targetId, sessionId: params.requestSessionId ?? 'none', messageId: params.messageId });
      primaryResult = await Promise.race([
        params.deps.hub.sendToModule(params.targetId, params.requestMessage),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            log.warn('Module response timed out', { targetId: params.targetId, sessionId: params.requestSessionId ?? 'none' });
            reject(new Error(`Timed out waiting for module response: ${params.targetId}`));
          }, params.deps.blockingTimeoutMs);
        }),
      ]);
      lastError = null;
      break;
    } catch (err) {
     const errorMessage = err instanceof Error ? err.message : String(err);
     lastError = err instanceof Error ? err : new Error(errorMessage);
     const isPayloadOverflow = isPayloadOverflowError(errorMessage);
     const canRetry = (shouldRetryBlockingMessage(errorMessage) || isPayloadOverflow) && attempt < params.deps.blockingMaxRetries;

     if (isPayloadOverflow && params.requestSessionId) {
       log.info('Payload exceeds limit, triggering single-source context rebuild before retry', {
         sessionId: params.requestSessionId,
         targetId: params.targetId,
         attempt,
       });
       try {
          const prompt = isObjectRecord(params.requestMessage)
            ? extractPromptFromPayload(params.requestMessage)
            : '';
          const ledgerRoot = params.deps.sessionManager.resolveLedgerRootForSession(params.requestSessionId)
            ?? (params.targetId === 'finger-system-agent'
              ? path.join(FINGER_PATHS.home, 'system', 'sessions')
              : FINGER_PATHS.sessions.dir);
          const ledgerPath = resolveLedgerPath(ledgerRoot, params.requestSessionId, params.targetId, 'main');
          const currentMessages = params.deps.sessionManager.getMessages(params.requestSessionId, 0);
          const rebuildResult = await forceRebuild(
            params.requestSessionId,
            ledgerPath,
            'overflow',
            prompt,
            undefined,
            20000,
            currentMessages,
          );

          if (rebuildResult.ok) {
            params.deps.sessionManager.replaceMessages(params.requestSessionId, rebuildResult.messages);
            log.info('Context rebuild completed and persisted to session snapshot', {
              sessionId: params.requestSessionId,
              digestCount: rebuildResult.digestCount,
              rawMessageCount: rebuildResult.rawMessageCount,
              totalTokens: rebuildResult.totalTokens,
            });
          } else {
            log.warn('Context rebuild failed during blocking retry path', {
              sessionId: params.requestSessionId,
              error: rebuildResult.error,
            });
          }
        } catch (rebuildError) {
          log.error('Context rebuild threw error', rebuildError instanceof Error ? rebuildError : undefined, {
            sessionId: params.requestSessionId,
          });
        }
      }

     if (!canRetry) break;
      const backoffMs = Math.min(30_000, Math.floor(params.deps.blockingRetryBaseMs * Math.pow(2, attempt)));
      attempt += 1;
      if (params.requestSessionId) {
        applyExecutionLifecycleTransition(params.deps.sessionManager, params.requestSessionId, {
          stage: 'retrying',
          substage: 'blocking_retry',
          updatedBy: 'message-route',
          messageId: params.messageId,
          targetAgentId: params.targetId,
          detail: `attempt=${attempt}`,
          lastError: errorMessage,
          timeoutMs: params.deps.blockingTimeoutMs,
          retryDelayMs: backoffMs,
          recoveryAction: 'retry',
          incrementRetry: true,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  if (lastError) {
    const errorMessage = lastError.message;
    const statusCode = resolveBlockingErrorStatus(errorMessage);
    params.deps.writeMessageErrorSample({
      phase: 'blocking_send_failed',
      responseStatus: statusCode,
      messageId: params.messageId,
      error: errorMessage,
      request: {
        target: params.targetId,
        blocking: params.body.blocking === true,
        sender: params.body.sender,
        message: params.requestMessage,
        timeoutMs: params.deps.blockingTimeoutMs,
        retryCount: params.deps.blockingMaxRetries,
      },
      response: { status: 'failed', error: errorMessage },
    });
    params.deps.mailbox.updateStatus(params.messageId, 'failed', undefined, errorMessage);
    if (params.requestSessionId) {
      applyExecutionLifecycleTransition(params.deps.sessionManager, params.requestSessionId, {
        stage: 'failed',
        substage: 'blocking_failed',
        updatedBy: 'message-route',
        messageId: params.messageId,
        targetAgentId: params.targetId,
        detail: `status=${statusCode}`,
        lastError: errorMessage,
        timeoutMs: params.deps.blockingTimeoutMs,
        recoveryAction: 'failed',
      });
    }
    return { statusCode, payload: { messageId: params.messageId, status: 'failed', error: errorMessage } };
  }

  if (primaryResult === undefined) {
    const errorMessage = `No result returned from module: ${params.targetId}`;
    params.deps.mailbox.updateStatus(params.messageId, 'failed', undefined, errorMessage);
    if (params.requestSessionId) {
      applyExecutionLifecycleTransition(params.deps.sessionManager, params.requestSessionId, {
        stage: 'failed',
        substage: 'empty_result',
        updatedBy: 'message-route',
        messageId: params.messageId,
        targetAgentId: params.targetId,
        lastError: errorMessage,
      });
    }
    return { statusCode: 502, payload: { messageId: params.messageId, status: 'failed', error: errorMessage } };
  }

  senderResponse = await maybeSendCallback({
    deps: params.deps,
    sender: params.body.sender,
    messageId: params.messageId,
    payload: primaryResult,
  });

  const agentTarget = params.targetId ?? params.deps.primaryOrchestratorAgentId;
  const responsePayload = buildResponsePayload({
    result: primaryResult,
    agentTarget,
    parsedCommand: params.parsedCommand,
  });
  maybePersistAssistantMessage({
    deps: params.deps,
    shouldPersistSession: params.shouldPersistSession,
    requestSessionId: params.requestSessionId,
    channelId: params.channelId,
    agentTarget,
    rawResult: primaryResult,
    responsePayload,
  });

  if (params.displayChannels.length > 0) {
    sendDisplayFanout(params.deps.channelBridgeManager, params.displayChannels, responsePayload.response)
      .catch((err) => log.error('Failed to send display fanout', err instanceof Error ? err : undefined));
  }
  params.deps.mailbox.updateStatus(params.messageId, 'completed', responsePayload);
  if (params.requestSessionId) {
    const resultStatus = resolveLifecycleStageFromResultStatus(
      isObjectRecord(primaryResult) ? primaryResult.status : undefined,
    );
    applyExecutionLifecycleTransition(params.deps.sessionManager, params.requestSessionId, {
      stage: resultStatus ?? 'completed',
      substage: resultStatus === 'dispatching' ? 'blocking_pending' : 'blocking_done',
      updatedBy: 'message-route',
      messageId: params.messageId,
      targetAgentId: agentTarget,
      detail: typeof responsePayload.response === 'string' ? responsePayload.response.slice(0, 120) : undefined,
      lastError: null,
    });
  }

  params.deps.broadcast({
    type: 'messageCompleted',
    messageId: params.messageId,
    result: responsePayload,
    callbackResult: senderResponse,
  });
  return {
    statusCode: 200,
    payload: { messageId: params.messageId, status: 'completed', result: responsePayload, callbackResult: senderResponse },
  };
}

export function executeAsyncMessageRoute(params: {
  deps: MessageRouteDeps;
  body: { sender?: string };
  targetId: string;
  requestMessage: unknown;
  requestSessionId: string | null;
  messageId: string;
  shouldPersistSession: boolean;
  channelId: string;
  displayChannels: DisplayChannelRequest[];
  parsedCommand: { shouldSwitch?: boolean; targetAgent?: string };
}): void {
  params.deps.hub.sendToModule(params.targetId, params.requestMessage, params.body.sender ? (result: any) => {
    void maybeSendCallback({
      deps: params.deps,
      sender: params.body.sender,
      messageId: params.messageId,
      payload: result,
    });
    return result;
  } : undefined)
    .then((result) => {
      const agentTarget = params.targetId ?? params.deps.primaryOrchestratorAgentId;
      const responsePayload = buildResponsePayload({
        result,
        agentTarget,
        parsedCommand: params.parsedCommand,
      });
      maybePersistAssistantMessage({
        deps: params.deps,
        shouldPersistSession: params.shouldPersistSession,
        requestSessionId: params.requestSessionId,
        channelId: params.channelId,
        agentTarget,
        rawResult: result,
        responsePayload,
      });

      if (params.displayChannels.length > 0) {
        sendDisplayFanout(params.deps.channelBridgeManager, params.displayChannels, responsePayload.response)
          .catch((err) => log.error('Failed to send display fanout', err instanceof Error ? err : undefined));
      }
      params.deps.mailbox.updateStatus(params.messageId, 'completed', responsePayload);
      if (params.requestSessionId) {
        const lifecycleStage = resolveLifecycleStageFromResultStatus(
          isObjectRecord(result) ? result.status : undefined,
        );
        applyExecutionLifecycleTransition(params.deps.sessionManager, params.requestSessionId, {
          stage: lifecycleStage ?? 'completed',
          substage: lifecycleStage === 'dispatching' ? 'async_pending' : 'async_done',
          updatedBy: 'message-route',
          messageId: params.messageId,
          targetAgentId: agentTarget,
          detail: typeof responsePayload.response === 'string' ? responsePayload.response.slice(0, 120) : undefined,
          lastError: null,
        });
      }
      params.deps.broadcast({ type: 'messageCompleted', messageId: params.messageId, result: responsePayload });
    })
    .catch((err) => {
      log.error('Hub send error', err instanceof Error ? err : undefined, { target: params.targetId, messageId: params.messageId });
      params.deps.mailbox.updateStatus(params.messageId, 'failed', undefined, err.message);
      if (params.requestSessionId) {
        applyExecutionLifecycleTransition(params.deps.sessionManager, params.requestSessionId, {
          stage: 'failed',
          substage: 'async_failed',
          updatedBy: 'message-route',
          messageId: params.messageId,
          targetAgentId: params.targetId,
          lastError: err instanceof Error ? err.message : String(err),
        });
      }
    });
}
