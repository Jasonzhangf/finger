import {
  IFlowClient,
  IFlowOptions,
  Message,
  MessageType,
  ToolCallMessage,
  ToolCallStatus,
  AssistantMessage,
  TaskFinishMessage,
  ErrorMessage,
  PlanMessage,
} from '@iflow-ai/iflow-cli-sdk';

/**
 * iFlow Agent 状态
 */
export interface IFlowAgentState {
  sessionId: string;
  connected: boolean;
  executing: boolean;
  currentTaskId?: string;
  availableCommands: string[];
  availableAgents: string[];
  availableTools: string[];
}

/**
 * 工具调用结果
 */
export interface ToolCallResult {
  toolName: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  output?: string;
  error?: string;
}

/**
 * 任务执行结果
 */
export interface TaskExecutionResult {
  success: boolean;
  taskId: string;
  output: string;
  toolCalls: ToolCallResult[];
  stopReason?: string;
  error?: string;
}

/**
 * iFlow SDK 封装类
 * 提供工具列表、状态查询、任务执行和结果返回的统一接口
 */
export class IFlowSDKWrapper {
  private client: IFlowClient;
  private options: IFlowOptions;
  private state: IFlowAgentState;
  private messageBuffer: Message[] = [];
  private currentTaskResolver?: (result: TaskExecutionResult) => void;
  private currentTaskRejecter?: (error: Error) => void;
  private outputBuffer = '';
  private toolCallsBuffer: ToolCallResult[] = [];

  constructor(options: IFlowOptions = {}) {
    this.options = {
      url: 'http://127.0.0.1:5520',
      autoStartProcess: true,
      permissionMode: 'auto',
      ...options,
    };
    this.client = new IFlowClient(this.options);
    this.state = {
      sessionId: '',
      connected: false,
      executing: false,
      availableCommands: [],
      availableAgents: [],
      availableTools: [],
    };
  }

  /**
   * 初始化连接并创建会话
   */
  async initialize(): Promise<IFlowAgentState> {
    await this.client.connect();
    this.state.connected = true;

    const sessionId = this.client.getSessionId();
    this.state.sessionId = sessionId || '';

    this.startMessageLoop();

    return this.state;
  }

  /**
   * 获取当前状态
   */
  getState(): IFlowAgentState {
    return { ...this.state };
  }

  /**
   * 获取可用工具列表
   */
  getAvailableTools(): string[] {
    return [...this.state.availableTools];
  }

  /**
   * 获取可用命令列表
   */
  getAvailableCommands(): string[] {
    return [...this.state.availableCommands];
  }

  /**
   * 获取可用 Agent 列表
   */
  getAvailableAgents(): string[] {
    return [...this.state.availableAgents];
  }

  /**
   * 执行单个任务
   */
  async executeTask(taskId: string, prompt: string): Promise<TaskExecutionResult> {
    if (this.state.executing) {
      throw new Error('Another task is already executing');
    }

    this.state.executing = true;
    this.state.currentTaskId = taskId;
    this.messageBuffer = [];
    this.outputBuffer = '';
    this.toolCallsBuffer = [];

    const taskPromise = new Promise<TaskExecutionResult>((resolve, reject) => {
      this.currentTaskResolver = resolve;
      this.currentTaskRejecter = reject;
    });

    this.client.sendMessage(prompt).catch((error) => {
      this.state.executing = false;
      if (this.currentTaskRejecter) {
        this.currentTaskRejecter(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return taskPromise;
  }

  /**
   * 启动消息处理循环
   */
  private async startMessageLoop(): Promise<void> {
    try {
      for await (const message of this.client.receiveMessages()) {
        this.messageBuffer.push(message);
        this.processMessage(message);
      }
    } catch (error) {
      if (this.currentTaskRejecter) {
        this.currentTaskRejecter(error as Error);
      }
    }
  }

  /**
   * 处理单个消息
   */
  private processMessage(message: Message): void {
    switch (message.type) {
      case MessageType.ASSISTANT:
        this.handleAssistantMessage(message as AssistantMessage);
        break;

      case MessageType.TOOL_CALL:
        this.handleToolCallMessage(message as ToolCallMessage);
        break;

      case MessageType.TASK_FINISH:
        this.handleTaskFinish(message as TaskFinishMessage);
        break;

      case MessageType.ERROR:
        this.handleErrorMessage(message as ErrorMessage);
        break;

      case MessageType.PLAN:
        this.handlePlanMessage(message as PlanMessage);
        break;
    }
  }

  /**
   * 处理助手消息
   */
  private handleAssistantMessage(message: AssistantMessage): void {
    if (message.chunk?.text) {
      this.outputBuffer += message.chunk.text;
    }
  }

  /**
   * 处理工具调用消息
   */
  private handleToolCallMessage(message: ToolCallMessage): void {
    const toolCall: ToolCallResult = {
      toolName: message.toolName || message.label,
      status: this.mapToolCallStatus(message.status),
      output: message.output,
    };
    this.toolCallsBuffer.push(toolCall);
  }

  /**
   * 映射工具调用状态
   */
  private mapToolCallStatus(status: string): ToolCallResult['status'] {
    switch (status) {
      case ToolCallStatus.PENDING:
        return 'pending';
      case ToolCallStatus.IN_PROGRESS:
        return 'in_progress';
      case ToolCallStatus.COMPLETED:
        return 'completed';
      case ToolCallStatus.FAILED:
        return 'failed';
      default:
        return 'pending';
    }
  }

  /**
   * 处理任务完成消息
   */
  private handleTaskFinish(message: TaskFinishMessage): void {
    this.state.executing = false;
    const taskId = this.state.currentTaskId;
    this.state.currentTaskId = undefined;

    if (this.currentTaskResolver) {
      this.currentTaskResolver({
        success: true,
        taskId: taskId || 'unknown',
        output: this.outputBuffer,
        toolCalls: this.toolCallsBuffer,
        stopReason: message.stopReason,
      });
    }
  }

  /**
   * 处理错误消息
   */
  private handleErrorMessage(message: ErrorMessage): void {
    this.state.executing = false;

    if (this.currentTaskRejecter) {
      this.currentTaskRejecter(new Error(message.message));
    }
  }

  /**
   * 处理计划消息
   */
  private handlePlanMessage(message: PlanMessage): void {
    if (message.entries) {
      message.entries.forEach(entry => {
        if (entry.content && !this.state.availableTools.includes(entry.content)) {
          this.state.availableTools.push(entry.content);
        }
      });
    }
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    await this.client.disconnect();
    this.state.connected = false;
  }
}
