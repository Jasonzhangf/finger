import {
  MessageType,
  ToolCallMessage,
  AskUserQuestionsMessage,
  ExitPlanModeMessage,
  PermissionRequestMessage,
  TaskFinishMessage,
  ErrorMessage,
  IFlowClient,
  IFlowOptions,
} from '@iflow-ai/iflow-cli-sdk';

export type InteractionHandler = (chunk: string) => void;
export type ToolCallHandler = (toolCall: ToolCallMessage) => Promise<void>;
export type QuestionHandler = (questions: AskUserQuestionsMessage) => Promise<Record<string, string | string[]>>;
export type PlanHandler = (plan: ExitPlanModeMessage) => Promise<boolean>;
export type PermissionHandler = (req: PermissionRequestMessage) => Promise<string>;

export interface InteractionCallbacks {
  onAssistantChunk?: InteractionHandler;
  onToolCall?: ToolCallHandler;
  onQuestions?: QuestionHandler;
  onPlan?: PlanHandler;
  onPermission?: PermissionHandler;
}

/**
 * 交互接口：进入 ReACT 循环，处理各种消息类型
 */
export class IflowInteractiveAgent {
  private client: IFlowClient;
  private isRunning = false;

  constructor(clientOrOptions?: IFlowClient | IFlowOptions, _options?: IFlowOptions) {
    if (clientOrOptions instanceof IFlowClient) {
      this.client = clientOrOptions;
      return;
    }

    this.client = new IFlowClient(clientOrOptions);
  }

  async initialize(skipSession = false): Promise<void> {
    await this.client.connect({ skipSession });
  }

  async disconnect(): Promise<void> {
    await this.client.disconnect();
  }

  /** 发送用户消息，并进入消息处理循环，直到 task_finish 或主动取消 */
  async interact(
    userMessage: string,
    callbacks: InteractionCallbacks = {},
    files: Array<{ path?: string; image?: string }> = []
  ): Promise<{ stopReason?: string; finalOutput: string }> {
    if (this.isRunning) throw new Error('Agent is already in an interaction loop');
    this.isRunning = true;

    let finalOutput = '';

    try {
      await this.client.sendMessage(userMessage, files as []);

      for await (const msg of this.client.receiveMessages()) {
        switch (msg.type) {
          case MessageType.ASSISTANT:
            if ('chunk' in msg && msg.chunk?.text) {
              finalOutput += msg.chunk.text;
              callbacks.onAssistantChunk?.(msg.chunk.text);
            }
            break;

          case MessageType.TOOL_CALL:
            if (callbacks.onToolCall) {
              await callbacks.onToolCall(msg as ToolCallMessage);
            }
            break;

          case MessageType.ASK_USER_QUESTIONS:
            if (callbacks.onQuestions) {
              const answers = await callbacks.onQuestions(msg as AskUserQuestionsMessage);
              await this.client.respondToAskUserQuestions(answers);
            }
            break;

          case MessageType.EXIT_PLAN_MODE:
            if (callbacks.onPlan) {
              const approved = await callbacks.onPlan(msg as ExitPlanModeMessage);
              await this.client.respondToExitPlanMode(approved);
            }
            break;

          case MessageType.PERMISSION_REQUEST:
            if (callbacks.onPermission) {
              const optionId = await callbacks.onPermission(msg as PermissionRequestMessage);
              await this.client.respondToToolConfirmation((msg as PermissionRequestMessage).requestId, optionId);
            } else {
              await this.client.cancelToolConfirmation((msg as PermissionRequestMessage).requestId);
            }
            break;

          case MessageType.TASK_FINISH:
            this.isRunning = false;
            return { stopReason: (msg as TaskFinishMessage).stopReason, finalOutput };

          case MessageType.ERROR:
            this.isRunning = false;
            throw new Error(`iFlow error: ${(msg as ErrorMessage).message}`);
        }
      }
    } catch (err) {
      this.isRunning = false;
      throw err;
    } finally {
      this.isRunning = false;
    }

    return { finalOutput };
  }

  /** 中断当前任务 */
  async interrupt(): Promise<void> {
    if (this.isRunning) {
      await this.client.interrupt();
      this.isRunning = false;
    }
  }
}
