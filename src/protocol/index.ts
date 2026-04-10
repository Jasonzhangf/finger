/**
 * Protocol Index - Operation/Event 通信架构协议入口（唯一真源）
 *
 * 统一导出所有协议层类型，业务模块统一从此处导入。
 *
 * @see Docs/operation-event-communication-architecture.md
 */

// ─── Operation 层 ───────────────────────────────────────────────

export {
  AgentPath,
  AgentPathUtils,
  Operation,
  OperationIntent,
  OperationPayload,
  OperationPayloadMap,
  ControlCommandType,
  OperationUtils,
  DispatchTaskPayload,
  InterruptPayload,
  QueryStatusPayload,
  UpdateConfigPayload,
  InterAgentMessagePayload,
  ControlCommandPayload,
  UserInputPayload,
} from './operation-types.js';

// ─── Event 层 ────────────────────────────────────────────────────

export {
  Event,
  EventSchemaVersion,
  EventType,
  EventGroup,
  EventPayload,
  EventPayloadMap,
  DispatchStatus,
  DispatchClosureGate,
  EventUtils,
  // Payloads
  TurnStartedPayload,
  TurnCompletePayload,
  TurnAbortedPayload,
  TurnFailedPayload,
  AgentStatusChangedPayload,
  AgentDispatchQueuedPayload,
  AgentDispatchStartedPayload,
  AgentDispatchCompletePayload,
  AgentDispatchFailedPayload,
  AgentDispatchPartialPayload,
  ToolCallBeginPayload,
  ToolCallEndPayload,
  ToolCallFailedPayload,
  ExecCommandBeginPayload,
  ExecCommandOutputPayload,
  ExecCommandEndPayload,
  SessionCreatedPayload,
  SessionSwitchedPayload,
  SessionCompactedPayload,
  WorkflowStartedPayload,
  WorkflowCompletePayload,
  ProgressUpdatePayload,
  ReasoningDeltaPayload,
  MessageDeltaPayload,
  ReviewStartedPayload,
  ReviewCompletePayload,
  ReviewBlockedPayload,
} from './event-types.js';

// ─── Session Source 标签 ────────────────────────────────────────

export {
  SessionSource,
  SessionSourceType,
  SubAgentSourceType,
  SessionSourceUtils,
  LegacySessionMigration,
} from './session-source-types.js';

// ─── Event Builder ──────────────────────────────────────────────

export {
  EventBuilder,
  EventBuildContext,
  createDispatchEvent,
} from './event-builder.js';
