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
  goal?: string;
  assumptions?: string;
  tags?: string[];
  toolsUsed?: Array<{
    tool: string;
    args?: string;
    status?: 'success' | 'failure' | 'unknown';
  }>;
  successes?: string[];
  failures?: string[];
  // 新增：结构化完成证据
  completionEvidence?: {
    changedFiles?: string[];
    testsRun?: boolean;
    testsPassed?: boolean;
    verificationCommands?: string[];
    artifacts?: string[];
  };
  // 新增：结构化阻塞证据
  blockedEvidence?: {
    blockerType: 'permission' | 'dependency' | 'ambiguity' | 'resource' | 'external' | 'unknown';
    blockerDescription: string;
    attemptedSolutions?: string[];
    requiredAction?: string;
    timeout?: number;
  };
  // 新增：下一步方向（结构化）
  nextDirection?: {
    action: 'retry' | 'escalate' | 'handoff' | 'abort' | 'wait' | 'replan' | 'continue';
    target?: string;
    estimatedTime?: number;
    prerequisites?: string[];
    context?: string;
    promptForContinuation?: string;
  };
  // 新增：用户决策重要程度
  userDecisionRequired?: 'none' | 'light' | 'medium' | 'heavy';
  userDecisionReason?: string;
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
      goal: {
        type: 'string',
        description: 'Task objective for this turn.',
      },
      assumptions: {
        type: 'string',
        description: 'Main assumptions/hypotheses made during this turn.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task type / keyword tags for retrieval.',
      },
      toolsUsed: {
        type: 'array',
        description: 'Tool usage summary for this turn.',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string' },
            args: { type: 'string' },
            status: { type: 'string', enum: ['success', 'failure', 'unknown'] },
          },
          required: ['tool'],
          additionalProperties: true,
        },
      },
      successes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Successful execution experiences learned in this turn.',
      },
     failures: {
       type: 'array',
       items: { type: 'string' },
       description: 'Failed attempts / lessons in this turn.',
     },
      completionEvidence: {
        type: 'object',
        description: 'Structured completion evidence for successful tasks.',
        properties: {
          changedFiles: { type: 'array', items: { type: 'string' } },
          testsRun: { type: 'boolean' },
          testsPassed: { type: 'boolean' },
          verificationCommands: { type: 'array', items: { type: 'string' } },
          artifacts: { type: 'array', items: { type: 'string' } },
        },
      },
      blockedEvidence: {
        type: 'object',
        description: 'Structured blocked evidence for blocked tasks.',
        properties: {
          blockerType: { type: 'string', enum: ['permission', 'dependency', 'ambiguity', 'resource', 'external', 'unknown'] },
          blockerDescription: { type: 'string' },
          attemptedSolutions: { type: 'array', items: { type: 'string' } },
          requiredAction: { type: 'string' },
          timeout: { type: 'number' },
        },
        required: ['blockerType', 'blockerDescription'],
      },
      nextDirection: {
        type: 'object',
        description: 'Structured next action direction.',
        properties: {
          action: { type: 'string', enum: ['retry', 'escalate', 'handoff', 'abort', 'wait', 'replan', 'continue'] },
          target: { type: 'string' },
          estimatedTime: { type: 'number' },
          prerequisites: { type: 'array', items: { type: 'string' } },
          context: { type: 'string' },
          promptForContinuation: { type: 'string', description: 'Prompt for continuation when decisionLevel is not heavy' },
        },
        required: ['action'],
      },
      userDecisionRequired: {
        type: 'string',
        enum: ['none', 'light', 'medium', 'heavy'],
        description: 'User decision importance level: none (auto), light (optional), medium (self-contained), heavy (blocking).',
      },
      userDecisionReason: {
        type: 'string',
        description: 'Reason why user decision is required.',
      },
   },
   required: ['summary', 'goal', 'assumptions', 'tags', 'toolsUsed', 'successes', 'failures'],
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
    const goal = typeof input?.goal === 'string' ? input.goal.trim() : '';
    if (goal.length === 0) {
      return {
        ok: false,
        stopRequested: false,
        error: 'goal is required',
      };
    }
    const assumptions = typeof input?.assumptions === 'string' ? input.assumptions.trim() : '';
    if (assumptions.length === 0) {
      return {
        ok: false,
        stopRequested: false,
        error: 'assumptions is required',
      };
    }
    const tags = Array.isArray(input?.tags)
      ? input.tags
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
      : [];
    if (tags.length === 0) {
      return {
        ok: false,
        stopRequested: false,
        error: 'tags is required',
      };
    }
    const toolsUsed = Array.isArray(input?.toolsUsed)
      ? input.toolsUsed
        .filter((item): item is { tool: string; args?: string; status?: 'success' | 'failure' | 'unknown' } =>
          typeof item === 'object' && item !== null && typeof item.tool === 'string' && item.tool.trim().length > 0)
        .map((item) => ({
          tool: item.tool.trim(),
          ...(typeof item.args === 'string' && item.args.trim().length > 0 ? { args: item.args.trim() } : {}),
          ...(item.status === 'success' || item.status === 'failure' || item.status === 'unknown'
            ? { status: item.status }
            : {}),
        }))
      : [];
    if (toolsUsed.length === 0) {
      return {
        ok: false,
        stopRequested: false,
        error: 'toolsUsed is required',
      };
    }
    const successes = Array.isArray(input?.successes)
      ? input.successes
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
      : [];
    if (!Array.isArray(input?.successes)) {
      return {
        ok: false,
        stopRequested: false,
        error: 'successes is required',
      };
    }
    const failures = Array.isArray(input?.failures)
      ? input.failures
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
      : [];
    if (!Array.isArray(input?.failures)) {
      return {
        ok: false,
        stopRequested: false,
        error: 'failures is required',
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
     goal,
     assumptions,
     tags,
     toolsUsed,
     successes,
     failures,
      ...(input?.completionEvidence && typeof input.completionEvidence === 'object'
        ? { completionEvidence: input.completionEvidence }
        : {}),
      ...(input?.blockedEvidence && typeof input.blockedEvidence === 'object'
        ? { blockedEvidence: input.blockedEvidence }
        : {}),
      ...(input?.nextDirection && typeof input.nextDirection === 'object'
        ? { nextDirection: input.nextDirection }
        : {}),
      ...(input?.userDecisionRequired && ['none', 'light', 'medium', 'heavy'].includes(input.userDecisionRequired)
        ? { userDecisionRequired: input.userDecisionRequired }
        : {}),
      ...(typeof input?.userDecisionReason === 'string' && input.userDecisionReason.trim().length > 0
        ? { userDecisionReason: input.userDecisionReason.trim() }
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
