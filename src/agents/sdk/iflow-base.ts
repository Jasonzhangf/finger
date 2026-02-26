import type { CommandInfo, IFlowOptions, McpServerInfo, SkillInfo } from '@iflow-ai/iflow-cli-sdk';
import { IFlowClient } from '@iflow-ai/iflow-cli-sdk';
import {
  type IflowGovernanceConfig,
  resolveIflowGovernance,
  type InjectedCapabilityCommand,
} from './iflow-governor.js';
import { type IflowSessionBinding, IflowSessionMapStore } from './iflow-session-map.js';

/**
 * iFlow Agent 基础信息
 */
export interface IflowAgentInfo {
  sessionId: string;
  connected: boolean;
  sessionAgentId: string;
  sessionProvider: string;
  cwd: string;
  addDirs: string[];
  availableCommands: string[];
  availableAgents: string[];
  availableSkills: string[];
  availableMcpServers: string[];
  configuredAllowedTools: string[];
  configuredDisallowedTools: string[];
  injectedCommands: string[];
  injectedCapabilities: string[];
  fingerSessionId?: string;
}

export interface IflowGovernedOptions extends IFlowOptions {
  governance?: IflowGovernanceConfig;
  fingerSessionId?: string;
  sessionMapPath?: string;
  sessionAgentId?: string;
  sessionProvider?: string;
}

interface NamedConfig {
  name: string;
}

/**
 * 基础接口：只负责连接、session、能力查询，不涉及任务执行
 */
export class IflowBaseAgent {
  protected client: IFlowClient;
  protected readonly sessionMapStore: IflowSessionMapStore;
  protected readonly sessionAgentId: string;
  protected readonly sessionProvider: string;
  private governedOptions: IflowGovernedOptions | null;
  private injectedCapabilityCommands: InjectedCapabilityCommand[];
  protected info: IflowAgentInfo = {
    sessionId: '',
    connected: false,
    sessionAgentId: 'iflow-default',
    sessionProvider: 'iflow',
    cwd: '',
    addDirs: [],
    availableCommands: [],
    availableAgents: [],
    availableSkills: [],
    availableMcpServers: [],
    configuredAllowedTools: [],
    configuredDisallowedTools: [],
    injectedCommands: [],
    injectedCapabilities: [],
  };

  constructor(clientOrOptions?: IFlowClient | IflowGovernedOptions) {
    this.governedOptions = null;
    this.injectedCapabilityCommands = [];
    this.sessionAgentId = 'iflow-default';
    this.sessionProvider = 'iflow';

    if (clientOrOptions instanceof IFlowClient) {
      this.client = clientOrOptions;
      this.sessionMapStore = new IflowSessionMapStore(undefined, {
        agentId: this.sessionAgentId,
        provider: this.sessionProvider,
      });
      return;
    }

    const rawOptions = clientOrOptions ?? {};
    const governance = resolveIflowGovernance(rawOptions, rawOptions.governance);
    const finalOptions: IFlowOptions = {
      ...rawOptions,
      sessionSettings: governance.sessionSettings,
      commands: governance.commands,
    };

    this.client = new IFlowClient(finalOptions);
    this.governedOptions = rawOptions;
    this.injectedCapabilityCommands = governance.injectedCommands;
    this.sessionAgentId = rawOptions.sessionAgentId?.trim() || 'iflow-default';
    this.sessionProvider = rawOptions.sessionProvider?.trim() || 'iflow';
    this.sessionMapStore = new IflowSessionMapStore(rawOptions.sessionMapPath, {
      agentId: this.sessionAgentId,
      provider: this.sessionProvider,
    });
    this.info.sessionAgentId = this.sessionAgentId;
    this.info.sessionProvider = this.sessionProvider;

    if (finalOptions.cwd) this.info.cwd = finalOptions.cwd;
    if (finalOptions.sessionSettings?.add_dirs) {
      this.info.addDirs = [...finalOptions.sessionSettings.add_dirs];
    }
    if (finalOptions.sessionSettings?.allowed_tools) {
      this.info.configuredAllowedTools = [...finalOptions.sessionSettings.allowed_tools];
    }
    if (finalOptions.sessionSettings?.disallowed_tools) {
      this.info.configuredDisallowedTools = [...finalOptions.sessionSettings.disallowed_tools];
    }
    if (this.injectedCapabilityCommands.length > 0) {
      this.info.injectedCommands = this.injectedCapabilityCommands.map((item) => item.commandName);
      this.info.injectedCapabilities = this.injectedCapabilityCommands.map((item) => item.capabilityId);
    }
  }

  /** 初始化连接并创建/加载 session */
  async initialize(skipSession = false): Promise<IflowAgentInfo> {
    await this.client.connect({ skipSession });
    this.info.connected = true;

    // 获取 sessionId
    this.info.sessionId = this.client.getSessionId() || '';
    if (this.governedOptions?.fingerSessionId && this.info.sessionId) {
      this.bindFingerSession(this.governedOptions.fingerSessionId, this.info.sessionId);
      this.info.fingerSessionId = this.governedOptions.fingerSessionId;
    }

    // 通过 client.config.get 获取元信息
    await this.refreshCapabilityInfo();

    return this.getInfo();
  }

  private async refreshCapabilityInfo(): Promise<void> {
    try {
      const commands = await this.client.config.get<NamedConfig[]>('commands');
      this.info.availableCommands = commands?.map((item) => item.name) || [];
    } catch { /* ignore */ }

    try {
      const agents = await this.client.config.get<NamedConfig[]>('agents');
      this.info.availableAgents = agents?.map((item) => item.name) || [];
    } catch { /* ignore */ }

    try {
      const skills = await this.client.config.get<NamedConfig[]>('skills');
      this.info.availableSkills = skills?.map((item) => item.name) || [];
    } catch { /* ignore */ }

    try {
      const mcp = await this.client.config.get<NamedConfig[]>('mcpServers');
      this.info.availableMcpServers = mcp?.map((item) => item.name) || [];
    } catch { /* ignore */ }
  }

  getInfo(): IflowAgentInfo {
    return { ...this.info };
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.info.connected = false;
  }

  getClient(): IFlowClient {
    return this.client;
  }

  getInjectedCapabilityCommands(): InjectedCapabilityCommand[] {
    return [...this.injectedCapabilityCommands];
  }

  getSessionBinding(fingerSessionId: string): IflowSessionBinding | null {
    return this.sessionMapStore.get(fingerSessionId);
  }

  listSessionBindings(): IflowSessionBinding[] {
    return this.sessionMapStore.list();
  }

  removeSessionBinding(fingerSessionId: string): boolean {
    return this.sessionMapStore.remove(fingerSessionId);
  }

  bindFingerSession(fingerSessionId: string, iflowSessionId?: string): {
    fingerSessionId: string;
    agentId: string;
    provider: string;
    iflowSessionId: string;
    updatedAt: string;
  } {
    const sessionId = iflowSessionId ?? this.client.getSessionId();
    if (!sessionId) {
      throw new Error('No iFlow session available to bind');
    }
    this.info.fingerSessionId = fingerSessionId;
    return this.sessionMapStore.set(fingerSessionId, sessionId);
  }

  async useMappedSession(fingerSessionId: string, createIfMissing = true): Promise<string> {
    this.ensureConnected();

    const binding = this.sessionMapStore.get(fingerSessionId);
    if (binding) {
      try {
        await this.client.loadSession(binding.iflowSessionId);
        this.info.sessionId = binding.iflowSessionId;
        this.info.fingerSessionId = fingerSessionId;
        return binding.iflowSessionId;
      } catch {
        if (!createIfMissing) {
          throw new Error(`Mapped iFlow session not found: ${binding.iflowSessionId}`);
        }
      }
    }

    const newSessionId = await this.client.newSession();
    this.info.sessionId = newSessionId;
    this.info.fingerSessionId = fingerSessionId;
    this.sessionMapStore.set(fingerSessionId, newSessionId);
    return newSessionId;
  }

  async loadSession(sessionId: string): Promise<void> {
    this.ensureConnected();
    await this.client.loadSession(sessionId);
    this.info.sessionId = sessionId;
  }

  async createNewSession(): Promise<string> {
    this.ensureConnected();
    const sessionId = await this.client.newSession();
    this.info.sessionId = sessionId;
    return sessionId;
  }

  async getCommandCatalog(): Promise<CommandInfo[]> {
    return this.client.config.get<CommandInfo[]>('commands');
  }

  async getSkillCatalog(): Promise<SkillInfo[]> {
    return this.client.config.get<SkillInfo[]>('skills');
  }

  async getMcpCatalog(): Promise<McpServerInfo[]> {
    return this.client.config.get<McpServerInfo[]>('mcpServers');
  }

  async getModels(): Promise<Array<{
    id: string;
    name?: string;
    description?: string;
    capabilities?: { thinking?: boolean; image?: boolean; audio?: boolean; video?: boolean };
  }>> {
    const models = await this.client.config.get<{
      availableModels?: Array<{
        id: string;
        name?: string;
        description?: string;
        capabilities?: { thinking?: boolean; image?: boolean; audio?: boolean; video?: boolean };
      }>;
    }>('models');
    return models?.availableModels ?? [];
  }

  async setModel(modelId: string): Promise<void> {
    await this.client.config.set('model', modelId);
  }

  private ensureConnected(): void {
    if (!this.client.isConnected()) {
      throw new Error('iFlow client is not connected. Please initialize first.');
    }
  }
}
