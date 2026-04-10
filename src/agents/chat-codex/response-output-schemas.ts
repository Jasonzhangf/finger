import type { ChatCodexDeveloperRole } from './developer-prompt-templates.js';

export type ChatCodexResponseSchemaPreset = 'system' | 'project' | 'none';

const SYSTEM_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', const: 'system' },
    summary: { type: 'string' },
    status: {
      type: 'string',
      enum: ['dispatching', 'reviewing', 'waiting_input', 'completed', 'failed'],
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
    review: {
      type: 'object',
      additionalProperties: false,
      properties: {
        decision: { type: 'string', enum: ['pass', 'retry', 'block'] },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
              issue: { type: 'string' },
              evidence: { type: 'string' },
            },
            required: ['severity', 'issue'],
          },
        },
      },
      required: ['decision'],
    },
    nextAction: { type: 'string' },
  },
  required: ['role', 'summary', 'status', 'nextAction'],
};

const PROJECT_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', const: 'project' },
    summary: { type: 'string' },
    status: { type: 'string', enum: ['completed', 'failed', 'retry'] },
    evidence: { type: 'string' },
    nextAction: { type: 'string' },
  },
  required: ['role', 'summary', 'status', 'nextAction'],
};

const SCHEMA_BY_ROLE: Record<ChatCodexDeveloperRole, Record<string, unknown>> = {
  system: SYSTEM_RESPONSE_SCHEMA,
  project: PROJECT_RESPONSE_SCHEMA,
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
  if (normalized === 'system' || normalized === 'project' || normalized === 'none') {
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
