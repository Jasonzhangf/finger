import fs from 'fs';
import path from 'path';
import { FINGER_PATHS, ensureDir } from '../../core/finger-paths.js';
import { logger } from '../../core/logger.js';
import type { AgentDispatchRequest } from './agent-runtime/types.js';

const log = logger.module('DailySummaryScheduler');

export interface DailySummaryDispatchResult {
  dispatchId: string;
  status: string;
  error?: string;
}

export interface DailySummarySchedulerDeps {
  dispatchTaskToAgent: (input: AgentDispatchRequest) => Promise<DailySummaryDispatchResult>;
}

export interface DailySummaryTaskState {
  lastSummarySlot: number;
  lastRunAt?: string;
  lastDispatchAt?: string;
  lastLedgerPath?: string;
}

export interface DailySummaryTaskSpec {
  key: 'system' | 'project';
  targetAgentId: string;
  source: string;
  title: string;
  outputFileBuilder: () => string;
  stateFile: string;
  resolveLedgerPath: () => string | null;
}

export interface DailySummarySchedulerOptions {
  enabled: boolean;
  tickMs: number;
  windowStartHour: number;
  windowEndHour: number;
  runtimeLogFile: string;
  maxSlotPerChunk: number;
}

const DEFAULT_OPTIONS: DailySummarySchedulerOptions = {
  enabled: false,
  tickMs: 60_000,
  windowStartHour: 23,
  windowEndHour: 23,
  runtimeLogFile: path.join(FINGER_PATHS.logs.dir, 'daily_summary_builtin.log'),
  maxSlotPerChunk: 200,
};

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'n') return false;
  return fallback;
}

function parseIntegerEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function createDailySummarySchedulerOptionsFromEnv(): DailySummarySchedulerOptions {
  return {
    enabled: parseBooleanEnv(process.env.FINGER_DAILY_SUMMARY_ENABLED, DEFAULT_OPTIONS.enabled),
    tickMs: parseIntegerEnv(process.env.FINGER_DAILY_SUMMARY_TICK_MS, DEFAULT_OPTIONS.tickMs, 15_000, 3_600_000),
    windowStartHour: parseIntegerEnv(process.env.FINGER_DAILY_SUMMARY_WINDOW_START_HOUR, DEFAULT_OPTIONS.windowStartHour, 0, 23),
    windowEndHour: parseIntegerEnv(process.env.FINGER_DAILY_SUMMARY_WINDOW_END_HOUR, DEFAULT_OPTIONS.windowEndHour, 0, 23),
    runtimeLogFile: process.env.FINGER_DAILY_SUMMARY_LOG_FILE?.trim() || DEFAULT_OPTIONS.runtimeLogFile,
    maxSlotPerChunk: parseIntegerEnv(process.env.FINGER_DAILY_SUMMARY_MAX_SLOT_CHUNK, DEFAULT_OPTIONS.maxSlotPerChunk, 50, 1000),
  };
}

export function isHourInWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour <= endHour) return hour >= startHour && hour <= endHour;
  return hour >= startHour || hour <= endHour;
}

export function calculateDeltaSlots(totalSlots: number, lastSummarySlot: number): { lastSummarySlot: number; deltaSlots: number; reset: boolean } {
  if (!Number.isFinite(totalSlots) || totalSlots < 0) return { lastSummarySlot: 0, deltaSlots: 0, reset: true };
  const normalizedLast = Number.isFinite(lastSummarySlot) && lastSummarySlot > 0 ? Math.floor(lastSummarySlot) : 0;
  if (totalSlots < normalizedLast) {
    return { lastSummarySlot: 0, deltaSlots: totalSlots, reset: true };
  }
  return { lastSummarySlot: normalizedLast, deltaSlots: totalSlots - normalizedLast, reset: false };
}

function countJsonlLines(filePath: string): number {
  const raw = fs.readFileSync(filePath);
  if (raw.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === 0x0a) lines += 1;
  }
  if (raw[raw.length - 1] !== 0x0a) lines += 1;
  return lines;
}

function safeReadJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath: string, data: unknown): boolean {
  try {
    const dir = path.dirname(filePath);
    ensureDir(dir);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function formatDateLocal(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function createLatestLedgerResolver(agentId: string): () => string | null {
  const sessionsDir = FINGER_PATHS.sessions.dir;
  const systemGlobal = path.join(
    FINGER_PATHS.sessions.dir,
    'hb-session-finger-system-agent-global',
    agentId,
    'main',
    'context-ledger.jsonl',
  );
  let cachedPath = '';
  return () => {
    if (cachedPath && fs.existsSync(cachedPath)) return cachedPath;
    if (agentId === 'finger-system-agent' && fs.existsSync(systemGlobal)) {
      cachedPath = systemGlobal;
      return cachedPath;
    }
    if (!fs.existsSync(sessionsDir)) return null;
    let latestPath = '';
    let latestMtime = 0;
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sessionName = entry.name;
      if (sessionName.startsWith('transient-')) continue;
      const candidate = path.join(sessionsDir, sessionName, agentId, 'main', 'context-ledger.jsonl');
      if (!fs.existsSync(candidate)) continue;
      if (candidate.includes(`${path.sep}workspace${path.sep}memory${path.sep}`)) continue;
      try {
        const stat = fs.statSync(candidate);
        const mtime = stat.mtimeMs;
        if (mtime > latestMtime) {
          latestMtime = mtime;
          latestPath = candidate;
        }
      } catch {
        // skip
      }
    }
    if (latestPath) cachedPath = latestPath;
    return latestPath || null;
  };
}

function createTaskSpecs(): DailySummaryTaskSpec[] {
  const runtimeStateDir = path.join(FINGER_PATHS.runtime.dir, 'daily-summary');
  return [
    {
      key: 'system',
      targetAgentId: 'finger-system-agent',
      source: 'daily-analysis-builtin',
      title: '每日系统分析',
      outputFileBuilder: () => path.join(FINGER_PATHS.home, 'system', 'MEMORY.md'),
      stateFile: path.join(runtimeStateDir, 'system-state.json'),
      resolveLedgerPath: createLatestLedgerResolver('finger-system-agent'),
    },
    {
      key: 'project',
      targetAgentId: 'finger-project-agent',
      source: 'daily-project-analysis-builtin',
      title: '每日项目分析',
      outputFileBuilder: () => path.join(FINGER_PATHS.home, 'USER.md'),
      stateFile: path.join(runtimeStateDir, 'project-state.json'),
      resolveLedgerPath: createLatestLedgerResolver('finger-project-agent'),
    },
  ];
}

function buildChunkedTaskMessage(
  spec: DailySummaryTaskSpec,
  currentDate: string,
  slotStart: number,
  slotEnd: number,
  chunkIndex: number,
  totalChunks: number,
  outputPath: string,
): string {
  const lines = [
    `\${spec.title}（记忆进化，第 \${chunkIndex}/\${totalChunks} 块）`,
    `date=\${currentDate}`,
    `ledger=\${spec.resolveLedgerPath()}`,
    `slot_start=\${slotStart}`,
    `slot_end=\${slotEnd}`,
    `chunk=\${chunkIndex}/\${totalChunks}`,
    `memory_file=\${outputPath}`,
    '',
    '【记忆进化任务】',
    '目标：基于当日 ledger 行为，渐进式更新记忆文件内容',
    '',
    '步骤：',
    '1) 先读取 memory_file 现有全部内容（必须先读）',
    '2) 用 context_ledger.digest 读当日 ledger 指定区间摘要',
    '3) 分析当日行为中的新发现/错误模式/成功经验/过时信息',
    '4) 对 memory_file 进行渐进式修改：修正过时信息、添加新发现、强化重复规则',
    '5) 写入修改后的完整内容（覆盖式写入，保留历史精华）',
    '',
    '注意：禁止简单追加日志，必须进行内容进化',
  ];
  if (totalChunks > 1) {
    lines.push(`6) 这是第 \${chunkIndex}/\${totalChunks} 块，完成后报告 "Chunk \${chunkIndex}/\${totalChunks} done"`);
  }
  return lines.join('\n');
}

export class DailySummaryScheduler {
  private readonly deps: DailySummarySchedulerDeps;
  private readonly options: DailySummarySchedulerOptions;
  private readonly taskSpecs: DailySummaryTaskSpec[];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    deps: DailySummarySchedulerDeps,
    options: Partial<DailySummarySchedulerOptions> = {},
    taskSpecs: DailySummaryTaskSpec[] = createTaskSpecs(),
  ) {
    this.deps = deps;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.taskSpecs = taskSpecs;
  }

  start(): void {
    if (!this.options.enabled) {
      log.info('Daily summary scheduler disabled by config');
      return;
    }
    if (this.timer) return;

    const now = new Date();
    const hour = now.getHours();
    const inWindow = isHourInWindow(hour, this.options.windowStartHour, this.options.windowEndHour);

    if (inWindow) {
      this.logRuntime('Daily summary scheduler started (in window)', {
        tickMs: this.options.tickMs,
        windowStartHour: this.options.windowStartHour,
        windowEndHour: this.options.windowEndHour,
        taskCount: this.taskSpecs.length,
        currentHour: hour,
      });
      void this.tick();
    } else {
      log.debug('Daily summary scheduler ready (outside window)', {
        currentHour: hour,
        windowStartHour: this.options.windowStartHour,
        windowEndHour: this.options.windowEndHour,
      });
    }

    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.logRuntime('Daily summary scheduler stopped');
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const hour = now.getHours();
      const inWindow = isHourInWindow(hour, this.options.windowStartHour, this.options.windowEndHour);
      if (!inWindow) return;
      for (const spec of this.taskSpecs) {
        await this.processTask(spec, now);
      }
    } catch (error) {
      this.logRuntime('Daily summary scheduler tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  private async processTask(spec: DailySummaryTaskSpec, now: Date): Promise<void> {
    const ledgerPath = spec.resolveLedgerPath();
    if (!ledgerPath) {
      this.logRuntime('Skip daily summary task: ledger not found', { task: spec.key, target: spec.targetAgentId });
      return;
    }
    if (!fs.existsSync(ledgerPath)) {
      this.logRuntime('Skip daily summary task: ledger path missing', { task: spec.key, ledgerPath });
      return;
    }
    const totalSlots = countJsonlLines(ledgerPath);
    const prior = safeReadJson<DailySummaryTaskState>(spec.stateFile, { lastSummarySlot: 0 });
    const baseline = calculateDeltaSlots(totalSlots, prior.lastSummarySlot);
    const currentDate = formatDateLocal(now);

    if (baseline.reset) {
      this.logRuntime('Ledger slot baseline reset (possible rotation)', {
        task: spec.key,
        target: spec.targetAgentId,
        totalSlots,
        previousLastSummarySlot: prior.lastSummarySlot,
      });
    }

    if (baseline.deltaSlots <= 0) {
      const nextState: DailySummaryTaskState = {
        ...prior,
        lastSummarySlot: totalSlots,
        lastRunAt: now.toISOString(),
        lastLedgerPath: ledgerPath,
      };
      safeWriteJson(spec.stateFile, nextState);
      this.logRuntime('Skip daily summary dispatch: no new slots', {
        task: spec.key,
        target: spec.targetAgentId,
        totalSlots,
        lastSummarySlot: baseline.lastSummarySlot,
        deltaSlots: baseline.deltaSlots,
      });
      return;
    }

    const outputPath = spec.outputFileBuilder();
    ensureDir(path.dirname(outputPath));

    const maxPerChunk = this.options.maxSlotPerChunk;
    const totalChunks = Math.ceil(baseline.deltaSlots / maxPerChunk);
    const dispatchedChunks: number[] = [];

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      const chunkStart = prior.lastSummarySlot + 1 + chunkIdx * maxPerChunk;
      const chunkEnd = Math.min(chunkStart + maxPerChunk - 1, totalSlots);

      const taskMessage = buildChunkedTaskMessage(
        spec,
        currentDate,
        chunkStart,
        chunkEnd,
        chunkIdx + 1,
        totalChunks,
        outputPath,
      );

      try {
        const dispatchResult = await this.deps.dispatchTaskToAgent({
          sourceAgentId: 'system-daily-summary',
          targetAgentId: spec.targetAgentId,
          task: taskMessage,
          blocking: false,
          queueOnBusy: true,
          maxQueueWaitMs: 0,
          metadata: {
            source: spec.source,
            sourceType: 'cron',
            category: 'task',
            dailySummary: true,
            chunkIndex: chunkIdx + 1,
            totalChunks,
            slotStart: chunkStart,
            slotEnd: chunkEnd,
            ledgerPath,
            outputFile: outputPath,
          },
        });

        const accepted = ['queued', 'completed', 'accepted', 'running', 'processing'].includes(dispatchResult.status);
        if (!accepted) {
          this.logRuntime('Daily summary chunk dispatch failed', {
            task: spec.key,
            chunk: `\${chunkIdx + 1}/\${totalChunks}`,
            target: spec.targetAgentId,
            status: dispatchResult.status,
            error: dispatchResult.error,
          });
          continue;
        }

        dispatchedChunks.push(chunkIdx + 1);
        this.logRuntime('Daily summary chunk dispatched', {
          task: spec.key,
          chunk: `\${chunkIdx + 1}/\${totalChunks}`,
          target: spec.targetAgentId,
          dispatchId: dispatchResult.dispatchId,
          status: dispatchResult.status,
          slotStart: chunkStart,
          slotEnd: chunkEnd,
        });
      } catch (error) {
        this.logRuntime('Daily summary chunk dispatch exception', {
          task: spec.key,
          chunk: `\${chunkIdx + 1}/\${totalChunks}`,
          target: spec.targetAgentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (dispatchedChunks.length > 0) {
      const nextState: DailySummaryTaskState = {
        ...prior,
        lastSummarySlot: totalSlots,
        lastRunAt: now.toISOString(),
        lastDispatchAt: now.toISOString(),
        lastLedgerPath: ledgerPath,
      };
      safeWriteJson(spec.stateFile, nextState);
      this.logRuntime('Daily summary all chunks dispatched', {
        task: spec.key,
        target: spec.targetAgentId,
        dispatchedChunks: dispatchedChunks.length,
        totalChunks,
        totalSlots,
      });
    }
  }

  private logRuntime(message: string, data?: Record<string, unknown>): void {
    const logPath = this.options.runtimeLogFile;
    const line = `[${new Date().toISOString()}] ${message}${data ? " | " + JSON.stringify(data) : ""}
`;
    try {
      const dir = path.dirname(logPath);
      ensureDir(dir);
      fs.appendFileSync(logPath, line);
    } catch {
      // best effort
    }
    log.info(message, data);
  }
}
