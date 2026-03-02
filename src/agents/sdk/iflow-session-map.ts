import { FINGER_PATHS } from '../../core/finger-paths.js';
import { SessionControlPlaneStore } from '../../runtime/session-control-plane.js';

export interface IflowSessionBinding {
  fingerSessionId: string;
  agentId: string;
  provider: string;
  iflowSessionId: string;
  updatedAt: string;
}

export interface IflowSessionMapScope {
  agentId?: string;
  provider?: string;
}

const DEFAULT_MAP_PATH = FINGER_PATHS.config.file.iflowSessionMap;
const DEFAULT_AGENT_ID = 'iflow-default';
const DEFAULT_PROVIDER = 'iflow';

export class IflowSessionMapStore {
  private readonly filePath: string;
  private readonly agentId: string;
  private readonly provider: string;
  private readonly controlPlaneStore: SessionControlPlaneStore;

  constructor(filePath = DEFAULT_MAP_PATH, scope: IflowSessionMapScope = {}) {
    this.filePath = filePath;
    this.agentId = scope.agentId ?? DEFAULT_AGENT_ID;
    this.provider = scope.provider ?? DEFAULT_PROVIDER;
    this.controlPlaneStore = new SessionControlPlaneStore(this.filePath);
  }

  getPath(): string {
    return this.filePath;
  }

  getScope(): { agentId: string; provider: string } {
    return {
      agentId: this.agentId,
      provider: this.provider,
    };
  }

  get(fingerSessionId: string): IflowSessionBinding | null {
    const binding = this.controlPlaneStore.get(fingerSessionId, this.agentId, this.provider);
    if (!binding) return null;
    return {
      fingerSessionId: binding.fingerSessionId,
      agentId: binding.agentId,
      provider: binding.provider,
      iflowSessionId: binding.providerSessionId,
      updatedAt: binding.updatedAt,
    };
  }

  set(fingerSessionId: string, iflowSessionId: string): IflowSessionBinding {
    const binding = this.controlPlaneStore.set(
      fingerSessionId,
      this.agentId,
      this.provider,
      iflowSessionId,
    );
    return {
      fingerSessionId: binding.fingerSessionId,
      agentId: binding.agentId,
      provider: binding.provider,
      iflowSessionId: binding.providerSessionId,
      updatedAt: binding.updatedAt,
    };
  }

  remove(fingerSessionId: string): boolean {
    return this.controlPlaneStore.remove(fingerSessionId, this.agentId, this.provider);
  }

  list(): IflowSessionBinding[] {
    return this.controlPlaneStore.list({
      agentId: this.agentId,
      provider: this.provider,
    }).map((binding) => ({
      fingerSessionId: binding.fingerSessionId,
      agentId: binding.agentId,
      provider: binding.provider,
      iflowSessionId: binding.providerSessionId,
      updatedAt: binding.updatedAt,
    }));
  }
}

export function resolveDefaultIflowSessionMapPath(): string {
  return DEFAULT_MAP_PATH;
}
