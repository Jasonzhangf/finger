import { IflowBaseAgent } from './iflow-base.js';
import {
  IFlowClient,
  MessageType,
  ToolCallMessage,
  AskUserQuestionsMessage,
  ExitPlanModeMessage,
  PermissionRequestMessage,
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
            if (msg.chunk?.text) {
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
              await (this as any).client.respondToAskUserQuestions((msg as AskUserQuestionsMessage).requestId, answers);
            }
            break;

          case MessageType.EXIT_PLAN_MODE:
            if (callbacks.onPlan) {
              const approved = await callbacks.onPlan(msg as ExitPlanModeMessage);
              await (this as any).client.respondToExitPlanMode((msg as ExitPlanModeMessage).requestId, approved);
            }
            break;

          case MessageType.PERMISSION_REQUEST:
            if (callbacks.onPermission) {
              const optionId = await callbacks.onPermission(msg as PermissionRequestMessage);
              await (this as any).client.respondToToolConfirmation((msg as PermissionRequestMessage).requestId, optionId);
            } else {
              // 默认取消
              await (this as any).client.cancelToolConfirmation((msg as PermissionRequestMessage).requestId);
            }
            break;

          case MessageType.TASK_FINISH:
            this.isRunning = false;
            return { stopReason: msg.stopReason, finalOutput };

          case MessageType.ERROR:
            this.isRunning = false;
            throw new Error(`iFlow error: ${msg.message}`);
        }
      }
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
