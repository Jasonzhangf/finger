import type { ChatCodexDeveloperRole } from './developer-prompt-templates.js';

export type ChatCodexResponseSchemaPreset =
  | 'orchestrator'
  | 'reviewer'
  | 'executor'
  | 'searcher'
  | 'none';

const ORCHESTRATOR_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', const: 'orchestrator' },
    summary: { type: 'string' },
    status: {
      type: 'string',
      enum: ['planning', 'dispatching', 'waiting_input', 'completed', 'failed'],
    },
    loopTemplate: { type: 'string' },
    plan: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          blocking: { type: 'boolean' },
          assigneeRole: {
            type: 'string',
            enum: ['orchestrator', 'reviewer', 'executor', 'searcher'],
          },
        },
        required: ['id', 'title', 'blocking', 'assigneeRole'],
      },
    },
    dispatches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetAgentId: { type: 'string' },
          task: { type: 'string' },
          blocking: { type: 'boolean' },
        },
        required: ['targetAgentId', 'task', 'blocking'],
      },
    },
    ask: {
      type: 'object',
      additionalProperties: false,
      properties: {
        required: { type: 'boolean' },
        question: { type: 'string' },
      },
      required: ['required'],
    },
    nextAction: { type: 'string' },
  },
  required: ['role', 'summary', 'status', 'plan', 'dispatches', 'nextAction'],
};

const REVIEWER_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', const: 'reviewer' },
    summary: { type: 'string' },
    target: { type: 'string', enum: ['executor', 'orchestrator', 'general'] },
    reviewLevel: { type: 'string', enum: ['feedback', 'soft_gate', 'hard_gate'] },
    decision: { type: 'string', enum: ['pass', 'retry', 'block', 'feedback'] },
    feedbackRound: { type: 'number' },
    maxFeedbackRounds: { type: 'number' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          claim: { type: 'string' },
          evidenceStatus: { type: 'string', enum: ['supported', 'unsupported', 'missing'] },
          verdict: { type: 'string', enum: ['accepted', 'rejected'] },
        },
        required: ['claim', 'evidenceStatus', 'verdict'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          issue: { type: 'string' },
          evidence: { type: 'string' },
          file: { type: 'string' },
        },
        required: ['severity', 'issue'],
      },
    },
    nextAction: { type: 'string' },
  },
  required: ['role', 'summary', 'target', 'reviewLevel', 'decision', 'findings', 'nextAction'],
};

const EXECUTOR_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', const: 'executor' },
    summary: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
    outputs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string' },
          path: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['type', 'description'],
      },
    },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tool: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['tool', 'detail'],
      },
    },
    nextAction: { type: 'string' },
  },
  required: ['role', 'summary', 'status', 'outputs', 'evidence', 'nextAction'],
};

const SEARCHER_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', const: 'searcher' },
    summary: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'partial', 'failed'] },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          relevance: { type: 'string' },
        },
        required: ['title', 'url', 'relevance'],
      },
    },
    keyFindings: {
      type: 'array',
      items: { type: 'string' },
    },
    nextAction: { type: 'string' },
  },
  required: ['role', 'summary', 'status', 'sources', 'keyFindings', 'nextAction'],
};

const SCHEMA_BY_ROLE: Record<Exclude<ChatCodexDeveloperRole, 'router'>, Record<string, unknown>> = {
  orchestrator: ORCHESTRATOR_RESPONSE_SCHEMA,
  reviewer: REVIEWER_RESPONSE_SCHEMA,
  executor: EXECUTOR_RESPONSE_SCHEMA,
  searcher: SEARCHER_RESPONSE_SCHEMA,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

function parseSchemaPreset(value: unknown): ChatCodexResponseSchemaPreset | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'orchestrator'
    || normalized === 'reviewer'
    || normalized === 'executor'
    || normalized === 'searcher'
    || normalized === 'none'
  ) {
    return normalized;
  }
  return undefined;
}

function cloneSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

export function resolveRoleDefaultResponseSchema(
  role: ChatCodexDeveloperRole,
): Record<string, unknown> | undefined {
  if (role === 'router') return undefined;
  return cloneSchema(SCHEMA_BY_ROLE[role]);
}

export function resolveResponsesOutputSchema(
  metadata: Record<string, unknown> | undefined,
  role: ChatCodexDeveloperRole,
): Record<string, unknown> | undefined {
  const explicit = metadata?.responsesOutputSchema;
  if (isRecord(explicit)) {
    return explicit;
  }

  const preset = parseSchemaPreset(metadata?.responsesOutputSchemaPreset);
  if (preset === 'none') return undefined;
  if (preset) {
    return cloneSchema(SCHEMA_BY_ROLE[preset]);
  }

  const structuredEnabled = parseOptionalBoolean(metadata?.responsesStructuredOutput)
    ?? parseOptionalBoolean(metadata?.structuredResponse)
    ?? false;
  if (!structuredEnabled) return undefined;
  return resolveRoleDefaultResponseSchema(role);
}
