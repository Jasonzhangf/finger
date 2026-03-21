import { InternalTool } from './types.js';

type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

interface PlanItem {
  step: string;
  status: PlanStepStatus;
}

interface UpdatePlanInput {
  explanation?: string;
  plan: PlanItem[];
}

export interface UpdatePlanOutput {
  ok: boolean;
  content: string;
  explanation?: string;
  plan: PlanItem[];
  updatedAt: string;
}

let lastPlanSnapshot: UpdatePlanOutput | null = null;

export const updatePlanTool: InternalTool<unknown, UpdatePlanOutput> = {
  name: 'update_plan',
  description:
    'Updates the task plan. Each plan item must have a "step" field (the step description) and a "status" field (pending, in_progress, or completed).',
  inputSchema: {
    type: 'object',
    properties: {
      explanation: { type: 'string' },
      plan: {
        type: 'array',
        description: 'Array of plan items. Each item requires "step" (string) and "status" (string: pending|in_progress|completed).',
        items: {
          type: 'object',
          properties: {
            step: { type: 'string', description: 'Short description of the step (required)' },
            status: { type: 'string', description: 'One of: pending, in_progress, completed (required)' },
          },
          required: ['step', 'status'],
          additionalProperties: false,
        },
      },
    },
    required: ['plan'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown): Promise<UpdatePlanOutput> => {
    const input = parseUpdatePlanInput(rawInput);
    const now = new Date().toISOString();

    const output: UpdatePlanOutput = {
      ok: true,
      content: 'Plan updated',
      explanation: input.explanation,
      plan: input.plan,
      updatedAt: now,
    };
    lastPlanSnapshot = output;
    return output;
  },
};

export function getLastPlanSnapshot(): UpdatePlanOutput | null {
  return lastPlanSnapshot ? { ...lastPlanSnapshot, plan: [...lastPlanSnapshot.plan] } : null;
}

function parseUpdatePlanInput(rawInput: unknown): UpdatePlanInput {
  if (!isRecord(rawInput)) {
    throw new Error('update_plan input must be an object');
  }

  if (!Array.isArray(rawInput.plan)) {
    throw new Error('update_plan input.plan must be an array');
  }

  const plan: PlanItem[] = [];
  let inProgressCount = 0;

  for (const item of rawInput.plan) {
    if (!isRecord(item)) {
      throw new Error('update_plan input.plan items must be objects');
    }
    if (typeof item.step !== 'string' || item.step.trim().length === 0) {
      throw new Error('update_plan plan item.step must be a non-empty string');
    }
    if (!isPlanStatus(item.status)) {
      throw new Error('update_plan plan item.status must be pending|in_progress|completed');
    }
    if (item.status === 'in_progress') {
      inProgressCount += 1;
    }
    plan.push({
      step: item.step.trim(),
      status: item.status,
    });
  }

  if (inProgressCount > 1) {
    throw new Error('update_plan allows at most one step with status=in_progress');
  }

  const parsed: UpdatePlanInput = { plan };
  if (typeof rawInput.explanation === 'string' && rawInput.explanation.trim().length > 0) {
    parsed.explanation = rawInput.explanation.trim();
  }
  return parsed;
}

function isPlanStatus(value: unknown): value is PlanStepStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
