export interface AskRequest {
  question: string;
  options?: string[];
  context?: string;
  agentId?: string;
  sessionId?: string;
  workflowId?: string;
  epicId?: string;
  timeoutMs?: number;
}

export interface PendingAsk {
  requestId: string;
  question: string;
  options?: string[];
  context?: string;
  agentId?: string;
  sessionId?: string;
  workflowId?: string;
  epicId?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface AskResolution {
  ok: boolean;
  requestId: string;
  answer?: string;
  selectedOption?: string;
  timedOut?: boolean;
  respondedAt: string;
}

interface PendingAskState extends PendingAsk {
  timer?: NodeJS.Timeout;
  resolveResult: (resolution: AskResolution) => void;
  settled: boolean;
}

export interface AskPendingFilter {
  requestId?: string;
  agentId?: string;
  sessionId?: string;
  workflowId?: string;
  epicId?: string;
}

function sanitizeOptions(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
  return options.length > 0 ? options : undefined;
}

function resolveSelectedOption(answer: string, options?: string[]): string | undefined {
  if (!options || options.length === 0) return undefined;
  const normalizedAnswer = answer.trim();
  if (!normalizedAnswer) return undefined;

  const asNumber = Number.parseInt(normalizedAnswer, 10);
  if (Number.isFinite(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return options[asNumber - 1];
  }

  const lower = normalizedAnswer.toLowerCase();
  const matched = options.find((item) => item.toLowerCase() === lower);
  return matched;
}

export class AskManager {
  private readonly pending = new Map<string, PendingAskState>();
  private readonly defaultTimeoutMs: number;

  constructor(defaultTimeoutMs: number = 600_000) {
    this.defaultTimeoutMs = Math.max(1_000, Math.floor(defaultTimeoutMs));
  }

  open(input: AskRequest): { pending: PendingAsk; result: Promise<AskResolution> } {
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (!question) {
      throw new Error('ask question is required');
    }

    const timeoutMsRaw = Number.isFinite(input.timeoutMs) ? Math.floor(input.timeoutMs as number) : this.defaultTimeoutMs;
    const timeoutMs = Math.max(1_000, timeoutMsRaw);
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + timeoutMs).toISOString();
    const requestId = `ask-${now}-${Math.random().toString(36).slice(2, 8)}`;

    let resolveResult!: (resolution: AskResolution) => void;
    const result = new Promise<AskResolution>((resolve) => {
      resolveResult = resolve;
    });

    const options = sanitizeOptions(input.options);
    const state: PendingAskState = {
      requestId,
      question,
      ...(options ? { options } : {}),
      ...(typeof input.context === 'string' && input.context.trim().length > 0 ? { context: input.context.trim() } : {}),
      ...(typeof input.agentId === 'string' && input.agentId.trim().length > 0 ? { agentId: input.agentId.trim() } : {}),
      ...(typeof input.sessionId === 'string' && input.sessionId.trim().length > 0 ? { sessionId: input.sessionId.trim() } : {}),
      ...(typeof input.workflowId === 'string' && input.workflowId.trim().length > 0 ? { workflowId: input.workflowId.trim() } : {}),
      ...(typeof input.epicId === 'string' && input.epicId.trim().length > 0 ? { epicId: input.epicId.trim() } : {}),
      createdAt,
      expiresAt,
      resolveResult,
      settled: false,
    };

    state.timer = setTimeout(() => {
      this.finalize(state.requestId, {
        ok: false,
        requestId: state.requestId,
        timedOut: true,
        respondedAt: new Date().toISOString(),
      });
    }, timeoutMs);

    this.pending.set(requestId, state);
    return {
      pending: this.toPending(state),
      result,
    };
  }

  listPending(filter?: AskPendingFilter): PendingAsk[] {
    const all = Array.from(this.pending.values())
      .map((item) => this.toPending(item))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    if (!filter) return all;

    return all.filter((item) => {
      if (filter.requestId && item.requestId !== filter.requestId) return false;
      if (filter.agentId && item.agentId !== filter.agentId) return false;
      if (filter.sessionId && item.sessionId !== filter.sessionId) return false;
      if (filter.workflowId && item.workflowId !== filter.workflowId) return false;
      if (filter.epicId && item.epicId !== filter.epicId) return false;
      return true;
    });
  }

  resolveByRequestId(requestId: string, answer: string): AskResolution | null {
    const state = this.pending.get(requestId);
    if (!state) return null;
    return this.finalize(state.requestId, this.buildAnswerResolution(state, answer));
  }

  resolveOldestByScope(scope: AskPendingFilter, answer: string): AskResolution | null {
    const target = this.listPending(scope)[0];
    if (!target) return null;
    return this.resolveByRequestId(target.requestId, answer);
  }

  private buildAnswerResolution(state: PendingAskState, answer: string): AskResolution {
    const normalizedAnswer = String(answer ?? '').trim();
    return {
      ok: normalizedAnswer.length > 0,
      requestId: state.requestId,
      ...(normalizedAnswer.length > 0 ? { answer: normalizedAnswer } : {}),
      ...(resolveSelectedOption(normalizedAnswer, state.options) ? { selectedOption: resolveSelectedOption(normalizedAnswer, state.options) } : {}),
      respondedAt: new Date().toISOString(),
    };
  }

  private finalize(requestId: string, resolution: AskResolution): AskResolution {
    const state = this.pending.get(requestId);
    if (!state || state.settled) return resolution;
    state.settled = true;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.pending.delete(requestId);
    state.resolveResult(resolution);
    return resolution;
  }

  private toPending(item: PendingAskState): PendingAsk {
    return {
      requestId: item.requestId,
      question: item.question,
      ...(item.options ? { options: [...item.options] } : {}),
      ...(item.context ? { context: item.context } : {}),
      ...(item.agentId ? { agentId: item.agentId } : {}),
      ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      ...(item.workflowId ? { workflowId: item.workflowId } : {}),
      ...(item.epicId ? { epicId: item.epicId } : {}),
      createdAt: item.createdAt,
      ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
    };
  }
}
