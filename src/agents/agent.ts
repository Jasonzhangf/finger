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
  resumeSession?: boolean;
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
  sessionId?: string;
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
    this.base = new IflowBaseAgent(this.client);
    this.interactive = new IflowInteractiveAgent(this.client);

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
    // resumeSession: true (default) -> skipSession = false (reuse session)
    // resumeSession: false -> skipSession = true (new session)
    const skipSession = this.config.resumeSession === false;
    const info = await this.base.initialize(skipSession);

    // When skipSession=true, SDK connects without creating/loading session.
    // Agent execution requires an active session, so create one explicitly.
    if (skipSession) {
      const sessionId = await this.client.newSession();
      info.sessionId = sessionId;
    }

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

  /** 创建全新会话，清理历史上下文但保持连接 */
  async startFreshSession(): Promise<string> {
    await this.ensureConnected();
    const sessionId = await this.client.newSession();
    this.status.connected = true;
    this.status.sessionId = sessionId;
    return sessionId;
  }

  private async ensureConnected(): Promise<void> {
   // Check actual connection state from client
   const isActuallyConnected = this.client.isConnected?.() ?? false;
   if (isActuallyConnected) {
     this.status.connected = true;
     return;
   }
   
   // 重连前先重置状态，避免 client.isConnected() 返回过时的 true。
   this.status.connected = false;
   console.log(`[Agent ${this.config.id}] Not connected (client.isConnected=${isActuallyConnected}), initializing...`);
   await this.initialize();
  }

  private isConnectionError(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes('not connected') || normalized.includes('call connect() first');
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
      await this.ensureConnected();

      const runAuto = async () => this.interactive.interact(
        task,
        {
          ...callbacks,
          onPlan: callbacks?.onPlan ?? (async () => true),
          onPermission: callbacks?.onPermission ?? (async () => 'allow'),
        },
        files
      );

      const runManual = async () => this.interactive.interact(task, callbacks, files);

      if (this.config.mode === 'auto') {
        let result;
        try {
          result = await runAuto();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!this.isConnectionError(message)) {
            throw err;
          }

          this.status.connected = false;
          await this.initialize();
          result = await runAuto();
        }

        return {
          success: true,
          output: result.finalOutput,
          stopReason: result.stopReason,
        };
      }

      if (!callbacks) {
        throw new Error('Manual mode requires callbacks');
      }

      let result;
      try {
        result = await runManual();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!this.isConnectionError(message)) {
          throw err;
        }

        this.status.connected = false;
        await this.initialize();
        result = await runManual();
      }

      return {
        success: true,
        output: result.finalOutput,
        stopReason: result.stopReason,
      };
    } catch (err) {
      this.status.connected = false;
      return {
        success: false,
        output: '',
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.status.running = false;
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
