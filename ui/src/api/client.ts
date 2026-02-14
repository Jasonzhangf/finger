const API_BASE = '/api';

export type UnknownArgs = unknown[];
export type UnknownRecord = Record<string, unknown>;

export interface BlockInfo {
  type: string;
  id: string;
  capabilities: {
    functions: string[];
    cli: Array<{ name: string; description: string; args: UnknownArgs }>;
    stateSchema: UnknownRecord;
    events?: string[];
  };
  state: {
    id: string;
    type: string;
    status: 'idle' | 'running' | 'error' | 'stopped';
    health: 'healthy' | 'degraded' | 'unhealthy';
    data: UnknownRecord;
    updatedAt: string;
  };
}

export async function fetchBlocks(): Promise<BlockInfo[]> {
  const res = await fetch(`${API_BASE}/blocks`);
  if (!res.ok) throw new Error(`Failed to fetch blocks: ${res.status}`);
  return res.json() as Promise<BlockInfo[]>;
}

export async function fetchBlockState(blockId: string): Promise<UnknownRecord> {
  const res = await fetch(`${API_BASE}/blocks/${blockId}/state`);
  if (!res.ok) throw new Error(`Failed to fetch block state: ${res.status}`);
  return res.json() as Promise<UnknownRecord>;
}

export async function executeBlockCommand(
  blockId: string,
  command: string,
  args: UnknownRecord = {}
): Promise<UnknownRecord> {
  const res = await fetch(`${API_BASE}/blocks/${blockId}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, args }),
  });

  if (!res.ok) {
    const err = (await res.json()) as { error?: string };
    throw new Error(err.error || 'Unknown error');
  }

  return res.json() as Promise<UnknownRecord>;
}
