export const CHAT_PANEL_TARGET = (import.meta.env.VITE_CHAT_PANEL_TARGET as string | undefined)?.trim()
  || 'finger-orchestrator-gateway';
export const DEFAULT_CHAT_AGENT_ID = 'finger-orchestrator';
export const ENABLE_UI_DIRECT_AGENT_TEST_ROUTE =
  (import.meta.env.VITE_UI_DIRECT_AGENT_TEST_ROUTE as string | undefined)?.trim() === '1';
export const MAX_INLINE_FILE_TEXT_CHARS = 12000;
export const SESSION_MESSAGES_FETCH_LIMIT = 0;
export const DEFAULT_CONTEXT_HISTORY_WINDOW_SIZE = 40;
const parsedContextWindowSize = Number(import.meta.env.VITE_CONTEXT_HISTORY_WINDOW_SIZE ?? '');
export const CONTEXT_HISTORY_WINDOW_SIZE =
  Number.isFinite(parsedContextWindowSize) && parsedContextWindowSize > 0
    ? Math.floor(parsedContextWindowSize)
    : DEFAULT_CONTEXT_HISTORY_WINDOW_SIZE;

export const SESSION_BOUND_WS_TYPES = new Set([
  'chat_codex_turn',
  'tool_call',
  'tool_result',
  'tool_error',
  'user_message',
  'assistant_chunk',
  'assistant_complete',
  'waiting_for_user',
  'user_decision_received',
  'phase_transition',
  'workflow_progress',
  'workflow_update',
  'agent_update',
  'agent_runtime_dispatch',
  'agent_runtime_control',
  'agent_runtime_status',
  'agent_runtime_mock_assertion',
  'runtime_status_changed',
  'runtime_finished',
  'input_lock_changed',
  'typing_indicator',
  'input_lock_heartbeat_ack',
]);

export const DEFAULT_LEDGER_FOCUS_MAX_CHARS = 20_000;
export const SEND_RETRY_MAX_ATTEMPTS = 10;
export const SEND_RETRY_BASE_DELAY_MS = 3000;
export const DEBUG_SNAPSHOTS_STORAGE_KEY = 'finger-debug-snapshots-enabled';
