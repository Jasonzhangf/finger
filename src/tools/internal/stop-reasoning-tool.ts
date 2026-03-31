import type { InternalTool } from './types.js';
import {
  DEFAULT_STOP_REASONING_TOOL_NAME,
  readStopReasoningPolicyFile,
  resolveStopReasoningPolicy,
  writeStopReasoningPolicyFile,
} from '../../common/stop-reasoning-policy.js';

interface StopReasoningInput {
  summary: string;
  status?: 'completed' | 'blocked' | 'handoff';
  task?: string;
  nextAction?: string;
}

interface StopReasoningPolicyInput {
  action?: 'status' | 'set';
  promptInjectionEnabled?: boolean;
  stopToolNames?: string[];
  maxAutoContinueTurns?: number;
}

export const stopReasoningTool: InternalTool = {
  name: DEFAULT_STOP_REASONING_TOOL_NAME,
  executionModel: 'state',
  description: 'Signal explicit end-of-reasoning intent. Call this only when current task is truly complete or explicitly blocked.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'What was completed (or why execution must stop).',
      },
      status: {
        type: 'string',
        enum: ['completed', 'blocked', 'handoff'],
        description: 'Completion status for this stop request.',
      },
      task: {
        type: 'string',
        description: 'Task ID or task name for traceability.',
      },
      nextAction: {
        type: 'string',
        description: 'If blocked/handoff, what should happen next.',
      },
    },
    required: ['summary'],
  },
  async execute(rawInput: unknown, context) {
    const input = (rawInput ?? {}) as StopReasoningInput;
    const summary = typeof input?.summary === 'string' ? input.summary.trim() : '';
    if (summary.length === 0) {
      return {
        ok: false,
        stopRequested: false,
        error: 'summary is required',
      };
    }
    const status = input?.status && ['completed', 'blocked', 'handoff'].includes(input.status)
      ? input.status
      : 'completed';
    return {
      ok: true,
      stopRequested: true,
      stopTool: DEFAULT_STOP_REASONING_TOOL_NAME,
      status,
      summary,
      ...(typeof input?.task === 'string' && input.task.trim().length > 0 ? { task: input.task.trim() } : {}),
      ...(typeof input?.nextAction === 'string' && input.nextAction.trim().length > 0
        ? { nextAction: input.nextAction.trim() }
        : {}),
      sessionId: context.sessionId,
      agentId: context.agentId,
      timestamp: new Date().toISOString(),
    };
  },
};

export const stopReasoningPolicyTool: InternalTool = {
  name: 'reasoning.stop_policy',
  executionModel: 'state',
  description: 'Query/update stop-reasoning policy. Gate is always enforced: end turn requires reasoning.stop tool call.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'set'],
      },
      promptInjectionEnabled: { type: 'boolean' },
      stopToolNames: {
        type: 'array',
        items: { type: 'string' },
      },
      maxAutoContinueTurns: { type: 'number' },
    },
  },
  async execute(rawInput: unknown) {
    const input = (rawInput ?? {}) as StopReasoningPolicyInput;
    const action = typeof input?.action === 'string' ? input.action : 'status';
    if (action === 'status') {
      return {
        ok: true,
        action,
        policy: resolveStopReasoningPolicy(),
      };
    }

    const current = await readStopReasoningPolicyFile();
    const next = { ...current };

    if (action === 'set') {
      if (typeof input.promptInjectionEnabled === 'boolean') {
        next.promptInjectionEnabled = input.promptInjectionEnabled;
      }
      if (Array.isArray(input.stopToolNames)) {
        next.stopToolNames = input.stopToolNames;
      }
      if (typeof input.maxAutoContinueTurns === 'number' && Number.isFinite(input.maxAutoContinueTurns)) {
        next.maxAutoContinueTurns = Math.max(0, Math.floor(input.maxAutoContinueTurns));
      }
      next.requireToolForStop = true;
    }

    await writeStopReasoningPolicyFile(next);

    return {
      ok: true,
      action,
      policy: resolveStopReasoningPolicy(),
    };
  },
};
