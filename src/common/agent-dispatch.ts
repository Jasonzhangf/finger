export interface DispatchOutputArtifact {
  type?: string;
  path?: string;
  description: string;
}

export interface DispatchEvidenceItem {
  tool?: string;
  detail: string;
  tags?: string[];
}

export interface DispatchSummaryResult {
  success: boolean;
  status: string;
  summary: string;
  childSessionId?: string;
  module?: string;
  provider?: string;
  messageId?: string;
  latencyMs?: number;
  keyFiles?: string[];
  outputs?: DispatchOutputArtifact[];
  evidence?: DispatchEvidenceItem[];
  nextAction?: string;
  error?: string;
  /** Full raw response data - NEVER truncated, for ledger storage */
  rawPayload?: unknown;
  /** Dynamic classification tags extracted from dispatch result for session routing */
  tags?: string[];
  /** Topic classification hint for coarse session routing */
  topic?: string;
  /** Structured recovery hint for timeout / retry / mailbox fallback */
  recoveryAction?: string;
  /** Delivery path when the dispatch is queued or deferred */
  delivery?: string;
  /** Watchdog / timeout budget associated with this result */
  timeoutMs?: number;
  /** Retry delay selected for the next recovery step */
  retryDelayMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags = value
    .map((entry) => typeof entry === 'string' ? entry.trim() : undefined)
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return tags.length > 0 ? [...new Set(tags)] : undefined;
}

function coalesceTags(...sources: (string[] | undefined)[]): string[] | undefined {
  const all = sources
    .flat()
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return all.length > 0 ? [...new Set(all)] : undefined;
}

function truncateInline(value: string, max = 800): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 3))}...`;
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract a readable summary from structured data when no explicit summary exists.
 * Tries common fields: summary, title, verdict, conclusion, result, response,
 * then builds one-line from structured sub-fields (issues list, keyFiles, outputs).
 * Falls back to truncated JSON string representation.
 */
function extractReadableSummary(raw: unknown, truncateMax = 800): string {
  if (!isRecord(raw)) return truncateInline(String(raw), truncateMax);
  const direct = asNonEmptyString(raw.summary)
    ?? asNonEmptyString(raw.title)
    ?? asNonEmptyString(raw.verdict)
    ?? asNonEmptyString(raw.conclusion)
    ?? asNonEmptyString(raw.result);
  if (direct) return truncateInline(direct, truncateMax);
  const resp = isRecord(raw.response) ? raw.response : undefined;
  if (resp) {
    const respSummary = asNonEmptyString(resp.summary)
      ?? asNonEmptyString(resp.title)
      ?? asNonEmptyString(resp.verdict);
    if (respSummary) return truncateInline(respSummary, truncateMax);
  }
  const issues = pickArray(raw.issues);
  if (issues && issues.length > 0) {
    const titles = issues
      .map((e) => {
        if (!isRecord(e)) return 'issue';
        return asNonEmptyString(e.title) || asNonEmptyString(e.description) || 'issue';
      })
      .filter((t): t is string => typeof t === 'string')
      .slice(0, 5);
    if (titles.length > 0) {
      const v = asNonEmptyString(raw.verdict) || 'done';
      return truncateInline(v + ': ' + titles.join('; '), truncateMax);
    }
  }
  const outputs = pickArray(raw.outputs);
  if (outputs && outputs.length > 0) {
    const ds = outputs
      .map((o) => {
        if (!isRecord(o)) return undefined;
        return asNonEmptyString(o.description) || asNonEmptyString(o.path);
      })
      .filter((d): d is string => typeof d === 'string')
      .slice(0, 3);
    if (ds.length > 0) return truncateInline(ds.join('; '), truncateMax);
  }
  const files = pickArray(raw.reviewed_files);
  if (files && files.length > 0) {
    const v = asNonEmptyString(raw.verdict) || 'done';
    return truncateInline(v + ': reviewed ' + files.length + ' files', truncateMax);
  }
  return truncateInline(asNonEmptyString(raw.response) || JSON.stringify(raw), truncateMax);
}

function pickArray<T>(...candidates: unknown[]): T[] | undefined {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as T[];
  }
  return undefined;
}

function normalizeOutputs(raw: unknown): DispatchOutputArtifact[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const outputs = raw
    .filter((entry) => isRecord(entry))
    .map((entry) => {
      const description = asNonEmptyString(entry.description) ?? asNonEmptyString(entry.summary);
      if (!description) return null;
      const path = asNonEmptyString(entry.path) ?? asNonEmptyString(entry.file);
      const type = asNonEmptyString(entry.type);
      return {
        ...(type ? { type } : {}),
        ...(path ? { path } : {}),
        description,
      };
    })
    .filter((entry): entry is DispatchOutputArtifact => entry !== null);
  return outputs.length > 0 ? outputs : undefined;
}

function normalizeEvidence(raw: unknown): DispatchEvidenceItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const evidence = raw
    .filter((entry) => isRecord(entry))
    .map((entry) => {
      const detail = asNonEmptyString(entry.detail) ?? asNonEmptyString(entry.evidence) ?? asNonEmptyString(entry.observation);
      if (!detail) return null;
      const tool = asNonEmptyString(entry.tool);
      const tags = normalizeStringArray(entry.tags);
      return {
        ...(tool ? { tool } : {}),
        detail,
        ...(tags ? { tags } : {}),
      };
    })
    .filter((entry): entry is DispatchEvidenceItem => entry !== null);
  return evidence.length > 0 ? evidence : undefined;
}

function collectKeyFiles(outputs: DispatchOutputArtifact[] | undefined): string[] | undefined {
  if (!outputs || outputs.length === 0) return undefined;
  const files = Array.from(new Set(
    outputs
      .map((entry) => entry.path?.trim())
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
  ));
  return files.length > 0 ? files : undefined;
}

function resolveResponseRecord(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const responseText = asNonEmptyString(raw.response);
  return parseJsonObject(responseText);
}

export function sanitizeDispatchResult(raw: unknown): DispatchSummaryResult {
  if (typeof raw === 'string') {
    const summary = truncateInline(raw);
    return {
      success: true,
      status: 'completed',
      summary,
      rawPayload: raw,
    };
  }

  if (!isRecord(raw)) {
    return {
      success: true,
      status: 'completed',
      summary: truncateInline(String(raw)),
      rawPayload: raw,
    };
  }

  const responseRecord = resolveResponseRecord(raw);
  const outputs = normalizeOutputs(pickArray(raw.outputs, responseRecord?.outputs));
  const evidence = normalizeEvidence(pickArray(raw.evidence, responseRecord?.evidence, responseRecord?.sources));
  const keyFiles = collectKeyFiles(outputs);

  const explicitSuccess = typeof raw.success === 'boolean' ? raw.success : undefined;
  const status = asNonEmptyString(raw.status)
    ?? asNonEmptyString(responseRecord?.status)
    ?? (explicitSuccess === false ? 'failed' : 'completed');
  const error = asNonEmptyString(raw.error);
  const summary = asNonEmptyString(raw.summary)
    ?? asNonEmptyString(responseRecord?.summary)
    ?? asNonEmptyString(error)
    ?? extractReadableSummary(raw);

  // Extract tags for session routing (multi-tag support)
  const tags = coalesceTags(
    normalizeStringArray(raw.tags),
    normalizeStringArray(responseRecord?.tags),
    asNonEmptyString(raw.topic) ? [asNonEmptyString(raw.topic)!] : undefined,
    asNonEmptyString(responseRecord?.topic) ? [asNonEmptyString(responseRecord?.topic)!] : undefined,
  );

  // Extract topic for coarse routing hint
  const topic = asNonEmptyString(raw.topic ?? responseRecord?.topic);

  return {
    success: explicitSuccess ?? !error,
    status,
    summary,
    ...(asNonEmptyString(raw.sessionId) ? { childSessionId: asNonEmptyString(raw.sessionId) } : {}),
    ...(asNonEmptyString(raw.module) ? { module: asNonEmptyString(raw.module) } : {}),
    ...(asNonEmptyString(raw.provider) ? { provider: asNonEmptyString(raw.provider) } : {}),
    ...(asNonEmptyString(raw.messageId) ? { messageId: asNonEmptyString(raw.messageId) } : {}),
    ...(typeof raw.latencyMs === 'number' && Number.isFinite(raw.latencyMs) ? { latencyMs: Math.round(raw.latencyMs) } : {}),
    ...(keyFiles ? { keyFiles } : {}),
    ...(outputs ? { outputs } : {}),
    ...(evidence ? { evidence } : {}),
    ...(asNonEmptyString(responseRecord?.nextAction) ? { nextAction: asNonEmptyString(responseRecord?.nextAction) } : {}),
    ...(error ? { error } : {}),
    ...(tags ? { tags } : {}),
    ...(topic ? { topic } : {}),
    // Store full raw response for ledger - NEVER truncate
    rawPayload: raw,
  };
}

function extractTaskText(task: unknown): string {
  if (typeof task === 'string') return task.trim();
  if (!isRecord(task)) return String(task);
  const direct = asNonEmptyString(task.text)
    ?? asNonEmptyString(task.content)
    ?? asNonEmptyString(task.prompt)
    ?? asNonEmptyString(task.description)
    ?? asNonEmptyString(task.title)
    ?? asNonEmptyString(task.task)
    ?? asNonEmptyString(task.message);
  if (direct) return direct;
  if (isRecord(task.input)) {
    const nested = asNonEmptyString(task.input.text)
      ?? asNonEmptyString(task.input.content)
      ?? asNonEmptyString(task.input.prompt)
      ?? asNonEmptyString(task.input.description);
    if (nested) return nested;
  }
  try {
    return JSON.stringify(task, null, 2);
  } catch {
    return String(task);
  }
}

function normalizeAcceptance(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => asNonEmptyString(entry))
      .filter((entry): entry is string => typeof entry === 'string');
  }
  const single = asNonEmptyString(raw);
  return single ? [single] : [];
}

export function buildDispatchTaskText(task: unknown, targetRole: string): string {
  const taskRecord = isRecord(task) ? task : undefined;
  const originalText = extractTaskText(task);
  const goal = taskRecord
    ? asNonEmptyString(taskRecord.goal)
      ?? asNonEmptyString(taskRecord.objective)
      ?? asNonEmptyString(taskRecord.target)
      ?? originalText
    : originalText;
  const acceptance = taskRecord
    ? normalizeAcceptance(taskRecord.acceptance)
      .concat(normalizeAcceptance(taskRecord.acceptanceCriteria))
      .concat(normalizeAcceptance(taskRecord.deliverable))
    : [];
  const lines = [
    '[DISPATCH CONTRACT]',
    `target_role=${targetRole}`,
    `goal=${goal}`,
    'deliverable_requirements=',
    '- Execute the assigned task against the stated goal.',
    '- Return a concise summary for the orchestrator to use in the next reasoning cycle.',
    '- Include key file paths in outputs when files are read, created, or modified.',
    '- If blocked or failed, state the blocker, impact, and recommended next action.',
    '- Do not include full raw tool history, api_history, or full transcript in the final answer.',
  ];
  if (acceptance.length > 0) {
    lines.push('acceptance_criteria=');
    for (const item of acceptance) {
      lines.push(`- ${item}`);
    }
  }
  lines.push('response_contract=');
  lines.push('- Prefer strict JSON that matches the active response schema when structured output is enabled.');
  lines.push('- Make `summary` the canonical handoff field for the orchestrator.');
  lines.push('');
  lines.push('[ASSIGNED TASK]');
  lines.push(originalText);
  return lines.join('\n');
}

export { extractTaskText };
