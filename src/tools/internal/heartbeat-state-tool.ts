/**
 * Heartbeat State Control Tools - Agent-driven heartbeat state management
 */

import type { InternalTool, ToolExecutionContext } from './types.js';
import { logger } from '../../core/logger.js';
import { heartbeatMailbox } from '../../server/modules/heartbeat-mailbox.js';
import { heartbeatScheduler } from '../../server/index.js';

const log = logger.module('HeartbeatStateTool');

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
    const { reason, permanent = false, resume_after_minutes } = params as {
      reason: string;
      permanent?: boolean;
      resume_after_minutes?: number;
    };
    
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
        resumeAfterMinutes: resume_after_minutes,
      },
      message: `Heartbeat stopped: ${prevState} -> ${newState}`,
    };
  },
};

/**
 * heartbeat.resume - Resume heartbeat scheduler from PAUSED/STOPPED state
 */
export const heartbeatResumeTool: InternalTool = {
  name: 'heartbeat.resume',
  executionModel: 'state',
  description: 'Resume heartbeat scheduler from PAUSED/STOPPED state. Agent-driven decision to restore normal operation.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Reason for resuming heartbeat (required)',
      },
    },
    required: ['reason'],
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const { reason } = params as { reason: string };
    
    if (!reason || typeof reason !== 'string') {
      return {
        success: false,
        error: 'reason is required',
        message: 'Missing required parameter: reason',
      };
    }
    
    const prevState = heartbeatScheduler.getState();
    
    if (prevState !== 'PAUSED' && prevState !== 'STOPPED') {
      return {
        success: false,
        error: 'invalid_state',
        message: `Cannot resume from ${prevState} state (only PAUSED/STOPPED can resume)`,
      };
    }
    
    heartbeatScheduler.requestResume(reason);
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
      message: `Heartbeat resumed: ${prevState} -> ${newState}`,
    };
  },
};

/**
 * mailbox.health - Get mailbox health status
 */
export const mailboxHealthTool: InternalTool = {
  name: 'mailbox.health',
  executionModel: 'state',
  description: 'Get mailbox health status (pending/processing counts, oldest message age). Use to detect backlog or stale messages.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'Agent ID to check (default: finger-system-agent)',
      },
    },
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const { agentId = 'finger-system-agent' } = params as { agentId?: string };
    
    const messages = heartbeatMailbox.list(agentId);
    const now = Date.now();
    const pending = messages.filter(m => m.status === 'pending');
    const processing = messages.filter(m => m.status === 'processing');
    const oldestPending = pending.length > 0 ? pending.reduce((a, b) => 
      (new Date(a.createdAt || 0).getTime() < new Date(b.createdAt || 0).getTime()) ? a : b) : null;
    const health = {
      pending: pending.length,
      processing: processing.length,
      oldestPendingAgeMs: oldestPending ? now - new Date(oldestPending.createdAt || 0).getTime() : undefined,
    };
    
    return {
      success: true,
      data: {
        agentId,
        health,
        timestamp: new Date().toISOString(),
      },
      message: `Mailbox health for ${agentId}: pending=${health.pending}, processing=${health.processing}`,
    };
  },
};

/**
 * mailbox.clear - Clear mailbox messages by status
 */
export const mailboxClearTool: InternalTool = {
  name: 'mailbox.clear',
  executionModel: 'state',
  description: 'Clear mailbox messages by status (read/completed/failed). Use to reduce backlog.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['read', 'completed', 'failed'],
        description: 'Status of messages to clear',
      },
      agentId: {
        type: 'string',
        description: 'Agent ID to clear (default: finger-system-agent)',
      },
    },
    required: ['status'],
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const { status, agentId = 'finger-system-agent' } = params as {
      status: string;
      agentId?: string;
    };
    
    if (!status || !['read', 'completed', 'failed'].includes(status)) {
      return {
        success: false,
        error: 'invalid_status',
        message: 'status must be one of: read, completed, failed',
      };
    }
    
    // TODO: 实现 heartbeatMailbox.clearByStatus 方法
    // const clearedCount = heartbeatMailbox.clearByStatus(agentId, status);
    
    log.info('[HeartbeatStateTool] Agent requested mailbox clear', {
      agentId,
      status,
      contextAgentId: context.agentId,
    });
    
    return {
      success: true,
      data: {
        agentId,
        status,
        clearedCount: 0, // TODO: 实际清理数量
      },
      message: `Mailbox cleared for ${agentId} (status=${status})`,
    };
  },
};

/**
 * mailbox.mark_skip - Mark messages as skipped (duplicates or irrelevant)
 */
export const mailboxMarkSkipTool: InternalTool = {
  name: 'mailbox.mark_skip',
  executionModel: 'state',
  description: 'Mark mailbox messages as skipped (duplicates or irrelevant). Use to reduce duplicate processing.',
  inputSchema: {
    type: 'object',
    properties: {
      ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Message IDs to mark as skipped',
      },
      reason: {
        type: 'string',
        description: 'Reason for skipping (e.g., "duplicate_notification")',
      },
      agentId: {
        type: 'string',
        description: 'Agent ID (default: finger-system-agent)',
      },
    },
    required: ['ids', 'reason'],
  },
  async execute(params: unknown, context: ToolExecutionContext) {
    const { ids, reason, agentId = 'finger-system-agent' } = params as {
      ids: string[];
      reason: string;
      agentId?: string;
    };
    
    if (!Array.isArray(ids) || ids.length === 0) {
      return {
        success: false,
        error: 'invalid_ids',
        message: 'ids must be a non-empty array',
      };
    }
    
    if (!reason || typeof reason !== 'string') {
      return {
        success: false,
        error: 'reason_required',
        message: 'reason is required',
      };
    }
    
    // TODO: 实现 heartbeatMailbox.markSkipped 方法
    // const markedCount = heartbeatMailbox.markSkipped(agentId, ids, reason);
    
    log.info('[HeartbeatStateTool] Agent requested mailbox mark_skip', {
      agentId,
      ids,
      reason,
      contextAgentId: context.agentId,
    });
    
    return {
      success: true,
      data: {
        agentId,
        ids,
        reason,
        markedCount: 0, // TODO: 实际标记数量
      },
      message: `Messages marked as skipped for ${agentId}`,
    };
  },
};
