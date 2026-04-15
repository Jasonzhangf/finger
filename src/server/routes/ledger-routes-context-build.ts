import type { SessionMessage } from '../../orchestration/session-types.js';
import { estimateTokens } from '../../utils/token-counter.js';

type ContextZone = 'working_set' | 'historical_memory';

interface ContextBuildMessage {
  id: string;
  role: string;
  content: string;
  timestampIso: string;
  tokenCount: number;
  contextZone?: ContextZone;
}

interface SnapshotContextBuildSuccess {
  ok: true;
  totalTokens: number;
  memoryMdIncluded: boolean;
  taskBlockCount: number;
  filteredTaskBlockCount: number;
  buildTimestamp: string;
  metadata: {
    rawTaskBlockCount: number;
    timeWindowFilteredCount: number;
    budgetTruncatedCount: number;
    targetBudget: number;
    actualTokens: number;
    workingSetMessageCount: number;
    historicalMessageCount: number;
    workingSetTokens: number;
    historicalTokens: number;
  };
  messages: ContextBuildMessage[];
}

interface SnapshotContextBuildFailure {
  ok: false;
  error: string;
  messages: [];
}

export type SnapshotContextBuild = SnapshotContextBuildSuccess | SnapshotContextBuildFailure;

function readContextZone(message: SessionMessage): ContextZone | undefined {
  const zone = message.metadata?.contextZone;
  if (zone === 'working_set' || zone === 'historical_memory') {
    return zone;
  }
  return undefined;
}

export function buildSnapshotContextBuild(
  messages: SessionMessage[] | undefined,
  options: {
    targetBudget: number;
    buildTimestamp?: string;
  },
): SnapshotContextBuild {
  if (!Array.isArray(messages)) {
    return {
      ok: false,
      error: 'Session snapshot not found',
      messages: [],
    };
  }

  const buildTimestamp = options.buildTimestamp ?? new Date().toISOString();
  const mappedMessages: ContextBuildMessage[] = messages.map((message) => {
    const zone = readContextZone(message);
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      timestampIso: message.timestamp,
      tokenCount: estimateTokens(message.content),
      ...(zone ? { contextZone: zone } : {}),
    };
  });

  let totalTokens = 0;
  let workingSetMessageCount = 0;
  let historicalMessageCount = 0;
  let workingSetTokens = 0;
  let historicalTokens = 0;

  for (const message of mappedMessages) {
    totalTokens += message.tokenCount;
    if (message.contextZone === 'historical_memory') {
      historicalMessageCount += 1;
      historicalTokens += message.tokenCount;
      continue;
    }
    workingSetMessageCount += 1;
    workingSetTokens += message.tokenCount;
  }

  return {
    ok: true,
    totalTokens,
    memoryMdIncluded: false,
    taskBlockCount: mappedMessages.length,
    filteredTaskBlockCount: mappedMessages.length,
    buildTimestamp,
    metadata: {
      rawTaskBlockCount: mappedMessages.length,
      timeWindowFilteredCount: mappedMessages.length,
      budgetTruncatedCount: 0,
      targetBudget: Math.max(1, Math.floor(options.targetBudget)),
      actualTokens: totalTokens,
      workingSetMessageCount,
      historicalMessageCount,
      workingSetTokens,
      historicalTokens,
    },
    messages: mappedMessages,
  };
}
