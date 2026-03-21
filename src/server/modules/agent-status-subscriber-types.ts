import type { ChannelBridgeEnvelope } from '../../bridges/envelope.js';

export type SubscriptionLevel = 'detailed' | 'summary';

export interface AgentSubscriptionConfig {
  agentId: string;
  level: SubscriptionLevel;
  parentAgentId?: string;
}

export interface SessionEnvelopeMapping {
  sessionId: string;
  envelope: {
    channel: string;
    envelopeId: string;
    userId?: string;
    groupId?: string;
  };
  timestamp: number;
}

export interface TaskContext {
  taskId?: string;
  taskDescription?: string;
  sourceAgentId?: string;
  targetAgentId?: string;
}

export interface AgentInfo {
  agentId: string;
  agentName?: string;
  agentRole?: 'orchestrator' | 'executor' | 'reviewer' | 'searcher';
}

export interface WrappedStatusUpdate {
  type: 'agent_status';
  eventId: string;
  timestamp: string;
  sessionId: string;
  conversationId?: string;
  task: TaskContext;
  agent: AgentInfo;
  status: {
    state: 'running' | 'completed' | 'failed' | 'paused' | 'waiting';
    progress?: number;
    summary: string;
    details?: Record<string, unknown>;
  };
  display: {
    title: string;
    subtitle?: string;
    icon?: string;
    level: SubscriptionLevel;
  };
}

export const KEY_STATE_CHANGES = ['completed', 'failed', 'paused', 'waiting'];

export type { ChannelBridgeEnvelope };
