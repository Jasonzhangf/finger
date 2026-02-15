import { IflowBaseAgent } from './sdk/iflow-base.js';
import { IflowInteractiveAgent } from './sdk/iflow-interactive.js';
import { IFlowClient, type IFlowOptions } from '@iflow-ai/iflow-cli-sdk';
import type { InteractionCallbacks } from './sdk/iflow-interactive.js';

export type AgentMode = 'auto' | 'manual';

export interface AgentConfig {
  id: string;
  name: string;
  mode: AgentMode;
  provider: 'iflow';
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: 'default' | 'autoEdit' | 'yolo' | 'plan';
  maxTurns?: number;
  cwd?: string;
  addDirs?: string[];
}

export interface AgentStatus {
  id: string;
  name: string;
  mode: AgentMode;
  connected: boolean;
  sessionId: string;
  capabilities: string[];
  running: boolean;
}

export interface TaskResult {
  success: boolean;
  output: string;
  stopReason?: string;
  error?: string;
}

/**
 * 通用 Agent - 整合基础模式和交互模式
 * 自动模式：直接返回结果
 * 手动模式：提供回调接口供外部控制
 */
export class Agent {
  private base: IflowBaseAgent;
  private interactive: IflowInteractiveAgent;
  private client: IFlowClient;
  private config: AgentConfig;
  private status: AgentStatus;

  constructor(config: AgentConfig, client?: IFlowClient) {
    this.config = config;

    const options: IFlowOptions = {
      autoStartProcess: true,
      cwd: config.cwd,
      sessionSettings: {
        system_prompt: config.systemPrompt,
        allowed_tools: config.allowedTools,
        disallowed_tools: config.disallowedTools,
        permission_mode: config.permissionMode,
        max_turns: config.maxTurns,
        add_dirs: config.addDirs,
      },
    };

    this.client = client ?? new IFlowClient(options);
    this.base = new IflowBaseAgent(options);
    this.interactive = new IflowInteractiveAgent(this.client, options);

    this.status = {
      id: config.id,
      name: config.name,
      mode: config.mode,
      connected: false,
      sessionId: '',
      capabilities: [],
      running: false,
    };
  }

  /** 初始化 Agent */
  async initialize(): Promise<AgentStatus> {
    const info = await this.base.initialize();
    this.status.connected = info.connected;
    this.status.sessionId = info.sessionId;
    this.status.capabilities = [
      ...info.availableCommands,
      ...info.availableAgents,
      ...info.availableSkills,
      ...info.availableMcpServers,
    ];
    return { ...this.status };
  }

  /** 获取当前状态 */
  getStatus(): AgentStatus {
    return { ...this.status };
  }

  /**
   * 执行任务
   * - auto 模式：直接返回结果
   * - manual 模式：通过 callbacks 控制交互
   */
  async execute(
    task: string,
    callbacks?: InteractionCallbacks,
    files?: Array<{ path?: string; image?: string }>
  ): Promise<TaskResult> {
    if (this.status.running) {
      return { success: false, output: '', error: 'Agent is already running a task' };
    }

    this.status.running = true;

    try {
      if (this.config.mode === 'auto') {
        const result = await this.interactive.interact(
          task,
          {
            ...callbacks,
            onPlan: callbacks?.onPlan ?? (async () => true),
            onPermission: callbacks?.onPermission ?? (async () => 'allow'),
          },
          files
        );

        this.status.running = false;
        return {
          success: true,
          output: result.finalOutput,
          stopReason: result.stopReason,
        };
      }

      if (!callbacks) {
        throw new Error('Manual mode requires callbacks');
      }

      const result = await this.interactive.interact(task, callbacks, files);

      this.status.running = false;
      return {
        success: true,
        output: result.finalOutput,
        stopReason: result.stopReason,
      };
    } catch (err) {
      this.status.running = false;
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** 中断当前任务 */
  async interrupt(): Promise<void> {
    await this.interactive.interrupt();
    this.status.running = false;
  }

  /** 断开连接 */
  async disconnect(): Promise<void> {
    await this.base.disconnect();
    this.status.connected = false;
  }
}

/** 创建 Agent 工厂函数 */
export function createAgent(config: AgentConfig, client?: IFlowClient): Agent {
  return new Agent(config, client);
}
