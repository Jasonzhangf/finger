import { InternalTool } from './types.js';

interface NoopInput {
  progress: string;
  details: string;
}

export interface NoopOutput {
  ok: boolean;
  progress: string;
  details: string;
  content: string;
}

export const noopTool: InternalTool<unknown, NoopOutput> = {
  name: 'no-op',
  description:
    'Use no-op when you need to report progress in the middle of work. It reports progress/details and has no side effects.',
  inputSchema: {
    type: 'object',
    properties: {
      progress: { type: 'string', description: 'Short progress title' },
      details: { type: 'string', description: 'Progress details to display' },
    },
    required: ['progress', 'details'],
    additionalProperties: false,
  },
  execute: async (rawInput: unknown): Promise<NoopOutput> => {
    const input = parseNoopInput(rawInput);
    const content = JSON.stringify({
      ok: true,
      progress: input.progress,
      details: input.details,
    });

    return {
      ok: true,
      progress: input.progress,
      details: input.details,
      content,
    };
  },
};

function parseNoopInput(rawInput: unknown): NoopInput {
  if (!isRecord(rawInput)) {
    throw new Error('no-op input must be an object');
  }
  if (typeof rawInput.progress !== 'string' || rawInput.progress.trim().length === 0) {
    throw new Error('no-op input.progress must be a non-empty string');
  }
  if (typeof rawInput.details !== 'string' || rawInput.details.trim().length === 0) {
    throw new Error('no-op input.details must be a non-empty string');
  }
  return {
    progress: rawInput.progress.trim(),
    details: rawInput.details.trim(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
