import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { logger } from '../../core/logger.js';
import type {
  CorrelationAppendRecord,
  CorrelationBindRecord,
  CorrelationFlowRecord,
} from './execution-update-types.js';

const log = logger.module('ExecutionUpdateCorrelation');

function randomId(len = 8): string {
  return Math.random().toString(36).slice(2, 2 + len);
}

function nowIso(): string {
  return new Date().toISOString();
}

function sessionAgentKey(sessionId: string, agentId: string): string {
  return `${sessionId.trim()}::${agentId.trim()}`;
}

export class ExecutionUpdateCorrelationStore {
  private readonly records = new Map<string, CorrelationFlowRecord>();
  private readonly sessionAgentFlowMap = new Map<string, string>();
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private readonly dir = path.join(FINGER_PATHS.runtime.dir, 'update-correlation');
  private readonly file = path.join(this.dir, 'correlation.jsonl');

  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initPromise = (async () => {
      await mkdir(this.dir, { recursive: true });
      try {
        const stream = createReadStream(this.file, { encoding: 'utf-8' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        for await (const line of rl) {
          const text = line.trim();
          if (!text) continue;
          try {
            const parsed = JSON.parse(text) as CorrelationAppendRecord | CorrelationBindRecord;
            if (parsed.op === 'upsert' && parsed.flow?.flowId) {
              this.records.set(parsed.flow.flowId, parsed.flow);
            }
            if (parsed.op === 'bind') {
              const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId.trim() : '';
              const agentId = typeof parsed.agentId === 'string' ? parsed.agentId.trim() : '';
              const flowId = typeof parsed.flowId === 'string' ? parsed.flowId.trim() : '';
              if (sessionId && agentId && flowId) {
                this.sessionAgentFlowMap.set(sessionAgentKey(sessionId, agentId), flowId);
              }
            }
          } catch {
            // ignore damaged line
          }
        }
        rl.close();
        stream.close();
      } catch {
        // first run/no file
      }
      this.ready = true;
      log.info('Correlation store initialized', {
        flowCount: this.records.size,
        file: this.file,
      });
    })();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async bindSessionAgentFlow(sessionId: string, agentId: string, flowId: string): Promise<void> {
    if (!sessionId.trim() || !agentId.trim() || !flowId.trim()) return;
    await this.init();
    const normalizedSessionId = sessionId.trim();
    const normalizedAgentId = agentId.trim();
    const normalizedFlowId = flowId.trim();
    this.sessionAgentFlowMap.set(sessionAgentKey(normalizedSessionId, normalizedAgentId), normalizedFlowId);
    await this.persistBinding({
      op: 'bind',
      ts: nowIso(),
      sessionId: normalizedSessionId,
      agentId: normalizedAgentId,
      flowId: normalizedFlowId,
    });
  }

  async resolveFlowBySessionAgent(sessionId: string, agentId: string): Promise<string | undefined> {
    await this.init();
    if (!sessionId.trim() || !agentId.trim()) return undefined;
    return this.sessionAgentFlowMap.get(sessionAgentKey(sessionId, agentId));
  }

  async upsertFlow(input: {
    flowId: string;
    taskId?: string;
    traceId?: string;
  }): Promise<CorrelationFlowRecord> {
    await this.init();
    const flowId = input.flowId.trim();
    const existing = this.records.get(flowId);
    const currentTs = nowIso();
    const next: CorrelationFlowRecord = existing
      ? {
          ...existing,
          updatedAt: currentTs,
          ...(typeof input.taskId === 'string' && input.taskId.trim().length > 0 ? { taskId: input.taskId.trim() } : {}),
          ...(typeof input.traceId === 'string' && input.traceId.trim().length > 0 ? { traceId: input.traceId.trim() } : {}),
        }
      : {
          flowId,
          traceId: input.traceId?.trim() || `trace-${Date.now().toString(36)}-${randomId(6)}`,
          ...(typeof input.taskId === 'string' && input.taskId.trim().length > 0 ? { taskId: input.taskId.trim() } : {}),
          latestSeq: 0,
          createdAt: currentTs,
          updatedAt: currentTs,
        };
    this.records.set(flowId, next);
    await this.persist(next);
    return next;
  }

  async nextSeq(flowId: string): Promise<{ seq: number; traceId: string; taskId?: string }> {
    await this.init();
    const normalized = flowId.trim();
    const current = this.records.get(normalized)
      ?? await this.upsertFlow({ flowId: normalized });
    const nextSeqValue = Math.max(0, Math.floor(current.latestSeq)) + 1;
    const nextRecord: CorrelationFlowRecord = {
      ...current,
      latestSeq: nextSeqValue,
      updatedAt: nowIso(),
    };
    this.records.set(normalized, nextRecord);
    await this.persist(nextRecord);
    return {
      seq: nextSeqValue,
      traceId: nextRecord.traceId,
      ...(nextRecord.taskId ? { taskId: nextRecord.taskId } : {}),
    };
  }

  private async persist(flow: CorrelationFlowRecord): Promise<void> {
    const appendRecord: CorrelationAppendRecord = {
      op: 'upsert',
      ts: nowIso(),
      flow,
    };
    await appendFile(this.file, JSON.stringify(appendRecord) + '\n', 'utf-8');
  }

  private async persistBinding(record: CorrelationBindRecord): Promise<void> {
    await this.init();
    await appendFile(this.file, JSON.stringify(record) + '\n', 'utf-8');
  }
}
