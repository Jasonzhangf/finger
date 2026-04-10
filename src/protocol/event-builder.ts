/**
 * EventBuilder - 统一事件构建工具
 *
 * 职责：
 * 1. 确保所有必填字段存在（schemaVersion, eventId, type, actor, timestamp, correlationId, causationId, ownerWorkerId）
 * 2. 自动生成 eventId, timestamp
 * 3. 支持链式调用
 * 4. 类型安全
 *
 * @see Docs/operation-event-communication-architecture.md
 */

import type { AgentPath } from './operation-types.js';
import { AgentPathUtils } from './operation-types.js';
import type {
  Event,
  EventType,
  EventSchemaVersion,
  EventPayload,
  DispatchStatus,
  DispatchClosureGate,
} from './event-types.js';

export interface EventBuildContext {
  /** 默认 actor（发生者路径） */
  defaultActor?: AgentPath;
  /** 默认 ownerWorkerId */
  defaultOwnerWorkerId?: string;
  /** 默认 correlationId 来源（如 dispatchId） */
  defaultCorrelationIdSource?: () => string;
}

/**
 * 事件构建器
 *
 * 使用示例：
 * ```ts
 * const event = new EventBuilder()
 *   .withType('agent_dispatch_started')
 *   .withActor('/root/finger-project-agent')
 *   .withOwnerWorkerId('worker-123')
 *   .withPayload({ dispatchId: 'xxx', ... })
 *   .build();
 * ```
 */
export class EventBuilder {
  private schemaVersion: EventSchemaVersion = 'v1';
  private eventId: string = '';
  private type: EventType | null = null;
  private actor: AgentPath | null = null;
  private timestamp: string = '';
  private correlationId: string = '';
  private causationId: string = '';
  private ownerWorkerId: string = '';
  private payload: EventPayload | null = null;
  private relatedOpId?: string;
  private traceId?: string;

  private context?: EventBuildContext;

  constructor(context?: EventBuildContext) {
    this.context = context;
    this.eventId = this.generateEventId();
    this.timestamp = new Date().toISOString();
  }

  /**
   * 设置事件类型
   */
  withType(type: EventType): this {
    this.type = type;
    return this;
  }

  /**
   * 设置发生者路径
   */
  withActor(actor: AgentPath | string): this {
    const path = typeof actor === 'string' ? actor as AgentPath : actor;
    if (!AgentPathUtils.isValid(path)) {
      throw new Error(`Invalid AgentPath: ${path}. Must start with /root and use only lowercase letters, digits, underscores, and hyphens.`);
    }
    this.actor = path;
    return this;
  }

  /**
   * 设置关联 ID（用于请求链路追踪）
   */
  withCorrelationId(correlationId: string): this {
    this.correlationId = correlationId;
    return this;
  }

  /**
   * 设置因果 ID（触发本事件的上游事件或操作）
   */
  withCausationId(causationId: string): this {
    this.causationId = causationId;
    return this;
  }

  /**
   * 设置所属 worker
   */
  withOwnerWorkerId(ownerWorkerId: string): this {
    this.ownerWorkerId = ownerWorkerId;
    return this;
  }

  /**
   * 设置事件 payload
   */
  withPayload(payload: EventPayload): this {
    this.payload = payload;
    return this;
  }

  /**
   * 设置关联的 Operation ID
   */
  withRelatedOpId(opId: string): this {
    this.relatedOpId = opId;
    return this;
  }

  /**
   * 设置追踪 ID
   */
  withTraceId(traceId: string): this {
    this.traceId = traceId;
    return this;
  }

  /**
   * 从 dispatchId 自动设置 correlationId 和 causationId
   */
  fromDispatch(dispatchId: string): this {
    this.correlationId = dispatchId;
    this.causationId = dispatchId;
    return this;
  }

  /**
   * 构建 Event
   */
  build(): Event {
    if (!this.type) {
      throw new Error('Event type is required');
    }
    if (!this.actor) {
      // 使用 context 默认值或抛出错误
      if (this.context?.defaultActor) {
        this.actor = this.context.defaultActor;
      } else {
        throw new Error('Event actor is required');
      }
    }
    if (!this.correlationId) {
      if (this.context?.defaultCorrelationIdSource) {
        this.correlationId = this.context.defaultCorrelationIdSource();
      } else {
        this.correlationId = this.eventId;
      }
    }
    if (!this.causationId) {
      this.causationId = this.correlationId;
    }
    if (!this.ownerWorkerId) {
      if (this.context?.defaultOwnerWorkerId) {
        this.ownerWorkerId = this.context.defaultOwnerWorkerId;
      } else {
        this.ownerWorkerId = 'unknown';
      }
    }
    if (!this.payload) {
      throw new Error('Event payload is required');
    }

    const event: Event = {
      schemaVersion: this.schemaVersion,
      eventId: this.eventId,
      type: this.type,
      actor: this.actor,
      timestamp: this.timestamp,
      correlationId: this.correlationId,
      causationId: this.causationId,
      ownerWorkerId: this.ownerWorkerId,
      payload: this.payload,
    };

    if (this.relatedOpId) {
      event.relatedOpId = this.relatedOpId;
    }
    if (this.traceId) {
      event.traceId = this.traceId;
    }

    return event;
  }

  private generateEventId(): string {
    return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * 工厂函数：快速创建 dispatch 事件
 */
export function createDispatchEvent(
  type: 'agent_dispatch_queued' | 'agent_dispatch_started' | 'agent_dispatch_complete' | 'agent_dispatch_failed' | 'agent_dispatch_partial',
  params: {
    dispatchId: string;
    actor: AgentPath | string;
    ownerWorkerId: string;
    sourceAgentId: string;
    targetAgentId: string;
    status: DispatchStatus;
    sessionId?: string;
    workflowId?: string;
    queuePosition?: number;
    error?: string;
    result?: unknown;
    closureGate?: DispatchClosureGate;
    traceId?: string;
  },
): Event {
  const builder = new EventBuilder()
    .withType(type)
    .withActor(params.actor)
    .withOwnerWorkerId(params.ownerWorkerId)
    .fromDispatch(params.dispatchId);

  if (params.traceId) {
    builder.withTraceId(params.traceId);
  }

  const payload: Record<string, unknown> = {
    dispatchId: params.dispatchId,
    sourceAgentId: params.sourceAgentId,
    targetAgentId: params.targetAgentId,
    status: params.status,
    sessionId: params.sessionId,
    workflowId: params.workflowId,
  };

  if (params.queuePosition !== undefined) {
    payload.queuePosition = params.queuePosition;
  }
  if (params.error) {
    payload.error = params.error;
  }
  if (params.result !== undefined) {
    payload.result = params.result;
  }
  if (params.closureGate) {
    payload.closureGate = params.closureGate;
  }

  builder.withPayload(payload as unknown as EventPayload);
  return builder.build();
}
