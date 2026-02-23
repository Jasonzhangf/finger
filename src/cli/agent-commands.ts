/**
 * Agent CLI Commands - Async wrappers that call daemon API
 * 
 * These commands send requests to the daemon and return immediately.
 * The daemon handles actual execution and broadcasts events via WebSocket.
 */

const API_BASE = process.env.FINGER_API_URL || 'http://localhost:8080';

export interface CommandOptions {
  sessionId?: string;
  blocking?: boolean;
  watch?: boolean;
}

/**
 * Send semantic understanding request to daemon
 */
export async function understandCommand(input: string, options: { sessionId?: string } = {}): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/agent/understand`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, sessionId: options.sessionId }),
  });
  
  if (!res.ok) {
    throw new Error(`Failed: ${res.statusText}`);
  }
  
  const result = await res.json();
  console.log('[CLI] Understanding request sent:', result);
}

/**
 * Send routing decision request to daemon
 */
export async function routeCommand(intentAnalysis: string, options: { sessionId?: string } = {}): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/agent/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intentAnalysis: JSON.parse(intentAnalysis), sessionId: options.sessionId }),
  });
  
  if (!res.ok) {
    throw new Error(`Failed: ${res.statusText}`);
  }
  
  const result = await res.json();
  console.log('[CLI] Routing request sent:', result);
}

/**
 * Send task planning request to daemon
 */
export async function planCommand(task: string, options: { sessionId?: string } = {}): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/agent/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, sessionId: options.sessionId }),
  });
  
  if (!res.ok) {
    throw new Error(`Failed: ${res.statusText}`);
  }
  
  const result = await res.json();
  console.log('[CLI] Planning request sent:', result);
}

/**
 * Send task execution request to daemon
 */
export async function executeCommand(task: string, options: { agent?: string; blocking?: boolean; sessionId?: string } = {}): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/agent/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      task, 
      agent: options.agent,
      blocking: options.blocking,
      sessionId: options.sessionId 
    }),
  });
  
  if (!res.ok) {
    throw new Error(`Failed: ${res.statusText}`);
  }
  
  const result = await res.json();
  if (options.blocking) {
    console.log('[CLI] Execution result:', result);
  } else {
    console.log('[CLI] Execution request sent:', result);
  }
}

/**
 * Send review request to daemon
 */
export async function reviewCommand(proposal: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/agent/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposal: JSON.parse(proposal) }),
  });
  
  if (!res.ok) {
    throw new Error(`Failed: ${res.statusText}`);
  }
  
  const result = await res.json();
  console.log('[CLI] Review request sent:', result);
}

/**
 * Send orchestration request to daemon
 */
export async function orchestrateCommand(task: string, options: { sessionId?: string; watch?: boolean } = {}): Promise<void> {
  const res = await fetch(`${API_BASE}/api/v1/agent/orchestrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      task, 
      sessionId: options.sessionId,
      watch: options.watch,
    }),
  });
  
  if (!res.ok) {
    throw new Error(`Failed: ${res.statusText}`);
  }
  
  const result = await res.json();
  console.log('[CLI] Orchestration request sent:', result);
  
  if (options.watch) {
    console.log('[CLI] Watching events via WebSocket...');
    // WebSocket streaming handled by server
  }
}
