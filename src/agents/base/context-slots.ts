import type { UnifiedHistoryItem } from './unified-agent-types.js';

export interface ContextSlotComposerInput {
  cacheKey?: string;
  userInput: string;
  history: UnifiedHistoryItem[];
  tools: string[];
  metadata?: Record<string, unknown>;
}

interface SlotState {
  id: string;
  content: string;
  priority: number;
  maxChars?: number;
}

interface SlotPatch {
  id: string;
  mode: 'replace' | 'append' | 'prepend' | 'remove';
  content?: string;
  priority?: number;
  maxChars?: number;
}

const DEFAULT_SLOT_BUDGETS: Record<string, number> = {
  'turn.user_input': 2_000,
  'turn.recent_history': 8_000,
  'turn.allowed_tools': 1_500,
};

const BASE_SLOT_ORDER = ['turn.user_input', 'turn.recent_history', 'turn.allowed_tools'];

export interface ComposedContextSlots {
  rendered: string;
  slotIds: string[];
  trimmedSlotIds: string[];
}

interface CachedSlotResult {
  signature: string;
  result: ComposedContextSlots | undefined;
}

const slotCache = new Map<string, CachedSlotResult>();
const USER_SLOT_TOKEN = '__FINGER_CONTEXT_SLOT_USER_INPUT__';

export function composeTurnContextSlots(input: ContextSlotComposerInput): ComposedContextSlots | undefined {
  const cacheKey = input.cacheKey?.trim();
  const signature = cacheKey ? buildDirtySignature(input) : undefined;
  if (cacheKey && signature) {
    const cached = slotCache.get(cacheKey);
    if (cached && cached.signature === signature) {
      return hydrateCachedContextSlots(cached.result, input);
    }
  }

  const slots = new Map<string, SlotState>();
  const trimmedSlotIds: string[] = [];

  const userInput = input.userInput.trim();
  if (userInput.length > 0) {
    slots.set('turn.user_input', {
      id: 'turn.user_input',
      content: userInput,
      priority: 10,
    });
  }

  const historyText = renderHistorySlot(input.history);
  if (historyText.length > 0) {
    slots.set('turn.recent_history', {
      id: 'turn.recent_history',
      content: historyText,
      priority: 20,
    });
  }

  const toolsText = renderToolsSlot(input.tools);
  if (toolsText.length > 0) {
    slots.set('turn.allowed_tools', {
      id: 'turn.allowed_tools',
      content: toolsText,
      priority: 30,
    });
  }

  const patches = parseSlotPatches(input.metadata?.contextSlots);
  for (const patch of patches) {
    const existing = slots.get(patch.id);

    if (patch.mode === 'remove') {
      slots.delete(patch.id);
      continue;
    }

    if (existing) {
      const nextPriority = patch.priority ?? existing.priority;
      const nextMaxChars = patch.maxChars ?? existing.maxChars;
      const nextContent = applyPatch(existing.content, patch);
      slots.set(patch.id, {
        id: patch.id,
        content: nextContent,
        priority: nextPriority,
        maxChars: nextMaxChars,
      });
      continue;
    }

    if (!patch.content || patch.content.trim().length === 0) continue;
    slots.set(patch.id, {
      id: patch.id,
      content: patch.content.trim(),
      priority: patch.priority ?? 100,
      maxChars: patch.maxChars,
    });
  }

  if (slots.size === 0) {
    if (cacheKey && signature) {
      slotCache.set(cacheKey, { signature, result: undefined });
    }
    return undefined;
  }

  const budgets = parseSlotBudgets(input.metadata?.contextSlotBudgets);
  for (const slot of slots.values()) {
    const budget = slot.maxChars ?? budgets[slot.id] ?? DEFAULT_SLOT_BUDGETS[slot.id];
    if (!budget || budget <= 0) continue;
    const trimmed = trimSlotContent(slot.id, slot.content, budget);
    if (trimmed !== slot.content) trimmedSlotIds.push(slot.id);
    slot.content = trimmed;
  }

  const preferredOrder = parseSlotOrder(input.metadata?.contextSlotOrder);
  const orderIndex = new Map<string, number>();
  preferredOrder.forEach((id, index) => orderIndex.set(id, index));
  BASE_SLOT_ORDER.forEach((id, index) => {
    if (!orderIndex.has(id)) orderIndex.set(id, 1_000 + index);
  });

  const ordered = Array.from(slots.values())
    .filter((item) => item.content.trim().length > 0)
    .sort((left, right) => {
      const leftOrder = orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      if (left.priority !== right.priority) return left.priority - right.priority;
      return left.id.localeCompare(right.id);
    });

  if (ordered.length === 0) {
    if (cacheKey && signature) {
      slotCache.set(cacheKey, { signature, result: undefined });
    }
    return undefined;
  }

  const rendered = [
    '[CONTEXT_SLOTS]',
    'The following runtime slots are mutable per turn and may be replaced or trimmed.',
    '',
    ...ordered.map((slot) => `<slot id="${slot.id}">\n${slot.content}\n</slot>`),
  ].join('\n');

  const userSlot = ordered.find((slot) => slot.id === 'turn.user_input');
  const templateRendered = userSlot
    ? rendered.replace(slotBlock('turn.user_input', userSlot.content), slotBlock('turn.user_input', USER_SLOT_TOKEN))
    : rendered;

  const templateResult: ComposedContextSlots = {
    rendered: templateRendered,
    slotIds: ordered.map((slot) => slot.id),
    trimmedSlotIds,
  };
  const result = hydrateCachedContextSlots(templateResult, input);
  if (cacheKey && signature) {
    slotCache.set(cacheKey, {
      signature,
      result: cloneComposedContextSlots(templateResult),
    });
  }
  return result;
}

function renderHistorySlot(history: UnifiedHistoryItem[]): string {
  const nonEmpty = history
    .map((item) => ({
      role: item.role,
      content: item.content.trim(),
    }))
    .filter((item) => item.content.length > 0);
  if (nonEmpty.length === 0) return '';

  return nonEmpty.map((item) => `[${item.role}] ${item.content}`).join('\n');
}

function renderToolsSlot(tools: string[]): string {
  const normalized = Array.from(
    new Set(
      tools
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
  if (normalized.length === 0) return '';
  return normalized.map((item) => `- ${item}`).join('\n');
}

function applyPatch(currentContent: string, patch: SlotPatch): string {
  const patchContent = (patch.content ?? '').trim();
  if (patch.mode === 'replace') return patchContent;
  if (patch.mode === 'prepend') return patchContent.length > 0 ? `${patchContent}\n${currentContent}` : currentContent;
  if (patch.mode === 'append') return patchContent.length > 0 ? `${currentContent}\n${patchContent}` : currentContent;
  return currentContent;
}

function trimSlotContent(slotId: string, content: string, budget: number): string {
  if (content.length <= budget) return content;
  if (budget <= 20) return content.slice(-budget);

  const prefix = `[trimmed:${slotId}]`;
  const suffixBudget = budget - prefix.length - 1;
  if (suffixBudget <= 0) return content.slice(-budget);
  return `${prefix}\n${content.slice(-suffixBudget)}`;
}

function parseSlotPatches(value: unknown): SlotPatch[] {
  if (!Array.isArray(value)) return [];
  const patches: SlotPatch[] = [];

  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim().length === 0) continue;
    const mode = normalizeMode(item.mode);
    const content = typeof item.content === 'string' ? item.content : undefined;
    patches.push({
      id: item.id.trim(),
      mode,
      content,
      priority: asOptionalPositiveInt(item.priority),
      maxChars: asOptionalPositiveInt(item.maxChars),
    });
  }

  return patches;
}

function parseSlotBudgets(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const budgets: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof key !== 'string' || key.trim().length === 0) continue;
    const budget = asOptionalPositiveInt(raw);
    if (!budget) continue;
    budgets[key] = budget;
  }
  return budgets;
}

function parseSlotOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id.length === 0) continue;
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function normalizeMode(value: unknown): SlotPatch['mode'] {
  if (value === 'append' || value === 'prepend' || value === 'remove' || value === 'replace') {
    return value;
  }
  return 'replace';
}

function asOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value <= 0) return undefined;
  return Math.floor(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildDirtySignature(input: ContextSlotComposerInput): string {
  const historyTail = input.history.slice(-6).map((item) => `${item.role}:${compressText(item.content, 160)}`).join('|');
  const toolSignature = input.tools
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .sort()
    .join(',');
  const metadataSignature = compactJsonSignature({
    contextSlots: input.metadata?.contextSlots,
    contextSlotBudgets: input.metadata?.contextSlotBudgets,
    contextSlotOrder: input.metadata?.contextSlotOrder,
  });
  return [
    `h:${input.history.length}:${historyTail}`,
    `t:${toolSignature}`,
    `m:${metadataSignature}`,
  ].join('||');
}

function compactJsonSignature(value: unknown): string {
  try {
    const raw = JSON.stringify(value);
    if (!raw) return '';
    return raw.length > 2_000 ? raw.slice(0, 2_000) : raw;
  } catch {
    return '';
  }
}

function compressText(value: string, maxChars: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(-maxChars);
}

function cloneComposedContextSlots(value: ComposedContextSlots | undefined): ComposedContextSlots | undefined {
  if (!value) return undefined;
  return {
    rendered: value.rendered,
    slotIds: [...value.slotIds],
    trimmedSlotIds: [...value.trimmedSlotIds],
  };
}

function hydrateCachedContextSlots(
  cached: ComposedContextSlots | undefined,
  input: ContextSlotComposerInput,
): ComposedContextSlots | undefined {
  const cloned = cloneComposedContextSlots(cached);
  if (!cloned) return undefined;
  if (!cloned.rendered.includes(USER_SLOT_TOKEN)) return cloned;

  const userSlot = resolveUserSlotContent(input);
  if (!userSlot) {
    cloned.rendered = cloned.rendered.replace(slotBlock('turn.user_input', USER_SLOT_TOKEN), '').trim();
    cloned.slotIds = cloned.slotIds.filter((item) => item !== 'turn.user_input');
    cloned.trimmedSlotIds = cloned.trimmedSlotIds.filter((item) => item !== 'turn.user_input');
    return cloned;
  }

  cloned.rendered = cloned.rendered.replace(USER_SLOT_TOKEN, userSlot.content);
  cloned.trimmedSlotIds = cloned.trimmedSlotIds.filter((item) => item !== 'turn.user_input');
  if (userSlot.trimmed) {
    cloned.trimmedSlotIds.push('turn.user_input');
  }
  return cloned;
}

function resolveUserSlotContent(input: ContextSlotComposerInput): { content: string; trimmed: boolean } | undefined {
  let content = input.userInput.trim();
  if (content.length === 0) return undefined;

  const patches = parseSlotPatches(input.metadata?.contextSlots).filter((item) => item.id === 'turn.user_input');
  let maxChars: number | undefined = undefined;

  for (const patch of patches) {
    if (patch.mode === 'remove') return undefined;
    maxChars = patch.maxChars ?? maxChars;
    content = applyPatch(content, patch).trim();
  }

  if (content.length === 0) return undefined;

  const budgets = parseSlotBudgets(input.metadata?.contextSlotBudgets);
  const budget = maxChars ?? budgets['turn.user_input'] ?? DEFAULT_SLOT_BUDGETS['turn.user_input'];
  if (!budget || budget <= 0) {
    return { content, trimmed: false };
  }

  const trimmed = trimSlotContent('turn.user_input', content, budget);
  return { content: trimmed, trimmed: trimmed !== content };
}

function slotBlock(slotId: string, content: string): string {
  return `<slot id="${slotId}">\n${content}\n</slot>`;
}
