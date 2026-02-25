/**
 * Finger Core Daemon - Schema Definitions
 */

export const CURRENT_VERSION = "v1";

export interface Message {
  version: "v1";
  type: string;
  payload: unknown;
  meta: {
    id: string;
    timestamp: number;
    source: string;
    dest?: string;
    traceId?: string;
  };
}

export function createMessage(
  type: string,
  payload: unknown,
  source: string,
  options?: { dest?: string; traceId?: string }
): Message {
  return {
    version: CURRENT_VERSION,
    type,
    payload,
    meta: {
      id: generateId(),
      timestamp: Date.now(),
      source,
      ...options,
    },
  };
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export interface RouteRule {
  id: string;
  match: {
    type?: string;
    source?: string;
    pattern?: string;
  };
  dest: string[];
  priority: number;
}

export interface RegistryEntry {
  id: string;
  type: "input" | "output";
  kind: string;
  config: Record<string, unknown>;
  status: "active" | "paused" | "error";
  lastHeartbeat: number;
}

export interface InputsConfig {
  version: "v1";
  inputs: Array<{
    id: string;
    kind: string;
    enabled: boolean;
    config?: Record<string, unknown>;
  }>;
}

export interface OutputsConfig {
  version: "v1";
  outputs: Array<{
    id: string;
    kind: string;
    enabled: boolean;
    config?: Record<string, unknown>;
  }>;
}

export interface RoutesConfig {
  version: "v1";
  routes: RouteRule[];
}
