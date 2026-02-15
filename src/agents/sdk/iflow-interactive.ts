import { IflowBaseAgent } from './iflow-base.js';
import {
  MessageType,
  ToolCallMessage,
  AskUserQuestionsMessage,
  ExitPlanModeMessage,
  PermissionRequestMessage,
  TaskFinishMessage,
  ErrorMessage,
} from '@iflow-ai/iflow-cli-sdk';

export type InteractionHandler = (chunk: string) => void;
export type ToolCallHandler = (toolCall: ToolCallMessage) => Promise<void>;
export type QuestionHandler = (questions: AskUserQuestionsMessage) => Promise<Record<string, string | string[]>>;
export type PlanHandler = (plan: ExitPlanModeMessage) => Promise<boolean>; // 返回 true 表示批准
export type PermissionHandler = (req: PermissionRequestMessage) => Promise<string>; // 返回 optionId

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
export class IflowInteractiveAgent extends IflowBaseAgent {
  private isRunning = false;
  private currentTaskId: string | null = null;

  /** 发送用户消息，并进入消息处理循环，直到 task_finish 或主动取消 */
  async interact(
    userMessage: string,
    callbacks: InteractionCallbacks = {},
    files: any[] = []
  ): Promise<{ stopReason?: string; finalOutput: string }> {
    if (this.isRunning) throw new Error('Agent is already in an interaction loop');
    this.isRunning = true;

    let finalOutput = '';

    try {
      // 发送用户消息
      await (this as any).client.sendMessage(userMessage, files);

      // 循环接收消息
      for await (const msg of (this as any).client.receiveMessages()) {
        switch (msg.type) {
          case MessageType.ASSISTANT:
            if ((msg as any).chunk?.text) {
              finalOutput += (msg as any).chunk.text;
              callbacks.onAssistantChunk?.((msg as any).chunk.text);
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
              // SDK 内部自动处理 requestId, 不需要传入
              await (this as any).client.respondToAskUserQuestions(answers);
            }
            break;

          case MessageType.EXIT_PLAN_MODE:
            if (callbacks.onPlan) {
              const approved = await callbacks.onPlan(msg as ExitPlanModeMessage);
              // SDK 内部自动处理 requestId
              await (this as any).client.respondToExitPlanMode(approved);
            }
            break;

          case MessageType.PERMISSION_REQUEST:
            if (callbacks.onPermission) {
              const optionId = await callbacks.onPermission(msg as PermissionRequestMessage);
              // SDK 内部自动处理 requestId
              await (this as any).client.respondToToolConfirmation(optionId);
            } else {
              // 默认取消, SDK 内部处理
              await (this as any).client.cancelToolConfirmation();
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
      await (this as any).client.interrupt();
      this.isRunning = false;
    }
  }
}
