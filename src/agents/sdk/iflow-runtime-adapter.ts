/**
 * IflowRuntimeAdapter - iflow SDK 事件适配器
 * 将 iflow SDK 消息转换为统一事件
 */

import {
  MessageType,
  type ToolCallMessage,
  type AskUserQuestionsMessage,
  type ExitPlanModeMessage,
  type PermissionRequestMessage,
  type TaskFinishMessage,
  type ErrorMessage,
  type IFlowClient,
} from '@iflow-ai/iflow-cli-sdk';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { RuntimeEvent } from '../../runtime/events.js';

// iflow SDK 消息类型 (使用 SDK 的 Message 联合类型)
import type { Message } from '@iflow-ai/iflow-cli-sdk';
type IflowMessage = Message;

export interface AdapterOptions {
  agentId: string;
  sessionId?: string;
}

export class IflowRuntimeAdapter {
  private currentMessageId: string | null = null;
  private accumulatedContent: string = '';

  constructor(
    private client: IFlowClient,
    private eventBus: UnifiedEventBus,
    private options: AdapterOptions,
  ) {}

  /**
   * 包装 iflow 消息循环，自动发布统一事件
   */
  async *receiveMessagesWithEvents(): AsyncGenerator<IflowMessage> {
    for await (const msg of this.client.receiveMessages()) {
      // 转换并发布统一事件
      const event = this.convertToEvent(msg);
      if (event) {
        this.eventBus.emit(event);
      }

      yield msg;
    }
  }

  /**
   * 将 iflow 消息转换为统一事件
   */
  private convertToEvent(msg: IflowMessage): RuntimeEvent | null {
    const timestamp = new Date().toISOString();
    const sessionId = this.options.sessionId || this.client.getSessionId() || 'default';
    const agentId = this.options.agentId;

    switch (msg.type) {
      case MessageType.ASSISTANT: {
        const assistantMsg = msg as { chunk?: { text?: string }; id?: string };
        const content = assistantMsg.chunk?.text || '';

        // 追踪消息 ID 和累积内容
        if (this.currentMessageId !== assistantMsg.id) {
          if (this.currentMessageId && this.accumulatedContent) {
            // 发送上一条消息的完成事件
            const completeEvent: RuntimeEvent = {
              type: 'assistant_complete',
              sessionId,
              agentId,
              timestamp,
              payload: {
                messageId: this.currentMessageId,
                content: this.accumulatedContent,
              },
            };
            this.eventBus.emit(completeEvent);
          }
          this.currentMessageId = assistantMsg.id || `msg-${Date.now()}`;
          this.accumulatedContent = '';
        }

        this.accumulatedContent += content;

        return {
          type: 'assistant_chunk',
          sessionId,
          agentId,
          timestamp,
          payload: {
            messageId: this.currentMessageId,
            content,
          },
        };
      }

      case MessageType.TOOL_CALL: {
        const toolMsg = msg as ToolCallMessage & { toolCallId?: string; args?: unknown };
        return {
          type: 'tool_call',
          toolId: toolMsg.toolCallId || `tool-${Date.now()}`,
          toolName: (toolMsg as unknown as { toolName?: string }).toolName || 'unknown',
          agentId,
          sessionId,
          timestamp,
          payload: {
            input: toolMsg.args,
          },
        };
      }

      case MessageType.TASK_FINISH: {
        const finishMsg = msg as TaskFinishMessage & { output?: unknown };

        // 发送累积内容的完成事件
        if (this.currentMessageId && this.accumulatedContent) {
          const completeEvent: RuntimeEvent = {
            type: 'assistant_complete',
            sessionId,
            agentId,
            timestamp,
          payload: {
            messageId: this.currentMessageId,
            content: this.accumulatedContent,
            stopReason: (finishMsg as unknown as { stopReason?: string }).stopReason,
          },
          };
          this.eventBus.emit(completeEvent);
          this.accumulatedContent = '';
          this.currentMessageId = null;
        }

        return {
          type: 'task_completed',
          taskId: sessionId,
          sessionId,
          agentId,
          timestamp,
          payload: {
            result: finishMsg.output,
          },
        };
      }

      case MessageType.ERROR: {
        const errorMsg = msg as ErrorMessage;
        return {
          type: 'task_failed',
          taskId: sessionId,
          sessionId,
          agentId,
          timestamp,
          payload: {
            error: errorMsg.message || 'Unknown error',
          },
        };
      }

      // 其他消息类型暂不转换，返回 null
      default:
        return null;
    }
  }

  /**
   * 手动发送任务进度事件
   */
  emitTaskProgress(taskId: string, progress: number, message?: string): void {
    const sessionId = this.options.sessionId || this.client.getSessionId() || 'default';
    this.eventBus.emit({
      type: 'task_progress',
      sessionId,
      taskId,
      agentId: this.options.agentId,
      timestamp: new Date().toISOString(),
      payload: { progress, message },
    });
  }

  /**
   * 手动发送工作流进度事件
   */
  emitWorkflowProgress(progress: {
    overall: number;
    activeAgents: string[];
    pending: number;
    completed: number;
    failed: number;
  }): void {
    const sessionId = this.options.sessionId || this.client.getSessionId() || 'default';
    this.eventBus.emit({
      type: 'workflow_progress',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: {
        overallProgress: progress.overall,
        activeAgents: progress.activeAgents,
        pendingTasks: progress.pending,
        completedTasks: progress.completed,
        failedTasks: progress.failed,
      },
    });
  }

  /**
   * 重置适配器状态
   */
  reset(): void {
    this.currentMessageId = null;
    this.accumulatedContent = '';
  }
}
