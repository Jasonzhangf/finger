import { createInterface, type Interface } from 'readline';
import type { Command } from 'commander';
import WebSocket, { type RawData } from 'ws';

const DEFAULT_DAEMON_URL = process.env.FINGER_HUB_URL || 'http://localhost:5521';
const DEFAULT_WS_URL = process.env.FINGER_WS_URL || 'ws://localhost:5522';
const DEFAULT_GATEWAY_TARGET = 'chat-gateway';

const EVENT_GROUPS = [
  'SESSION',
  'TASK',
  'TOOL',
  'DIALOG',
  'PROGRESS',
  'PHASE',
  'HUMAN_IN_LOOP',
  'SYSTEM',
];

interface PanelHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

interface SessionPanelState {
  target: string;
  sessionId: string;
  history: PanelHistoryEntry[];
}

interface SessionPanelOptions {
  daemonUrl: string;
  wsUrl: string;
  target: string;
  sessionId?: string;
  events: boolean;
}

interface SessionRecord {
  id: string;
}

interface MessageApiResponse {
  messageId?: string;
  status?: string;
  result?: unknown;
  error?: string;
}

interface MessagesApiResponse {
  success?: boolean;
  messages?: Array<{ role?: string; content?: string }>;
  error?: string;
}

export function registerSessionPanelCommand(program: Command): void {
  program
    .command('session-panel')
    .description('会话面板 CLI（作为 daemon 的统一 IO 入口）')
    .option('-u, --url <url>', 'Daemon URL', DEFAULT_DAEMON_URL)
    .option('-w, --ws-url <url>', 'WebSocket URL', DEFAULT_WS_URL)
    .option('-t, --target <moduleId>', 'Gateway/agent target module ID', DEFAULT_GATEWAY_TARGET)
    .option('-s, --session <id>', 'Use existing session ID')
    .option('--no-events', 'Disable WebSocket event stream')
    .action(async (options: { url: string; wsUrl: string; target: string; session?: string; events: boolean }) => {
      await startSessionPanel({
        daemonUrl: options.url,
        wsUrl: options.wsUrl,
        target: options.target,
        sessionId: options.session,
        events: options.events,
      });
    });
}

export async function startSessionPanel(options: SessionPanelOptions): Promise<void> {
  await ensureDaemonHealthy(options.daemonUrl);

  const state: SessionPanelState = {
    target: options.target,
    sessionId: await resolveSessionId(options.daemonUrl, options.sessionId),
    history: [],
  };

  state.history = await loadSessionHistory(options.daemonUrl, state.sessionId);

  printHeader(state);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You: ',
  });

  const resolvedWsUrl = deriveWsUrl(options.daemonUrl, options.wsUrl);
  const ws = options.events ? connectEventStream(resolvedWsUrl, state, rl) : null;

  safePrompt(rl);

  for await (const line of rl) {
    const input = line.trim();

    if (input.length === 0) {
      safePrompt(rl);
      continue;
    }

    if (input.startsWith('/')) {
      const keepRunning = await runPanelCommand(input, state, options.daemonUrl);
      if (!keepRunning) {
        break;
      }
      safePrompt(rl);
      continue;
    }

    state.history.push({ role: 'user', content: input });

    try {
      const reply = await sendPanelInput(options.daemonUrl, state.target, state.sessionId, input, state.history);
      console.log(`Agent: ${reply}\n`);
      state.history.push({ role: 'assistant', content: reply });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}\n`);
    }

    safePrompt(rl);
  }

  if (ws) {
    ws.close();
  }
  const status = rl as unknown as { closed?: boolean };
  if (!status.closed) {
    rl.close();
  }
  process.stdin.pause();
}

export function deriveWsUrl(daemonUrl: string, wsUrl?: string): string {
  if (wsUrl && wsUrl.trim().length > 0) {
    return wsUrl.trim();
  }

  try {
    const parsed = new URL(daemonUrl);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${parsed.hostname}:5522`;
  } catch {
    return DEFAULT_WS_URL;
  }
}

export function extractPanelReply(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }

  if (!isRecord(result)) {
    return JSON.stringify(result);
  }

  if (typeof result.response === 'string') {
    return result.response;
  }

  if (typeof result.output === 'string') {
    return result.output;
  }

  if (isRecord(result.output) && typeof result.output.response === 'string') {
    return result.output.response;
  }

  if (typeof result.error === 'string' && result.error.length > 0) {
    return `Error: ${result.error}`;
  }

  return JSON.stringify(result, null, 2);
}

async function runPanelCommand(input: string, state: SessionPanelState, daemonUrl: string): Promise<boolean> {
  const [rawCommand, ...rest] = input.slice(1).trim().split(/\s+/);
  const command = rawCommand?.toLowerCase() || '';

  if (command === 'exit' || command === 'quit') {
    return false;
  }

  if (command === 'help') {
    printHelp();
    return true;
  }

  if (command === 'history') {
    printHistory(state.history);
    return true;
  }

  if (command === 'session') {
    console.log(`Session: ${state.sessionId}`);
    console.log(`Target:  ${state.target}`);
    console.log('');
    return true;
  }

  if (command === 'target') {
    const nextTarget = rest.join(' ').trim();
    if (!nextTarget) {
      console.log(`Current target: ${state.target}\n`);
      return true;
    }
    state.target = nextTarget;
    console.log(`Target switched to: ${state.target}\n`);
    return true;
  }

  if (command === 'new') {
    const nextSession = await createSession(daemonUrl, rest.join(' ').trim() || undefined);
    await setCurrentSession(daemonUrl, nextSession.id);
    state.sessionId = nextSession.id;
    state.history = [];
    console.log(`Switched to new session: ${state.sessionId}\n`);
    return true;
  }

  if (command === 'switch') {
    const nextSessionId = rest[0];
    if (!nextSessionId) {
      console.log('Usage: /switch <sessionId>\n');
      return true;
    }
    await ensureSessionExists(daemonUrl, nextSessionId);
    await setCurrentSession(daemonUrl, nextSessionId);
    state.sessionId = nextSessionId;
    state.history = await loadSessionHistory(daemonUrl, state.sessionId);
    console.log(`Switched to session: ${state.sessionId}\n`);
    return true;
  }

  console.log(`Unknown command: /${command}`);
  printHelp();
  return true;
}

function connectEventStream(wsUrl: string, state: SessionPanelState, rl: Interface): WebSocket | null {
  try {
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', groups: EVENT_GROUPS }));
    });

    ws.on('message', (raw: RawData) => {
      const preview = formatEventPreview(raw, state.sessionId);
      if (!preview) {
        return;
      }

      process.stdout.write(`\n${preview}\n`);
      safePrompt(rl);
    });

    ws.on('error', (error: Error) => {
      const text = (error.message || '').toLowerCase();
      if (
        ws.readyState === WebSocket.CLOSING ||
        ws.readyState === WebSocket.CLOSED ||
        text.includes('closed before the connection was established')
      ) {
        return;
      }
      process.stdout.write(`\n[event] websocket error: ${error.message}\n`);
      safePrompt(rl);
    });

    return ws;
  } catch {
    return null;
  }
}

function formatEventPreview(raw: RawData, currentSessionId: string): string | null {
  const text = raw.toString();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return null;
  }

  if (parsed.type === 'subscribe_confirmed' || parsed.type === 'unsubscribe_confirmed') {
    return null;
  }

  const sessionId = findSessionId(parsed);
  if (sessionId && sessionId !== currentSessionId) {
    return null;
  }

  const group = typeof parsed.group === 'string' ? parsed.group : 'EVENT';
  const detail = summarizePayload(parsed.payload);
  if (detail) {
    return `[${group}] ${parsed.type} ${detail}`;
  }

  return `[${group}] ${parsed.type}`;
}

function findSessionId(event: Record<string, unknown>): string | null {
  if (typeof event.sessionId === 'string' && event.sessionId.length > 0) {
    return event.sessionId;
  }
  if (isRecord(event.payload) && typeof event.payload.sessionId === 'string' && event.payload.sessionId.length > 0) {
    return event.payload.sessionId;
  }
  return null;
}

function summarizePayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return '';
  }

  if (typeof payload.message === 'string' && payload.message.length > 0) {
    return payload.message;
  }

  if (typeof payload.error === 'string' && payload.error.length > 0) {
    return `error=${payload.error}`;
  }

  const compact = JSON.stringify(payload);
  if (!compact) {
    return '';
  }

  if (compact.length <= 140) {
    return compact;
  }

  return `${compact.slice(0, 137)}...`;
}

async function sendPanelInput(
  daemonUrl: string,
  target: string,
  sessionId: string,
  input: string,
  history: PanelHistoryEntry[],
): Promise<string> {
  const payload = await requestJson<MessageApiResponse>(`${daemonUrl}/api/v1/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target,
      blocking: true,
      message: {
        text: input,
        sessionId,
        history,
        deliveryMode: 'sync',
      },
    }),
  });

  if (payload.error) {
    throw new Error(payload.error);
  }

  if (payload.result === undefined) {
    throw new Error('Empty result from daemon');
  }

  return extractPanelReply(payload.result);
}

async function resolveSessionId(daemonUrl: string, requested?: string): Promise<string> {
  if (requested) {
    await ensureSessionExists(daemonUrl, requested);
    await setCurrentSession(daemonUrl, requested);
    return requested;
  }

  const current = await getCurrentSession(daemonUrl);
  if (current?.id) {
    return current.id;
  }

  const created = await createSession(daemonUrl);
  await setCurrentSession(daemonUrl, created.id);
  return created.id;
}

async function ensureSessionExists(daemonUrl: string, sessionId: string): Promise<void> {
  const response = await fetch(`${daemonUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`);
  if (!response.ok) {
    throw new Error(`Session not found: ${sessionId}`);
  }
}

async function getCurrentSession(daemonUrl: string): Promise<SessionRecord | null> {
  const response = await fetch(`${daemonUrl}/api/v1/sessions/current`);
  if (response.status === 404) {
    return null;
  }
  const raw = await response.text();
  let payload: unknown = {};
  if (raw.trim().length > 0) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Invalid JSON response from daemon (${response.status})`);
    }
  }

  if (!response.ok) {
    if (isRecord(payload) && typeof payload.error === 'string') {
      throw new Error(payload.error);
    }
    throw new Error(`HTTP ${response.status}`);
  }
  return payload as SessionRecord;
}

async function createSession(daemonUrl: string, name?: string): Promise<SessionRecord> {
  return requestJson<SessionRecord>(`${daemonUrl}/api/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath: process.cwd(),
      name: name || `CLI Session ${new Date().toISOString()}`,
    }),
  });
}

async function setCurrentSession(daemonUrl: string, sessionId: string): Promise<void> {
  await requestJson<{ success: boolean }>(`${daemonUrl}/api/v1/sessions/current`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

async function loadSessionHistory(daemonUrl: string, sessionId: string): Promise<PanelHistoryEntry[]> {
  const payload = await requestJson<MessagesApiResponse>(
    `${daemonUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
  );

  const entries = Array.isArray(payload.messages) ? payload.messages : [];
  const history: PanelHistoryEntry[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry.content !== 'string') {
      continue;
    }
    const role = entry.role === 'assistant' ? 'assistant' : entry.role === 'user' ? 'user' : null;
    if (!role) {
      continue;
    }
    history.push({ role, content: entry.content });
  }

  return history;
}

async function ensureDaemonHealthy(daemonUrl: string): Promise<void> {
  const response = await fetch(`${daemonUrl}/health`);
  if (!response.ok) {
    throw new Error(`Daemon not responding: ${daemonUrl}`);
  }
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  const raw = await response.text();
  let payload: unknown = {};
  if (raw.trim().length > 0) {
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Invalid JSON response from daemon (${response.status})`);
    }
  }

  if (!response.ok) {
    if (isRecord(payload) && typeof payload.error === 'string') {
      throw new Error(payload.error);
    }
    throw new Error(`HTTP ${response.status}`);
  }
  return payload as T;
}

function printHeader(state: SessionPanelState): void {
  console.log('\nSession Panel (CLI IO Gateway)');
  console.log('------------------------------');
  console.log(`Session: ${state.sessionId}`);
  console.log(`Target:  ${state.target}`);
  printHelp();
}

function printHelp(): void {
  console.log('Commands:');
  console.log('  /help                 Show this help');
  console.log('  /history              Show local conversation history');
  console.log('  /session              Show current session and target');
  console.log('  /target <moduleId>    Switch target gateway/agent');
  console.log('  /new [name]           Create and switch to new session');
  console.log('  /switch <sessionId>   Switch to existing session');
  console.log('  /exit                 Exit panel');
  console.log('');
}

function printHistory(history: PanelHistoryEntry[]): void {
  if (history.length === 0) {
    console.log('History is empty.\n');
    return;
  }

  console.log('History:');
  for (const item of history) {
    const prefix = item.role === 'user' ? 'You' : 'Agent';
    console.log(`${prefix}: ${item.content}`);
  }
  console.log('');
}

function safePrompt(rl: Interface): void {
  const status = rl as unknown as { closed?: boolean };
  if (status.closed) {
    return;
  }

  try {
    rl.prompt();
  } catch (error) {
    const maybeNodeError = error as { code?: string };
    if (maybeNodeError.code !== 'ERR_USE_AFTER_CLOSE') {
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
