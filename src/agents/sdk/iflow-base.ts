import { IFlowClient, IFlowOptions } from '@iflow-ai/iflow-cli-sdk';

/**
 * iFlow Agent 基础信息
 */
export interface IflowAgentInfo {
  sessionId: string;
  connected: boolean;
  availableCommands: string[];
  availableAgents: string[];
  availableSkills: string[];
  availableMcpServers: string[];
}

/**
 * 基础接口：只负责连接、session、能力查询，不涉及任务执行
 */
export class IflowBaseAgent {
  private client: IFlowClient;
  private info: IflowAgentInfo = {
    sessionId: '',
    connected: false,
    availableCommands: [],
    availableAgents: [],
    availableSkills: [],
    availableMcpServers: [],
  };

  constructor(options?: IFlowOptions) {
    this.client = new IFlowClient(options);
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
}
