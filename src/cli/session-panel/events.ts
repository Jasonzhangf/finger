import type { Interface } from 'readline';
import WebSocket, { type RawData } from 'ws';
import type { SessionPanelState } from './types.js';
import { DEFAULT_WS_URL, EVENT_GROUPS } from './constants.js';
import { isRecord } from './utils.js';
import { safePrompt } from './ui.js';

export function deriveWsUrl(daemonUrl: string, wsUrl?: string): string {
  if (wsUrl && wsUrl.trim().length > 0) {
    return wsUrl.trim();
  }

  try {
    const parsed = new URL(daemonUrl);
    const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${parsed.hostname}:9998`;
  } catch {
    return DEFAULT_WS_URL;
  }
}

export function connectEventStream(wsUrl: string, state: SessionPanelState, rl: Interface): WebSocket | null {
  try {
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'subscribe', groups: EVENT_GROUPS }));
    });

    ws.on('message', (raw: RawData) => {
      const preview = formatEventPreview(raw, state.sessionId);
      if (!preview) return;
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
  if (!compact) return '';
  if (compact.length <= 140) return compact;
  return `${compact.slice(0, 137)}...`;
}
