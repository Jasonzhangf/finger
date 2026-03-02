export interface ServerRuntimeFlags {
  enableFullMockMode: boolean;
  enableLegacyChatCodexAlias: boolean;
  enableMockExecutor: boolean;
  enableMockReviewer: boolean;
  enableMockSearcher: boolean;
  useMockExecutorLoop: boolean;
  useMockReviewerLoop: boolean;
  useMockSearcherLoop: boolean;
  runtimeDebugMode: boolean;
}

function resolveBoolFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

export function resolveRuntimeFlags(): ServerRuntimeFlags {
  const enableFullMockMode = resolveBoolFlag('FINGER_FULL_MOCK_MODE', false);
  const enableLegacyChatCodexAlias = resolveBoolFlag('FINGER_ENABLE_LEGACY_CHAT_CODEX_ALIAS', false);
  const enableMockExecutor = resolveBoolFlag('FINGER_ENABLE_MOCK_EXECUTOR', false);
  const enableMockReviewer = resolveBoolFlag('FINGER_ENABLE_MOCK_REVIEWER', false);
  const enableMockSearcher = resolveBoolFlag('FINGER_ENABLE_MOCK_SEARCHER', false);
  const useMockExecutorLoop = resolveBoolFlag('FINGER_MOCK_EXECUTOR_LOOP', enableFullMockMode);
  const useMockReviewerLoop = resolveBoolFlag('FINGER_MOCK_REVIEWER_LOOP', enableFullMockMode);
  const useMockSearcherLoop = resolveBoolFlag('FINGER_MOCK_SEARCHER_LOOP', true);
  const runtimeDebugMode = resolveBoolFlag('FINGER_RUNTIME_DEBUG_MODE', false);

  return {
    enableFullMockMode,
    enableLegacyChatCodexAlias,
    enableMockExecutor,
    enableMockReviewer,
    enableMockSearcher,
    useMockExecutorLoop,
    useMockReviewerLoop,
    useMockSearcherLoop,
    runtimeDebugMode,
  };
}
