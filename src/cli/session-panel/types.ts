export interface PanelHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export interface SessionPanelState {
  target: string;
  sessionId: string;
  history: PanelHistoryEntry[];
  projectAgentTarget?: string;
  panelName?: string;
}

export interface SessionPanelOptions {
  daemonUrl: string;
  wsUrl: string;
  target: string;
  sessionId?: string;
  events: boolean;
  projectAgentTarget?: string;
  panelName?: string;
}

export interface SessionRecord {
  id: string;
}

export interface MessageApiResponse {
  messageId?: string;
  status?: string;
  result?: unknown;
  error?: string;
}

export interface MessagesApiResponse {
  success?: boolean;
  messages?: Array<{ role?: string; content?: string }>;
  error?: string;
}
