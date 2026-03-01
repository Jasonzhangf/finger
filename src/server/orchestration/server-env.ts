import { FINGER_PATHS } from '../../core/finger-paths.js';
import { FINGER_ORCHESTRATOR_AGENT_ID } from '../../agents/finger-general/finger-general-module.js';
import { resolveBoolFlag } from '../common/runtime-debug.js';

export interface ServerEnv {
  port: number;
  wsPort: number;
  httpBodyLimit: string;
  blockingMessageTimeoutMs: number;
  blockingMessageMaxRetries: number;
  blockingMessageRetryBaseMs: number;
  errorSampleDir: string;
  primaryOrchestratorAgentId: string;
  primaryOrchestratorGatewayId: string;
  legacyOrchestratorAgentId: string;
  legacyOrchestratorGatewayId: string;
  primaryOrchestratorTarget: string;
  allowDirectAgentRoute: boolean;
  enableFullMockMode: boolean;
  enableRuntimeDebugMode: boolean;
  enableLegacyChatCodexAlias: boolean;
  enableMockExecutor: boolean;
  enableMockReviewer: boolean;
  enableMockSearcher: boolean;
  useMockExecutorLoop: boolean;
  useMockReviewerLoop: boolean;
  useMockSearcherLoop: boolean;
}

export function resolveServerEnv(): ServerEnv {
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 5521;
  const wsPort = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 5522;
  const httpBodyLimit = process.env.FINGER_HTTP_BODY_LIMIT || '20mb';
  const blockingMessageTimeoutMs = Number.isFinite(Number(process.env.FINGER_BLOCKING_MESSAGE_TIMEOUT_MS))
    ? Math.max(1000, Math.floor(Number(process.env.FINGER_BLOCKING_MESSAGE_TIMEOUT_MS)))
    : 600_000;
  const blockingMessageMaxRetries = Number.isFinite(Number(process.env.FINGER_BLOCKING_MESSAGE_MAX_RETRIES))
    ? Math.max(0, Math.floor(Number(process.env.FINGER_BLOCKING_MESSAGE_MAX_RETRIES)))
    : 5;
  const blockingMessageRetryBaseMs = Number.isFinite(Number(process.env.FINGER_BLOCKING_MESSAGE_RETRY_BASE_MS))
    ? Math.max(100, Math.floor(Number(process.env.FINGER_BLOCKING_MESSAGE_RETRY_BASE_MS)))
    : 750;

  const primaryOrchestratorAgentId = FINGER_ORCHESTRATOR_AGENT_ID;
  const primaryOrchestratorGatewayId = 'finger-orchestrator-gateway';
  const legacyOrchestratorAgentId = 'chat-codex';
  const legacyOrchestratorGatewayId = 'chat-codex-gateway';
  const primaryOrchestratorTarget = (
    process.env.FINGER_PRIMARY_ORCHESTRATOR_TARGET
    || process.env.VITE_CHAT_PANEL_TARGET
    || primaryOrchestratorGatewayId
  ).trim();

  const allowDirectAgentRoute = process.env.FINGER_ALLOW_DIRECT_AGENT_ROUTE === '1';
  const enableFullMockMode = resolveBoolFlag('FINGER_FULL_MOCK_MODE', false);
  const enableRuntimeDebugMode = resolveBoolFlag('FINGER_RUNTIME_DEBUG_MODE', false);
  const enableLegacyChatCodexAlias = resolveBoolFlag('FINGER_ENABLE_LEGACY_CHAT_CODEX_ALIAS', false);
  const enableMockExecutor = resolveBoolFlag('FINGER_ENABLE_MOCK_EXECUTOR', false);
  const enableMockReviewer = resolveBoolFlag('FINGER_ENABLE_MOCK_REVIEWER', false);
  const enableMockSearcher = resolveBoolFlag('FINGER_ENABLE_MOCK_SEARCHER', false);
  const useMockExecutorLoop = resolveBoolFlag('FINGER_MOCK_EXECUTOR_LOOP', enableFullMockMode);
  const useMockReviewerLoop = resolveBoolFlag('FINGER_MOCK_REVIEWER_LOOP', enableFullMockMode);
  const useMockSearcherLoop = resolveBoolFlag('FINGER_MOCK_SEARCHER_LOOP', true);

  return {
    port,
    wsPort,
    httpBodyLimit,
    blockingMessageTimeoutMs,
    blockingMessageMaxRetries,
    blockingMessageRetryBaseMs,
    errorSampleDir: FINGER_PATHS.logs.errorsamplesDir,
    primaryOrchestratorAgentId,
    primaryOrchestratorGatewayId,
    legacyOrchestratorAgentId,
    legacyOrchestratorGatewayId,
    primaryOrchestratorTarget,
    allowDirectAgentRoute,
    enableFullMockMode,
    enableRuntimeDebugMode,
    enableLegacyChatCodexAlias,
    enableMockExecutor,
    enableMockReviewer,
    enableMockSearcher,
    useMockExecutorLoop,
    useMockReviewerLoop,
    useMockSearcherLoop,
  };
}
