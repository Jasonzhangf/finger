import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { FINGER_PATHS, ensureDir } from '../core/finger-paths.js';

export interface SessionBindingRecord {
  fingerSessionId: string;
  agentId: string;
  provider: string;
  providerSessionId: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

interface SessionControlPlaneFile {
  version: '2.0.0';
  bindings: Record<string, SessionBindingRecord>;
}

const DEFAULT_CONTROL_PLANE_PATH = FINGER_PATHS.config.file.sessionControlPlane;
const LEGACY_IFLOW_AGENT_ID = 'iflow-default';
const LEGACY_IFLOW_PROVIDER = 'iflow';

export interface SessionBindingFilter {
  fingerSessionId?: string;
  agentId?: string;
  provider?: string;
}

export class SessionControlPlaneStore {
  private readonly filePath: string;

  constructor(filePath = DEFAULT_CONTROL_PLANE_PATH) {
    this.filePath = filePath;
  }

  getPath(): string {
    return this.filePath;
  }

  get(fingerSessionId: string, agentId: string, provider: string): SessionBindingRecord | null {
    const map = this.read();
    const key = toBindingKey(fingerSessionId, agentId, provider);
    return map.bindings[key] ?? null;
  }

  set(
    fingerSessionId: string,
    agentId: string,
    provider: string,
    providerSessionId: string,
    metadata?: Record<string, unknown>,
  ): SessionBindingRecord {
    const map = this.read();
    const key = toBindingKey(fingerSessionId, agentId, provider);
    const binding: SessionBindingRecord = {
      fingerSessionId,
      agentId,
      provider,
      providerSessionId,
      updatedAt: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    };
    map.bindings[key] = binding;
    this.write(map);
    return binding;
  }

  remove(fingerSessionId: string, agentId: string, provider: string): boolean {
    const map = this.read();
    const key = toBindingKey(fingerSessionId, agentId, provider);
    if (!map.bindings[key]) return false;
    delete map.bindings[key];
    this.write(map);
    return true;
  }

  list(filter: SessionBindingFilter = {}): SessionBindingRecord[] {
    const map = this.read();
    return Object.values(map.bindings)
      .filter((item) => (filter.fingerSessionId ? item.fingerSessionId === filter.fingerSessionId : true))
      .filter((item) => (filter.agentId ? item.agentId === filter.agentId : true))
      .filter((item) => (filter.provider ? item.provider === filter.provider : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private read(): SessionControlPlaneFile {
    if (!existsSync(this.filePath)) {
      return createEmptyMap();
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      return parseSessionControlPlaneFile(parsed);
    } catch {
      return createEmptyMap();
    }
  }

  private write(map: SessionControlPlaneFile): void {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    ensureDir(FINGER_PATHS.config.dir);
    writeFileSync(this.filePath, JSON.stringify(map, null, 2), 'utf-8');
  }
}

function parseSessionControlPlaneFile(value: unknown): SessionControlPlaneFile {
  if (!isRecord(value) || !isRecord(value.bindings)) {
    return createEmptyMap();
  }

  const bindings: Record<string, SessionBindingRecord> = {};
  for (const [key, rawBinding] of Object.entries(value.bindings)) {
    const parsed = parseBinding(rawBinding, key);
    if (!parsed) continue;
    const normalizedKey = toBindingKey(parsed.fingerSessionId, parsed.agentId, parsed.provider);
    bindings[normalizedKey] = parsed;
  }

  return {
    version: '2.0.0',
    bindings,
  };
}

function parseBinding(rawBinding: unknown, fallbackFingerSessionId: string): SessionBindingRecord | null {
  if (!isRecord(rawBinding)) return null;

  if (
    typeof rawBinding.fingerSessionId === 'string'
    && typeof rawBinding.agentId === 'string'
    && typeof rawBinding.provider === 'string'
    && typeof rawBinding.providerSessionId === 'string'
    && typeof rawBinding.updatedAt === 'string'
  ) {
    return {
      fingerSessionId: rawBinding.fingerSessionId,
      agentId: rawBinding.agentId,
      provider: rawBinding.provider,
      providerSessionId: rawBinding.providerSessionId,
      updatedAt: rawBinding.updatedAt,
      ...(isRecord(rawBinding.metadata) ? { metadata: rawBinding.metadata } : {}),
    };
  }

  // 兼容旧格式：{ fingerSessionId, iflowSessionId, updatedAt }
  if (typeof rawBinding.iflowSessionId === 'string' && typeof rawBinding.updatedAt === 'string') {
    const fingerSessionId =
      typeof rawBinding.fingerSessionId === 'string' && rawBinding.fingerSessionId.trim().length > 0
        ? rawBinding.fingerSessionId
        : fallbackFingerSessionId;
    return {
      fingerSessionId,
      agentId: LEGACY_IFLOW_AGENT_ID,
      provider: LEGACY_IFLOW_PROVIDER,
      providerSessionId: rawBinding.iflowSessionId,
      updatedAt: rawBinding.updatedAt,
    };
  }

  return null;
}

function createEmptyMap(): SessionControlPlaneFile {
  return {
    version: '2.0.0',
    bindings: {},
  };
}

function toBindingKey(fingerSessionId: string, agentId: string, provider: string): string {
  return `${provider}::${agentId}::${fingerSessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function resolveDefaultSessionControlPlanePath(): string {
  return DEFAULT_CONTROL_PLANE_PATH;
}
