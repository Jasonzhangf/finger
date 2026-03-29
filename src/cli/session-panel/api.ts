import type {
  MessageApiResponse,
  MessagesApiResponse,
  PanelHistoryEntry,
  SessionRecord,
} from './types.js';
import { extractPanelReply } from './reply.js';
import { isRecord } from './utils.js';

export async function sendPanelInput(
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

export async function resolveSessionId(daemonUrl: string, requested?: string): Promise<string> {
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

export async function ensureSessionExists(daemonUrl: string, sessionId: string): Promise<void> {
  const response = await fetch(`${daemonUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}`);
  if (!response.ok) {
    throw new Error(`Session not found: ${sessionId}`);
  }
}

export async function getCurrentSession(daemonUrl: string): Promise<SessionRecord | null> {
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

export async function createSession(daemonUrl: string, name?: string): Promise<SessionRecord> {
  return requestJson<SessionRecord>(`${daemonUrl}/api/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectPath: process.cwd(),
      name: name || `CLI Session ${new Date().toISOString()}`,
    }),
  });
}

export async function setCurrentSession(daemonUrl: string, sessionId: string): Promise<void> {
  await requestJson<{ success: boolean }>(`${daemonUrl}/api/v1/sessions/current`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

export async function loadSessionHistory(daemonUrl: string, sessionId: string): Promise<PanelHistoryEntry[]> {
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

export async function ensureDaemonHealthy(daemonUrl: string): Promise<void> {
  const response = await fetch(`${daemonUrl}/health`);
  if (!response.ok) {
    throw new Error(`Daemon not responding: ${daemonUrl}`);
  }
}

export async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
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
