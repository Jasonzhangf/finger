/**
 * Heartbeat State Control Tools - Agent-driven heartbeat state management
 */

import type { InternalTool, ToolExecutionContext } from './types.js';
import { logger } from '../../core/logger.js';
import { heartbeatMailbox } from '../../server/modules/heartbeat-mailbox.js';

const log = logger.module('HeartbeatStateTool');
const DEFAULT_MAILBOX_AGENT_ID = 'finger-system-agent';

function asRecord(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null
    ? params as Record<string, unknown>
    : {};
}

function pickStringParam(payload: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function pickNumberParam(payload: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function pickBooleanParam(payload: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'boolean') {
      return value;
    }
  }
  return undefined;
}

/**
 * heartbeat.state - Get current heartbeat scheduler state (RUNNING/DEGRADED/PAUSED/STOPPED)
 */
export const heartbeatStateTool: InternalTool = {
  name: 'heartbeat.state',
  executionModel: 'state',
  description: 'Get current heartbeat scheduler state (RUNNING/DEGRADED/PAUSED/STOPPED) and mailbox health. Use to check system status before making decisions.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    // 动态导入避免循环依赖（server/index.ts -> default-tools -> internal/index -> heartbeat-state-tool -> server/index）
    const { heartbeatScheduler } = await import('../../server/index.js');
    
    const state = heartbeatScheduler.getState();
    const stateContext = heartbeatScheduler.getStateContext();
    
    // 使用 list() 计算系统 mailbox 健康（finger-system-agent + finger-project-agent）
    const systemMessages = heartbeatMailbox.list('finger-system-agent');
    const projectMessages = heartbeatMailbox.list('finger-project-agent');
    const now = Date.now();
    
    const calcHealth = (messages: typeof systemMessages) => {
      const pending = messages.filter(m => m.status === 'pending');
      const processing = messages.filter(m => m.status === 'processing');
      const oldestPending = pending.length > 0 ? pending.reduce((a, b) => 
        (new Date(a.createdAt || 0).getTime() < new Date(b.createdAt || 0).getTime()) ? a : b) : null;
      return {
        pending: pending.length,
        processing: processing.length,
        oldestPendingAgeMs: oldestPending ? now - new Date(oldestPending.createdAt || 0).getTime() : undefined,
      };
    };
    
    const mailboxHealth = {
      systemAgent: calcHealth(systemMessages),
      projectAgent: calcHealth(projectMessages),
    };
    
    return {
      success: true,
      data: {
        state,
        stateContext,
        mailboxHealth,
        timestamp: new Date().toISOString(),
      },
      message: `Heartbeat state: ${state}`,
    };
  },
};

/**
 * heartbeat.stop - Stop heartbeat scheduler (transition to PAUSED/STOPPED)
 */
export const heartbeatStopTool: InternalTool = {
  name: 'heartbeat.stop',
  executionModel: 'state',
  description: 'Stop heartbeat scheduler. Use when mailbox is overwhelmed or system needs maintenance. Agent-driven decision.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Reason for stopping heartbeat (required)',
      },
      permanent: {
        type: 'boolean',
        description: 'If true, transition to STOPPED (requires manual resume). If false, transition to PAUSED (can auto-resume).',
        default: false,
      },
      resume_after_minutes: {
        type: 'number',
        description: 'Optional: auto-resume after N minutes (only for non-permanent stop)',
      },
    },
    required: ['reason'],
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    // 动态导入避免循环依赖
    const { heartbeatScheduler } = await import('../../server/index.js');
    const payload = asRecord(params);
    const reason = pickStringParam(payload, 'reason');
    const permanent = pickBooleanParam(payload, 'permanent') ?? false;
    const resume_after_minutes = pickNumberParam(payload, 'resume_after_minutes', 'resumeAfterMinutes');
    
    if (!reason || typeof reason !== 'string') {
      return {
        success: false,
        error: 'reason is required',
        message: 'Missing required parameter: reason',
      };
    }
    
    const prevState = heartbeatScheduler.getState();
    heartbeatScheduler.requestStop(reason, permanent, resume_after_minutes);
    const newState = heartbeatScheduler.getState();
    
    log.info('[HeartbeatStateTool] Agent requested stop', {
      reason,
      permanent,
      prevState,
      newState,
      contextAgentId: context.agentId,
    });
    
    return {
      success: true,
      data: {
        prevState,
        newState,
        reason,
        permanent,
        resume_after_minutes,
      },
      message: `Heartbeat stopped: ${reason}`,
    };
  },
};

/**
 * heartbeat.resume - Resume heartbeat scheduler (from PAUSED state)
 */
export const heartbeatResumeTool: InternalTool = {
  name: 'heartbeat.resume',
  executionModel: 'state',
  description: 'Resume heartbeat scheduler from PAUSED state. Use when system recovered and ready to process mailbox again.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Reason for resuming heartbeat (optional)',
      },
    },
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    // 动态导入避免循环依赖
    const { heartbeatScheduler } = await import('../../server/index.js');
    const payload = asRecord(params);
    const reason = pickStringParam(payload, 'reason');
    
    const prevState = heartbeatScheduler.getState();
    
    if (prevState !== 'PAUSED') {
      return {
        success: false,
        error: 'invalid_state',
        message: `Cannot resume from ${prevState} state. Only PAUSED state can be resumed.`,
        data: { state: prevState },
      };
    }
    
    heartbeatScheduler.requestResume(reason || 'Agent requested resume');
    const newState = heartbeatScheduler.getState();
    
    log.info('[HeartbeatStateTool] Agent requested resume', {
      reason,
      prevState,
      newState,
      contextAgentId: context.agentId,
    });
    
    return {
      success: true,
      data: {
        prevState,
        newState,
        reason,
      },
      message: `Heartbeat resumed: ${reason || 'Agent requested'}`,
    };
  },
};

/**
 * mailbox.health - Get mailbox health metrics for a specific agent
 */
export const mailboxHealthTool: InternalTool = {
  name: 'mailbox.health',
  executionModel: 'state',
  description: 'Get mailbox health metrics (pending/processing counts, oldest pending age) for a specific agent.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Agent ID to check mailbox health (e.g., finger-system-agent, finger-project-agent)',
      },
    },
    required: ['agent_id'],
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const payload = asRecord(params);
    const agent_id = pickStringParam(payload, 'agent_id', 'agentId') ?? DEFAULT_MAILBOX_AGENT_ID;
    
    const messages = heartbeatMailbox.list(agent_id);
    const now = Date.now();
    
    const pending = messages.filter(m => m.status === 'pending');
    const processing = messages.filter(m => m.status === 'processing');
    const completed = messages.filter(m => m.status === 'completed');
    const failed = messages.filter(m => m.status === 'failed');
    
    const oldestPending = pending.length > 0 ? pending.reduce((a, b) => 
      (new Date(a.createdAt || 0).getTime() < new Date(b.createdAt || 0).getTime()) ? a : b) : null;
    
    return {
      success: true,
      data: {
        agent_id,
        total: messages.length,
        pending: pending.length,
        processing: processing.length,
        completed: completed.length,
        failed: failed.length,
        oldestPendingAgeMs: oldestPending ? now - new Date(oldestPending.createdAt || 0).getTime() : undefined,
        oldestPendingId: oldestPending?.id,
      },
      message: `Mailbox health for ${agent_id}: ${pending.length} pending, ${processing.length} processing`,
    };
  },
};

/**
 * mailbox.clear - Clear all mailbox messages for a specific agent
 */
export const mailboxClearTool: InternalTool = {
  name: 'mailbox.clear',
  executionModel: 'state',
  description: 'Clear all mailbox messages for a specific agent. Use when mailbox is corrupted or needs reset.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'Agent ID to clear mailbox',
      },
      status: {
        type: 'string',
        enum: ['pending', 'processing', 'completed', 'failed', 'all'],
        description: 'Status filter for messages to clear. Default: all',
      },
    },
    required: ['agent_id'],
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const payload = asRecord(params);
    const agent_id = pickStringParam(payload, 'agent_id', 'agentId') ?? DEFAULT_MAILBOX_AGENT_ID;
    const status = pickStringParam(payload, 'status') ?? 'all';
    const cleared = heartbeatMailbox.clear(
      agent_id,
      status as 'pending' | 'processing' | 'completed' | 'failed' | 'all',
    );
    
    log.info('[HeartbeatStateTool] Mailbox cleared', {
      agent_id,
      status,
      removedCount: cleared,
      contextAgentId: context.agentId,
    });
    
    return {
      success: true,
      data: {
        agent_id,
        status,
        cleared,
        clearedCount: cleared,
      },
      message: `cleared ${cleared} messages from ${agent_id} mailbox (status: ${status})`,
    };
  },
};

/**
 * mailbox.mark_skip - Mark a specific message as skip (will be ignored by heartbeat)
 */
export const mailboxMarkSkipTool: InternalTool = {
  name: 'mailbox.mark_skip',
  executionModel: 'state',
  description: 'Mark a specific mailbox message as skip. Heartbeat scheduler will ignore this message.',
  inputSchema: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description: 'Message ID to mark as skip',
      },
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Batch message IDs to mark as skip',
      },
      agent_id: {
        type: 'string',
        description: 'Agent ID that owns the mailbox (required for lookup)',
      },
      reason: {
        type: 'string',
        description: 'Optional reason for marking messages as skip',
      },
    },
    anyOf: [
      { required: ['message_id'] },
      { required: ['ids'] },
    ],
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const payload = asRecord(params);
    const agent_id = pickStringParam(payload, 'agent_id', 'agentId') ?? DEFAULT_MAILBOX_AGENT_ID;
    const singleMessageId = pickStringParam(payload, 'message_id', 'messageId');
    const batchIds = Array.isArray(payload.ids)
      ? payload.ids.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim())
      : [];
    const ids = singleMessageId ? [singleMessageId] : batchIds;
    const reason = pickStringParam(payload, 'reason');

    if (ids.length === 0) {
      return {
        success: false,
        error: 'message_id or ids is required',
        message: 'Missing required parameters: message_id or ids',
      };
    }

    const markedIds = ids.filter((messageId) => heartbeatMailbox.markSkip(agent_id, messageId));
    const marked = markedIds.length;

    if (marked === 0) {
      return {
        success: false,
        error: 'message_not_found',
        message: ids.length === 1
          ? `Message ${ids[0]} not found or already processed`
          : `Messages not found or already processed: ${ids.join(', ')}`,
      };
    }
    
    log.info('[HeartbeatStateTool] Message marked as skip', {
      message_ids: markedIds,
      agent_id,
      reason,
      contextAgentId: context.agentId,
    });
    
    return {
      success: true,
      data: {
        agent_id,
        reason,
        ids: markedIds,
        marked,
        message_id: markedIds[0],
      },
      message: `marked ${marked} message(s) as skip for ${agent_id}`,
    };
  },
};
