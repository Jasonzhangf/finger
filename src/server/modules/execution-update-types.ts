export type ExecutionUpdatePhase = 'dispatch' | 'execution' | 'delivery' | 'review' | 'completion';
export type ExecutionUpdateKind = 'reasoning' | 'tool' | 'status' | 'decision' | 'artifact' | 'error';
export type ExecutionUpdateLevel = 'debug' | 'info' | 'milestone' | 'critical';
export type ExecutionUpdateSourceType = 'user' | 'heartbeat' | 'mailbox' | 'cron' | 'system-inject';

export interface ExecutionUpdateArtifact {
  type: 'screenshot' | 'log' | 'file' | 'report';
  path?: string;
  digest?: string;
  summary?: string;
}

export interface ExecutionUpdateEvent {
  id: string;
  ts: string;
  seq: number;
  flowId: string;
  traceId: string;
  taskId?: string;
  sessionId: string;
  sourceAgentId: string;
  targetAgentId?: string;
  sourceType: ExecutionUpdateSourceType;
  deliveryKey?: string;
  parentEventId?: string;
  phase: ExecutionUpdatePhase;
  kind: ExecutionUpdateKind;
  level: ExecutionUpdateLevel;
  finishReason?: 'stop' | 'length' | 'tool_call' | 'error' | string;
  payload: Record<string, unknown>;
  artifacts?: ExecutionUpdateArtifact[];
}

export interface CorrelationFlowRecord {
  flowId: string;
  traceId: string;
  taskId?: string;
  latestSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface CorrelationAppendRecord {
  op: 'upsert';
  ts: string;
  flow: CorrelationFlowRecord;
}

export interface CorrelationBindRecord {
  op: 'bind';
  ts: string;
  sessionId: string;
  agentId: string;
  flowId: string;
}
