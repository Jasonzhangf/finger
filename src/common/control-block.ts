import { tryParseStructuredJson } from './structured-output.js';

export interface FingerControlBlock {
  schema_version: string;
  task_completed: boolean;
  evidence_ready: boolean;
  needs_user_input: boolean;
  has_blocker: boolean;
  dispatch_required: boolean;
  review_required: boolean;
  context_review_hint: 'none' | 'light' | 'aggressive';
  wait: {
    enabled: boolean;
    seconds: number;
    reason: string;
    [key: string]: unknown;
  };
  user_signal: {
    negative_score: number;
    friction_score?: number;
    strong_negative?: boolean;
    profile_update_required: boolean;
    why: string;
    [key: string]: unknown;
  };
  tags: string[];
  anti_patterns: string[];
  self_eval: {
    score: number;
    confidence: number;
    goal_gap: string;
    why: string;
    [key: string]: unknown;
  };
  learning: {
    did_right: string[];
    did_wrong: string[];
    repeated_wrong: string[];
    flow_patch: {
      required: boolean;
      project_scope: string;
      changes: string[];
      [key: string]: unknown;
    };
    memory_patch: {
      required: boolean;
      project_scope: string;
      long_term_items: string[];
      short_term_items: string[];
      [key: string]: unknown;
    };
    user_profile_patch: {
      required: boolean;
      items: string[];
      sensitivity: 'normal' | 'sensitive';
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ControlBlockParseResult {
  present: boolean;
  valid: boolean;
  repaired: boolean;
  humanResponse: string;
  issues: string[];
  controlBlock?: FingerControlBlock;
}

export interface ControlBlockPolicy {
  enabled: boolean;
  promptInjectionEnabled: boolean;
  requireOnStop: boolean;
  maxAutoContinueTurns: number;
  autonomyMode: 'balanced' | 'yolo';
}

export interface ControlHookEvaluation {
  hooks: string[];
  holdStop: boolean;
}

export interface ControlStopDecisionInput {
  finishReasonStop: boolean;
  parsed: ControlBlockParseResult;
  hooks: ControlHookEvaluation;
  yoloMode?: boolean;
}

const MACHINE_CONTROL_HINTS = [
  'schema_version',
  'task_completed',
  'evidence_ready',
  'needs_user_input',
  'has_blocker',
  'dispatch_required',
  'review_required',
  'anti_patterns',
  'self_eval',
  'learning',
  'tool_calls',
  'reasoning_stop',
  'reasoning.stop',
  'finish_reason',
  'user_signal',
  'context_review_hint',
  'hook.',
  'report-task-completion',
] as const;

const REQUIRED_BASE_KEYS = [
  'schema_version',
  'task_completed',
  'evidence_ready',
  'needs_user_input',
  'has_blocker',
  'dispatch_required',
  'review_required',
  'wait',
  'user_signal',
  'tags',
  'self_eval',
  'anti_patterns',
  'learning',
] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  return Math.min(max, Math.max(min, floored));
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asStringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, maxItems);
}

function asStringArrayLoose(value: unknown, maxItems: number): string[] {
  if (Array.isArray(value)) return asStringArray(value, maxItems);
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) return [];
    const split = normalized
      .split(/[,\n;]/g)
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(0, maxItems);
    if (split.length > 0) return split;
    return [normalized];
  }
  return [];
}

type PathMask = readonly string[];

function readMaskedValue(root: Record<string, unknown>, mask: PathMask): unknown {
  if (mask.length === 0) return undefined;
  let current: unknown = root;
  for (let index = 0; index < mask.length; index += 1) {
    const key = mask[index];
    const record = asRecord(current);
    if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
    current = record[key];
  }
  return current;
}

function collectStringsFromMasks(
  root: Record<string, unknown>,
  masks: PathMask[],
  maxItems: number,
): string[] {
  const merged: string[] = [];
  for (const mask of masks) {
    const value = readMaskedValue(root, mask);
    const items = asStringArrayLoose(value, maxItems);
    if (items.length === 0) continue;
    for (const item of items) {
      if (merged.includes(item)) continue;
      merged.push(item);
      if (merged.length >= maxItems) return merged;
    }
  }
  return merged;
}

function pickStringFromMasks(root: Record<string, unknown>, masks: PathMask[]): string | undefined {
  for (const mask of masks) {
    const value = readMaskedValue(root, mask);
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}

function extractLastControlFence(rawReply: string): { blockText: string; strippedReply: string } | undefined {
  const pattern = /```finger-control\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while ((match = pattern.exec(rawReply)) !== null) {
    last = match;
  }
  if (!last || typeof last.index !== 'number') return undefined;
  const matchedText = last[0] ?? '';
  const blockText = (last[1] ?? '').trim();
  const stripped = `${rawReply.slice(0, last.index)}${rawReply.slice(last.index + matchedText.length)}`.trim();
  return {
    blockText,
    strippedReply: stripped,
  };
}

function extractAllGenericJsonFences(rawReply: string): Array<{ blockText: string; strippedReply: string }> {
  const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  const results: Array<{ blockText: string; strippedReply: string }> = [];
  let match: RegExpExecArray | null = null;
  while ((match = pattern.exec(rawReply)) !== null) {
    const matchedText = match[0] ?? '';
    const blockText = (match[1] ?? '').trim();
    const index = typeof match.index === 'number' ? match.index : -1;
    if (index < 0 || blockText.length === 0) continue;
    const stripped = `${rawReply.slice(0, index)}${rawReply.slice(index + matchedText.length)}`.trim();
    results.push({ blockText, strippedReply: stripped });
  }
  return results;
}

function extractTrailingJsonObject(rawReply: string): { blockText: string; strippedReply: string } | undefined {
  const source = rawReply.trimEnd();
  const end = source.lastIndexOf('}');
  if (end < 0) return undefined;

  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;
  for (let index = end; index >= 0; index -= 1) {
    const ch = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '}') {
      depth += 1;
      continue;
    }
    if (ch === '{') {
      depth -= 1;
      if (depth === 0) {
        start = index;
        break;
      }
    }
  }

  if (start < 0 || start >= end) return undefined;
  const blockText = source.slice(start, end + 1).trim();
  if (blockText.length === 0) return undefined;
  const prefix = source.slice(0, start).trimEnd();
  const suffix = source.slice(end + 1).trim();
  const strippedReply = [prefix, suffix].filter((item) => item.length > 0).join('\n').trim();
  return { blockText, strippedReply };
}

function looksLikeMachineControlPayload(raw: string): boolean {
  const source = raw.trim();
  if (!source) return false;
  const lowered = source.toLowerCase();
  let hit = 0;
  for (const hint of MACHINE_CONTROL_HINTS) {
    if (lowered.includes(hint)) hit += 1;
  }
  if (hit >= 2) return true;
  // 强信号：工具调用编排块（即使字段较少也应剥离）
  if (/"tool_calls"\s*:\s*\[/i.test(source)) return true;
  if (/"name"\s*:\s*"reasoning[_\-.]?stop"/i.test(source)) return true;
  return false;
}

export function stripControlLikeJsonPayload(text: string): string {
  let output = typeof text === 'string' ? text : '';
  if (!output.trim()) return '';

  const fencePattern = /```(?:json|finger-control)?\s*([\s\S]*?)```/giu;
  output = output.replace(fencePattern, (full, block) => {
    const body = typeof block === 'string' ? block : '';
    return looksLikeMachineControlPayload(body) ? '' : full;
  }).trim();

  // 处理未闭合 fence：```json{... 或 ```finger-control{...
  const danglingFence = output.match(/```(?:json|finger-control)\s*([\s\S]*)$/iu);
  if (danglingFence && typeof danglingFence.index === 'number') {
    const body = danglingFence[1] ?? '';
    if (looksLikeMachineControlPayload(body)) {
      output = output.slice(0, danglingFence.index).trimEnd();
    }
  }

  // 兜底：尾部裸 JSON 控制对象
  const trailing = extractTrailingJsonObject(output);
  if (trailing && looksLikeMachineControlPayload(trailing.blockText)) {
    output = trailing.strippedReply;
  }
  return output.trim();
}

function looksLikeControlBlockCandidate(parsedObject: Record<string, unknown>): boolean {
  if (asRecord(parsedObject.control_block)) return true;
  const requiredHints = [
    'schema_version',
    'task_completed',
    'evidence_ready',
    'needs_user_input',
    'has_blocker',
    'dispatch_required',
    'review_required',
    'wait',
    'user_signal',
    'tags',
    'self_eval',
    'anti_patterns',
    'learning',
  ];
  const hitCount = requiredHints.reduce((count, key) => (
    Object.prototype.hasOwnProperty.call(parsedObject, key) ? count + 1 : count
  ), 0);
  return hitCount >= 4 && (
    Object.prototype.hasOwnProperty.call(parsedObject, 'schema_version')
    || Object.prototype.hasOwnProperty.call(parsedObject, 'task_completed')
  );
}

function tryParseControlBlockCandidate(
  blockText: string,
  strippedReply: string,
): ControlBlockParseResult | undefined {
  const parsed = tryParseStructuredJson(blockText);
  if (parsed.parsed === undefined) return undefined;
  const parsedObject = asRecord(parsed.parsed) ?? {};
  if (!looksLikeControlBlockCandidate(parsedObject)) return undefined;
  const candidate = asRecord(parsedObject.control_block) ?? parsedObject;
  const normalized = normalizeControlBlock(candidate);
  return {
    present: true,
    valid: normalized.issues.length === 0 && normalized.compatible,
    repaired: parsed.repaired,
    humanResponse: strippedReply,
    issues: normalized.issues,
    controlBlock: normalized.controlBlock,
  };
}

export function resolveControlBlockPolicy(metadata?: Record<string, unknown>): ControlBlockPolicy {
  const autonomyModeRaw = typeof metadata?.autonomyMode === 'string'
    ? metadata.autonomyMode.trim().toLowerCase()
    : '';
  const yoloModeFromFlag = asBoolean(metadata?.yoloMode, false);
  const autonomyMode: 'balanced' | 'yolo' = (
    autonomyModeRaw === 'yolo' || yoloModeFromFlag
  ) ? 'yolo' : 'balanced';
  const requireOnStop = asBoolean(metadata?.controlBlockRequireOnStop, true);
  const defaultMaxTurns = autonomyMode === 'yolo' ? 4 : 2;
  const maxAutoContinueTurns = asInt(metadata?.controlBlockMaxAutoContinueTurns, defaultMaxTurns, 0, 5);
  return {
    enabled: asBoolean(metadata?.controlBlockEnabled, true),
    promptInjectionEnabled: asBoolean(metadata?.controlBlockPromptInjectionEnabled, true),
    requireOnStop,
    maxAutoContinueTurns,
    autonomyMode,
  };
}

export function normalizeControlBlock(rawValue: unknown): { controlBlock: FingerControlBlock; issues: string[]; compatible: boolean } {
  const root = asRecord(rawValue) ?? {};
  const issues: string[] = [];
  const missing = REQUIRED_BASE_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(root, key));
  for (const item of missing) issues.push(`missing:${item}`);

  const schemaVersionRaw = asString(root.schema_version, '1.0');
  const schemaVersion = schemaVersionRaw.length > 0 ? schemaVersionRaw : '1.0';
  const major = Number(schemaVersion.split('.')[0] ?? '1');
  const compatible = Number.isFinite(major) && major === 1;
  if (!compatible) issues.push(`schema_incompatible:${schemaVersion}`);

  const waitInput = asRecord(root.wait) ?? {};
  const waitScalar = root.wait;
  const waitFromScalar = asBoolean(waitScalar, false);
  const wait = {
    ...waitInput,
    enabled: asBoolean(waitInput.enabled, waitFromScalar),
    seconds: asInt(waitInput.seconds, 0, 0, 86_400),
    reason: asString(waitInput.reason, typeof waitScalar === 'string' ? waitScalar : ''),
  };

  const userSignalInput = asRecord(root.user_signal) ?? {};
  const userSignalScalar = root.user_signal;
  const userSignalNegativeFromScalar = asInt(userSignalScalar, 0, 0, 100);
  const userSignal = {
    ...userSignalInput,
    negative_score: asInt(userSignalInput.negative_score, userSignalNegativeFromScalar, 0, 100),
    profile_update_required: asBoolean(userSignalInput.profile_update_required, false),
    why: asString(userSignalInput.why, typeof userSignalScalar === 'string' ? userSignalScalar : ''),
    ...(Object.prototype.hasOwnProperty.call(userSignalInput, 'friction_score')
      ? { friction_score: asInt(userSignalInput.friction_score, 0, 0, 100) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(userSignalInput, 'strong_negative')
      ? { strong_negative: asBoolean(userSignalInput.strong_negative, false) }
      : {}),
  };

  const contextReviewHintRaw = asString(root.context_review_hint, 'none').toLowerCase();
  const context_review_hint: 'none' | 'light' | 'aggressive' = (
    contextReviewHintRaw === 'light' || contextReviewHintRaw === 'aggressive'
  ) ? contextReviewHintRaw : 'none';

  const selfEvalInput = asRecord(root.self_eval) ?? {};
  const selfEvalScalar = root.self_eval;
  const selfEvalScoreFromScalar = asInt(selfEvalScalar, 0, -100, 100);
  const selfEval = {
    ...selfEvalInput,
    score: asInt(selfEvalInput.score, selfEvalScoreFromScalar, -100, 100),
    confidence: asInt(selfEvalInput.confidence, 0, 0, 100),
    goal_gap: asString(selfEvalInput.goal_gap, ''),
    why: asString(selfEvalInput.why, typeof selfEvalScalar === 'string' ? selfEvalScalar : ''),
  };

  const learningRaw = root.learning;
  const learningInput = asRecord(learningRaw) ?? {};
  const flowPatchInput = asRecord(learningInput.flow_patch ?? root.flow_patch) ?? {};
  const memoryPatchInput = asRecord(learningInput.memory_patch ?? root.memory_patch) ?? {};
  const userProfilePatchInput = asRecord(learningInput.user_profile_patch ?? root.user_profile_patch) ?? {};
  const looseFlowChanges = collectStringsFromMasks(root, [
    ['learning', 'flow_patch', 'changes'],
    ['learning', 'flow_patch', 'patch'],
    ['learning', 'flowPatch', 'changes'],
    ['learning', 'flowPatch'],
    ['learning', 'flow_changes'],
    ['flow_patch', 'changes'],
    ['flow_patch_changes'],
    ['flowChanges'],
  ], 32);
  const looseLongTermItems = collectStringsFromMasks(root, [
    ['learning', 'memory_patch', 'long_term_items'],
    ['learning', 'memory_patch', 'longTermItems'],
    ['learning', 'memory_patch', 'items'],
    ['learning', 'memoryPatch', 'long_term_items'],
    ['learning', 'memoryPatch', 'longTermItems'],
    ['learning', 'memoryPatch', 'items'],
    ['learning', 'memory'],
    ['learning', 'long_term_items'],
    ['memory_patch', 'long_term_items'],
    ['memory_patch', 'longTermItems'],
    ['memory_patch', 'items'],
    ['long_term_items'],
    ['memory'],
  ], 64);
  const looseShortTermItems = collectStringsFromMasks(root, [
    ['learning', 'memory_patch', 'short_term_items'],
    ['learning', 'memory_patch', 'shortTermItems'],
    ['learning', 'memoryPatch', 'short_term_items'],
    ['learning', 'memoryPatch', 'shortTermItems'],
    ['learning', 'short_term_items'],
    ['memory_patch', 'short_term_items'],
    ['memory_patch', 'shortTermItems'],
    ['short_term_items'],
  ], 64);
  const looseUserProfileItems = collectStringsFromMasks(root, [
    ['learning', 'user_profile_patch', 'items'],
    ['learning', 'userProfilePatch', 'items'],
    ['learning', 'profile_patch'],
    ['learning', 'user_profile'],
    ['user_profile_patch', 'items'],
    ['userProfilePatch', 'items'],
    ['user_profile_items'],
    ['profile_patch'],
  ], 64);
  const didRight = collectStringsFromMasks(root, [
    ['learning', 'did_right'],
    ['learning', 'didRight'],
    ['did_right'],
    ['didRight'],
  ], 32);
  const didWrong = collectStringsFromMasks(root, [
    ['learning', 'did_wrong'],
    ['learning', 'didWrong'],
    ['did_wrong'],
    ['didWrong'],
  ], 32);
  const repeatedWrong = collectStringsFromMasks(root, [
    ['learning', 'repeated_wrong'],
    ['learning', 'repeatedWrong'],
    ['repeated_wrong'],
    ['repeatedWrong'],
  ], 32);
  const learningText = typeof learningRaw === 'string' ? learningRaw.trim() : '';
  const flowText = typeof flowPatchInput === 'object' && typeof flowPatchInput.changes === 'string'
    ? flowPatchInput.changes.trim()
    : '';
  const memoryText = typeof memoryPatchInput === 'object' && typeof memoryPatchInput.long_term_items === 'string'
    ? memoryPatchInput.long_term_items.trim()
    : '';
  const userProfileText = typeof userProfilePatchInput === 'object' && typeof userProfilePatchInput.items === 'string'
    ? userProfilePatchInput.items.trim()
    : '';
  const fallbackFlowText = pickStringFromMasks(root, [
    ['learning', 'flow_patch', 'changes'],
    ['learning', 'flow_patch', 'patch'],
    ['learning', 'flowPatch', 'changes'],
    ['learning', 'flowPatch'],
    ['learning', 'flow_changes'],
    ['flow_patch', 'changes'],
    ['flow_patch_changes'],
    ['flowChanges'],
  ]) ?? '';
  const fallbackMemoryText = pickStringFromMasks(root, [
    ['learning', 'memory_patch', 'long_term_items'],
    ['learning', 'memory_patch', 'items'],
    ['learning', 'memoryPatch', 'long_term_items'],
    ['learning', 'memoryPatch', 'items'],
    ['learning', 'memory'],
    ['memory_patch', 'long_term_items'],
    ['memory_patch', 'items'],
    ['long_term_items'],
    ['memory'],
  ]) ?? '';
  const fallbackUserProfileText = pickStringFromMasks(root, [
    ['learning', 'user_profile_patch', 'items'],
    ['learning', 'userProfilePatch', 'items'],
    ['learning', 'profile_patch'],
    ['learning', 'user_profile'],
    ['user_profile_patch', 'items'],
    ['userProfilePatch', 'items'],
    ['user_profile_items'],
    ['profile_patch'],
  ]) ?? '';
  const flowProjectScope = pickStringFromMasks(root, [
    ['learning', 'flow_patch', 'project_scope'],
    ['learning', 'flowPatch', 'project_scope'],
    ['flow_patch', 'project_scope'],
  ]) ?? '';
  const memoryProjectScope = pickStringFromMasks(root, [
    ['learning', 'memory_patch', 'project_scope'],
    ['learning', 'memoryPatch', 'project_scope'],
    ['memory_patch', 'project_scope'],
  ]) ?? '';
  const sensitivityRaw = asString(userProfilePatchInput.sensitivity, 'normal').toLowerCase();

  const learning = {
    ...learningInput,
    did_right: didRight,
    did_wrong: didWrong,
    repeated_wrong: repeatedWrong,
    flow_patch: {
      ...flowPatchInput,
      required: asBoolean(flowPatchInput.required, looseFlowChanges.length > 0 || flowText.length > 0 || fallbackFlowText.length > 0),
      project_scope: asString(flowPatchInput.project_scope, flowProjectScope),
      changes: looseFlowChanges.length > 0
        ? looseFlowChanges
        : (flowText.length > 0 ? [flowText] : (fallbackFlowText.length > 0 ? [fallbackFlowText] : [])),
    },
    memory_patch: {
      ...memoryPatchInput,
      required: asBoolean(memoryPatchInput.required, looseLongTermItems.length > 0 || memoryText.length > 0 || fallbackMemoryText.length > 0 || learningText.length > 0),
      project_scope: asString(memoryPatchInput.project_scope, memoryProjectScope),
      long_term_items: looseLongTermItems.length > 0
        ? looseLongTermItems
        : (memoryText.length > 0
          ? [memoryText]
          : (fallbackMemoryText.length > 0
            ? [fallbackMemoryText]
            : (learningText.length > 0 ? [learningText] : []))),
      short_term_items: looseShortTermItems,
    },
    user_profile_patch: {
      ...userProfilePatchInput,
      required: asBoolean(userProfilePatchInput.required, looseUserProfileItems.length > 0 || userProfileText.length > 0 || fallbackUserProfileText.length > 0),
      items: looseUserProfileItems.length > 0
        ? looseUserProfileItems
        : (userProfileText.length > 0 ? [userProfileText] : (fallbackUserProfileText.length > 0 ? [fallbackUserProfileText] : [])),
      sensitivity: (sensitivityRaw === 'sensitive' ? 'sensitive' : 'normal') as 'normal' | 'sensitive',
    },
    ...(learningText.length > 0 ? { note: learningText } : {}),
  };

  const tags = collectStringsFromMasks(root, [
    ['tags'],
    ['tag'],
    ['labels'],
  ], 128);
  const antiPatterns = collectStringsFromMasks(root, [
    ['anti_patterns'],
    ['antiPatterns'],
    ['antipatterns'],
  ], 32);

  const controlBlock: FingerControlBlock = {
    ...root,
    schema_version: schemaVersion,
    task_completed: asBoolean(root.task_completed, false),
    evidence_ready: asBoolean(root.evidence_ready, false),
    needs_user_input: asBoolean(root.needs_user_input, false),
    has_blocker: asBoolean(root.has_blocker, false),
    dispatch_required: asBoolean(root.dispatch_required, false),
    review_required: asBoolean(root.review_required, false),
    context_review_hint,
    wait,
    user_signal: userSignal,
    tags,
    anti_patterns: antiPatterns,
    self_eval: selfEval,
    learning,
  };

  return { controlBlock, issues, compatible };
}

export function evaluateControlHooks(controlBlock: FingerControlBlock): ControlHookEvaluation {
  const hooks = new Set<string>();
  if (controlBlock.task_completed && controlBlock.evidence_ready) hooks.add('hook.task.complete');
  if (controlBlock.task_completed && !controlBlock.evidence_ready) hooks.add('hook.task.continue');
  if (controlBlock.needs_user_input) hooks.add('hook.waiting_user');
  if (controlBlock.wait.enabled && controlBlock.wait.seconds > 0) hooks.add('hook.scheduler.wait');
  if (controlBlock.dispatch_required) hooks.add('hook.dispatch');
  if (controlBlock.review_required) hooks.add('hook.reviewer');
  if (controlBlock.context_review_hint === 'light' || controlBlock.context_review_hint === 'aggressive') {
    hooks.add('hook.context.review');
  }
  if (controlBlock.self_eval.score < 0) hooks.add('hook.digest.negative');
  if (controlBlock.self_eval.score >= 0) hooks.add('hook.digest.defer_positive');
  if (controlBlock.user_signal.negative_score >= 70) hooks.add('hook.user.profile.update');
  if (controlBlock.anti_patterns.length > 0) hooks.add('hook.user.guardrails.candidate');
  if (controlBlock.learning.flow_patch.required) hooks.add('hook.project.flow.update');
  if (controlBlock.learning.memory_patch.required) hooks.add('hook.project.memory.update');
  if (controlBlock.learning.user_profile_patch.required) hooks.add('hook.user.profile.update');
  return {
    hooks: Array.from(hooks),
    holdStop: hooks.has('hook.task.continue'),
  };
}

export function shouldHoldStopByControlBlock(input: ControlStopDecisionInput): boolean {
  if (!input.finishReasonStop) return false;
  if (!input.parsed.valid) return true;
  const controlBlock = input.parsed.controlBlock;
  if (!controlBlock) return true;
  const yoloMode = input.yoloMode === true;
  if (!yoloMode && controlBlock.needs_user_input) return false;
  // YOLO mode: ignore approval-only user input gating and keep executing unless task is truly complete
  // or an explicit timed wait is scheduled.
  if (controlBlock.wait.enabled && controlBlock.wait.seconds > 0) return false;
  if (controlBlock.task_completed && controlBlock.evidence_ready) return false;
  if (input.hooks.holdStop) return true;
  // Default strict policy: if model requested stop but task is not fully complete/evidence-ready,
  // continue reasoning unless explicitly waiting for user or scheduled wait.
  return true;
}

export function parseControlBlockFromReply(rawReply: string): ControlBlockParseResult {
  const normalizedReply = typeof rawReply === 'string' ? rawReply : '';
  const fenced = extractLastControlFence(normalizedReply);
  if (!fenced) {
    const genericFences = extractAllGenericJsonFences(normalizedReply);
    for (let index = genericFences.length - 1; index >= 0; index -= 1) {
      const candidate = genericFences[index];
      const parsedCandidate = tryParseControlBlockCandidate(candidate.blockText, candidate.strippedReply);
      if (parsedCandidate) return parsedCandidate;
    }
    const trailing = extractTrailingJsonObject(normalizedReply);
    if (trailing) {
      const parsedTrailing = tryParseControlBlockCandidate(trailing.blockText, trailing.strippedReply);
      if (parsedTrailing) return parsedTrailing;
    }
    return {
      present: false,
      valid: false,
      repaired: false,
      humanResponse: normalizedReply.trim(),
      issues: ['control_block_missing'],
    };
  }

  const parsed = tryParseStructuredJson(fenced.blockText);
  if (parsed.parsed === undefined) {
    return {
      present: true,
      valid: false,
      repaired: parsed.repaired,
      humanResponse: fenced.strippedReply,
      issues: ['control_block_json_parse_failed'],
    };
  }

  const parsedObject = asRecord(parsed.parsed) ?? {};
  const candidate = asRecord(parsedObject.control_block) ?? parsedObject;
  const normalized = normalizeControlBlock(candidate);
  return {
    present: true,
    valid: normalized.issues.length === 0 && normalized.compatible,
    repaired: parsed.repaired,
    humanResponse: fenced.strippedReply,
    issues: normalized.issues,
    controlBlock: normalized.controlBlock,
  };
}
