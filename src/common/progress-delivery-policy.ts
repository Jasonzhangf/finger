import type { PushSettings } from '../bridges/types.js';

export type ProgressDeliveryMode = 'all' | 'result_only' | 'silent';

export interface ProgressDeliveryFields {
  reasoning?: boolean;
  bodyUpdates?: boolean;
  statusUpdate?: boolean;
  toolCalls?: boolean;
  stepUpdates?: boolean;
  progressUpdates?: boolean;
}

export interface ProgressDeliveryPolicy {
  enabled?: boolean;
  mode?: ProgressDeliveryMode;
  updateMode?: PushSettings['updateMode'];
  fields?: ProgressDeliveryFields;
}

export function buildInteractiveProgressDeliveryPolicy(): ProgressDeliveryPolicy {
  return {
    updateMode: 'both',
    fields: {
      toolCalls: true,
      statusUpdate: true,
      progressUpdates: true,
      stepUpdates: true,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function normalizeProgressDeliveryPolicy(raw: unknown): ProgressDeliveryPolicy | undefined {
  if (!isRecord(raw)) return undefined;

  const modeRaw = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase() : '';
  const mode: ProgressDeliveryMode | undefined = modeRaw === 'all' || modeRaw === 'result_only' || modeRaw === 'silent'
    ? modeRaw
    : undefined;
  const updateModeRaw = typeof raw.updateMode === 'string'
    ? raw.updateMode.trim().toLowerCase()
    : typeof raw.update_mode === 'string'
      ? raw.update_mode.trim().toLowerCase()
      : '';
  const updateMode: PushSettings['updateMode'] | undefined = updateModeRaw === 'progress'
    || updateModeRaw === 'command'
    || updateModeRaw === 'both'
    ? updateModeRaw
    : undefined;

  const fieldsRaw = isRecord(raw.fields) ? raw.fields : {};
  const fields: ProgressDeliveryFields = {
    reasoning: normalizeBoolean(fieldsRaw.reasoning),
    bodyUpdates: normalizeBoolean(fieldsRaw.bodyUpdates ?? fieldsRaw.body_updates),
    statusUpdate: normalizeBoolean(fieldsRaw.statusUpdate ?? fieldsRaw.status_update),
    toolCalls: normalizeBoolean(fieldsRaw.toolCalls ?? fieldsRaw.tool_calls),
    stepUpdates: normalizeBoolean(fieldsRaw.stepUpdates ?? fieldsRaw.step_updates),
    progressUpdates: normalizeBoolean(fieldsRaw.progressUpdates ?? fieldsRaw.progress_updates),
  };
  const hasFields = Object.values(fields).some((item) => typeof item === 'boolean');

  const enabled = normalizeBoolean(raw.enabled);

  if (!mode && !updateMode && enabled === undefined && !hasFields) return undefined;
  return {
    ...(mode ? { mode } : {}),
    ...(updateMode ? { updateMode } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(hasFields ? { fields } : {}),
  };
}

export function applyProgressDeliveryPolicy(
  base: PushSettings,
  policy?: ProgressDeliveryPolicy,
): PushSettings {
  if (!policy) return base;

  const next: PushSettings = { ...base };

  if (policy.enabled === false) {
    next.reasoning = false;
    next.bodyUpdates = false;
    next.statusUpdate = false;
    next.toolCalls = false;
    next.stepUpdates = false;
    next.progressUpdates = false;
  }

  if (policy.mode === 'result_only') {
    next.reasoning = false;
    next.statusUpdate = false;
    next.toolCalls = false;
    next.stepUpdates = false;
    next.progressUpdates = false;
    next.bodyUpdates = true;
  } else if (policy.mode === 'silent') {
    next.reasoning = false;
    next.bodyUpdates = false;
    next.statusUpdate = false;
    next.toolCalls = false;
    next.stepUpdates = false;
    next.progressUpdates = false;
  }

  if (policy.updateMode) {
    next.updateMode = policy.updateMode;
  }

  if (policy.fields) {
    if (typeof policy.fields.reasoning === 'boolean') next.reasoning = policy.fields.reasoning;
    if (typeof policy.fields.bodyUpdates === 'boolean') next.bodyUpdates = policy.fields.bodyUpdates;
    if (typeof policy.fields.statusUpdate === 'boolean') next.statusUpdate = policy.fields.statusUpdate;
    if (typeof policy.fields.toolCalls === 'boolean') next.toolCalls = policy.fields.toolCalls;
    if (typeof policy.fields.stepUpdates === 'boolean') next.stepUpdates = policy.fields.stepUpdates;
    if (typeof policy.fields.progressUpdates === 'boolean') next.progressUpdates = policy.fields.progressUpdates;
  }

  return next;
}
