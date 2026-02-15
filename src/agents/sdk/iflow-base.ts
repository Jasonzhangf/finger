import { IFlowClient, IFlowOptions } from '@iflow-ai/iflow-cli-sdk';

/**
 * iFlow Agent 基础信息
 */
export interface IflowAgentInfo {
  sessionId: string;
  connected: boolean;
  cwd: string;
  addDirs: string[];
  availableCommands: string[];
  availableAgents: string[];
  availableSkills: string[];
  availableMcpServers: string[];
}

/**
 * 基础接口：只负责连接、session、能力查询，不涉及任务执行
 */
export class IflowBaseAgent {
  protected client: IFlowClient;
  protected info: IflowAgentInfo = {
    sessionId: '',
    connected: false,
    cwd: '',
    addDirs: [],
    availableCommands: [],
    availableAgents: [],
    availableSkills: [],
    availableMcpServers: [],
  };

  constructor(clientOrOptions?: IFlowClient | IFlowOptions) {
    if (clientOrOptions instanceof IFlowClient) {
      this.client = clientOrOptions;
      return;
    }

    this.client = new IFlowClient(clientOrOptions);
    if (clientOrOptions?.cwd) this.info.cwd = clientOrOptions.cwd;
    if (clientOrOptions?.sessionSettings?.add_dirs) {
      this.info.addDirs = [...clientOrOptions.sessionSettings.add_dirs];
    }
  }

  /** 初始化连接并创建/加载 session */
  async initialize(skipSession = false): Promise<IflowAgentInfo> {
    await this.client.connect({ skipSession });
    this.info.connected = true;

    // 获取 sessionId
    this.info.sessionId = this.client.getSessionId() || '';

    // 通过 client.config.get 获取元信息
    try {
      const commands = await this.client.config.get<{ name: string }[]>('commands');
      this.info.availableCommands = commands?.map(c => c.name) || [];
    } catch { /* ignore */ }

    try {
      const agents = await this.client.config.get<{ name: string }[]>('agents');
      this.info.availableAgents = agents?.map(a => a.name) || [];
    } catch { /* ignore */ }

    try {
      const skills = await this.client.config.get<{ name: string }[]>('skills');
      this.info.availableSkills = skills?.map(s => s.name) || [];
    } catch { /* ignore */ }

    try {
      const mcp = await this.client.config.get<{ name: string }[]>('mcpServers');
      this.info.availableMcpServers = mcp?.map(m => m.name) || [];
    } catch { /* ignore */ }

    return this.info;
  }

  getInfo(): IflowAgentInfo {
    return { ...this.info };
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.info.connected = false;
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
}
