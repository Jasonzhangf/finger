import { promises as fs, watch, type FSWatcher } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { logger } from '../../core/logger.js';
import { appendHeartbeatEventSync, type HeartbeatEventType, type HeartbeatEventSeverity } from './heartbeat-ledger.js';
import { extractAgentStatusFromRuntimeView } from '../../core/agent-runtime-status.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { heartbeatMailbox } from '../../server/modules/heartbeat-mailbox.js';
import { listAgents } from '../../agents/finger-system-agent/registry.js';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { SessionControlPlaneStore } from '../../runtime/session-control-plane.js';
import { SYSTEM_PROJECT_PATH } from '../../agents/finger-system-agent/index.js';
import { buildHeartbeatEnvelopeWithInject, type MailboxEnvelope } from '../../server/modules/mailbox-envelope.js';
import { listReviewRoutes } from '../../agents/finger-system-agent/review-route-registry.js';
import { removeReviewRoute } from '../../agents/finger-system-agent/review-route-registry.js';
import {
  applyExecutionLifecycleTransition,
  getExecutionLifecycleState,
  parseExecutionLifecycleState,
  type ExecutionLifecycleState,
} from '../../server/modules/execution-lifecycle.js';
import {
  resolveProjectPath,
  promptMailboxChecks,
} from '../../server/modules/heartbeat-helpers.js';
import type { ProgressDeliveryPolicy } from '../../common/progress-delivery-policy.js';
import { normalizeProgressDeliveryPolicy } from '../../common/progress-delivery-policy.js';
import { FINGER_PROJECT_AGENT_ID, FINGER_SYSTEM_AGENT_ID } from '../../agents/finger-general/finger-general-module.js';
import {
  acquireProjectDreamLock,
  releaseProjectDreamLock,
  DEFAULT_PROJECT_DREAM_LOCK_TTL_MS,
} from '../../core/project-dream-lock.js';
import {
  parseProjectTaskState,
  isProjectTaskStateActive,
  mergeProjectTaskState,
  parseDelegatedProjectTaskRegistry,
} from '../../common/project-task-state.js';
import { applyProjectStatusGatewayPatch } from '../../server/modules/project-status-gateway.js';
import { writeFileAtomic } from '../../core/atomic-write.js';

const log = logger.module('HeartbeatScheduler');

type DispatchMode = 'mailbox' | 'dispatch';

interface HeartbeatTaskConfig {
  intervalMs?: number;
  enabled?: boolean;
  dispatch?: DispatchMode;
  prompt?: string;
  mailboxCheckIntervalMs?: number;
  progressDelivery?: ProgressDeliveryPolicy;
}

interface HeartbeatProjectConfig extends HeartbeatTaskConfig {
  path?: string;
  realPath?: string;
  tasks?: Record<string, HeartbeatTaskConfig>;
}

interface HeartbeatConfig {
  global?: HeartbeatTaskConfig;
  projects?: Record<string, HeartbeatProjectConfig>;
  nightlyDream?: NightlyDreamConfig;
  dailySystemReview?: DailySystemReviewConfig;
}

interface NightlyDreamConfig {
  enabled?: boolean;
  windowStartHour?: number;
  windowEndHour?: number;
  maxProjectsPerRun?: number;
  includeMonitoredProjects?: boolean;
  includeTodayActiveProjects?: boolean;
  maxQueueWaitMs?: number;
  lockTtlMs?: number;
  maxDispatchRetries?: number;
  retryBackoffMs?: number;
  progressDelivery?: ProgressDeliveryPolicy;
}

interface DailySystemReviewConfig {
  enabled?: boolean;
  windowStartHour?: number;
  windowEndHour?: number;
  maxQueueWaitMs?: number;
  appendOnly?: boolean;
  backup?: {
    enabled?: boolean;
    obsidianDir?: string;
    localDir?: string;
  };
  progressDelivery?: ProgressDeliveryPolicy;
}

interface LoadConfigResult {
  ok: boolean;
  config?: HeartbeatConfig;
  error?: string;
  created?: boolean;
}

const DEFAULT_TICK_MS = 5 * 60_000;
const DEFAULT_TASK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAILBOX_CHECK_INTERVAL_MS = 5 * 60_000;

// Heartbeat state machine configuration
const HEARTBEAT_STATE_CONFIG = {
  mailboxPendingThreshold: 50,           // DEGRADED threshold
  mailboxPendingAgeMs: 3600000,           // DEGRADED threshold (1 hour)
  mailboxPendingRecoveryThreshold: 20,    // RUNNING recovery threshold
  mailboxProcessingAgeMs: 1800000,        // Stuck threshold (30 minutes)
  degradedToPausedThreshold: 100,         // PAUSED threshold
  degradedDurationThresholdMs: 1800000,   // PAUSED threshold (30 minutes)
  autoResumeAfterMs: 600000,              // PAUSED auto-resume (10 minutes, optional)
};

type HeartbeatState = 'RUNNING' | 'DEGRADED' | 'PAUSED' | 'STOPPED';

interface HeartbeatStateContext {
  state: HeartbeatState;
  degradedAt?: number;           // Timestamp when entered DEGRADED
  degradedReason?: string;       // Reason for DEGRADED
  pausedAt?: number;             // Timestamp when entered PAUSED
  pausedReason?: string;         // Reason for PAUSED
  stoppedAt?: number;            // Timestamp when entered STOPPED
  stoppedReason?: string;        // Reason for STOPPED
}
const DEFAULT_NIGHTLY_DREAM_WINDOW_START_HOUR = 0;
const DEFAULT_NIGHTLY_DREAM_WINDOW_END_HOUR = 7;
const DEFAULT_NIGHTLY_DREAM_MAX_PROJECTS_PER_RUN = 20;
const DEFAULT_NIGHTLY_DREAM_MAX_QUEUE_WAIT_MS = 30_000;
const DEFAULT_NIGHTLY_DREAM_MAX_DISPATCH_RETRIES = 1;
const DEFAULT_NIGHTLY_DREAM_RETRY_BACKOFF_MS = 1_000;
const DEFAULT_DAILY_SYSTEM_REVIEW_WINDOW_START_HOUR = 0;
const DEFAULT_DAILY_SYSTEM_REVIEW_WINDOW_END_HOUR = 7;
const DEFAULT_DAILY_SYSTEM_REVIEW_MAX_QUEUE_WAIT_MS = 30_000;
const DEFAULT_DAILY_SYSTEM_REVIEW_BACKUP_LOCAL_DIR = path.join(
  FINGER_PATHS.home,
  'system',
  'backup',
  'daily-review',
);
const DEFAULT_DAILY_SYSTEM_REVIEW_BACKUP_OBSIDIAN_DIR = '~/Documents/Obsidian/finger日志/backups/daily-review';
const CONFIG_PATH = path.join(FINGER_PATHS.runtime.schedulesDir, 'heartbeat-config.jsonl');
const TASK_PATH = path.join(FINGER_PATHS.runtime.schedulesDir, 'heartbeat-tasks.jsonl');
const RUNTIME_STATE_PATH = path.join(FINGER_PATHS.runtime.schedulesDir, 'heartbeat-runtime-state.json');
const CONFIG_RELOAD_DEBOUNCE_MS = 1000;
const SYSTEM_AGENT_ID = 'finger-system-agent';
const DEFAULT_SCHEDULED_PROGRESS_DELIVERY = normalizeProgressDeliveryPolicy({ mode: 'result_only' });
const DEFAULT_NIGHTLY_DREAM_PROGRESS_DELIVERY = normalizeProgressDeliveryPolicy({ mode: 'result_only' });
const HEARTBEAT_CONTROL_SESSION_PREFIX = 'hb-session';
const ACTIVE_LIFECYCLE_STAGES = new Set([
  'received',
  'session_bound',
  'dispatching',
  'running',
  'waiting_tool',
  'waiting_model',
  'retrying',
  'interrupted',
]);
const HEARTBEAT_IDLE_GUARD_AGENT_IDS = [
  SYSTEM_AGENT_ID,
  FINGER_PROJECT_AGENT_ID,
  FINGER_SYSTEM_AGENT_ID,
];
const HEARTBEAT_IDLE_GUARD_LOG_THROTTLE_MS = 60_000;
const PROJECT_RECOVERY_ACTIVE_MAX_AGE_MS = 45 * 60_000;
const HEARTBEAT_STEP_TIMEOUT_MS = 45_000;

function normalizeProjectPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function sanitizeSessionKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function describeWatcherError(error: unknown): { message: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { message: error.message, ...(code ? { code } : {}) };
  }
  return { message: String(error) };
}

function normalizeDailyReviewObsidianDir(rawValue: string | undefined): { value?: string; migrated: boolean } {
  if (typeof rawValue !== 'string') return { value: undefined, migrated: false };
  const trimmed = rawValue.trim();
  if (!trimmed) return { value: undefined, migrated: false };
  // Legacy sample path in docs used ObsidianVault (wrong on current deployments).
  if (trimmed.includes('/Documents/ObsidianVault/')) {
    return { value: DEFAULT_DAILY_SYSTEM_REVIEW_BACKUP_OBSIDIAN_DIR, migrated: true };
  }
  // Normalize explicit absolute home path to "~/" style for config consistency.
  const homePrefix = `${homedir()}/`;
  if (trimmed.startsWith(homePrefix)) {
    return { value: `~/${trimmed.slice(homePrefix.length)}`, migrated: false };
  }
  return { value: trimmed, migrated: false };
}

async function readJsonlHeartbeatConfig(configPath: string): Promise<HeartbeatConfig> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) {
      return { global: { intervalMs: DEFAULT_TASK_INTERVAL_MS, enabled: true, dispatch: 'mailbox' }, projects: {} };
    }

    let latestConfig: HeartbeatConfig | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid heartbeat config JSONL at line ${i + 1}: ${detail}`);
      }
      const record = parsed as { type?: unknown; config?: unknown };
      if (record?.type === 'heartbeat_config' && record.config && typeof record.config === 'object') {
        latestConfig = record.config as HeartbeatConfig;
      }
    }

    if (latestConfig) return latestConfig;
    throw new Error('Heartbeat config file exists but contains no heartbeat_config records');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { global: { intervalMs: DEFAULT_TASK_INTERVAL_MS, enabled: true, dispatch: 'mailbox' }, projects: {} };
    }
    throw error;
  }
}

interface JsonlTaskRecord {
  ts: string;
  type: string;
  action: string;
  task: { text: string; section?: string; status?: string };
  batch?: Array<{ text: string; section?: string; status?: string }>;
}

interface HeartbeatRuntimeState {
  lastRun?: Record<string, number>;
  lastMailboxPromptAt?: Record<string, number>;
  mailboxPromptDeferredByAgent?: string[];
  lastNightlyDreamByProject?: Record<string, string>;
  nightlyDreamDispatchState?: Record<string, NightlyDreamDispatchState>;
  lastDailySystemReviewDate?: string;
  dailySystemReviewDispatchState?: DailySystemReviewDispatchState;
  heartbeatState?: HeartbeatState;
  heartbeatStateContext?: HeartbeatStateContext;
  heartbeatStateChangedAt?: number;
}

interface NightlyDreamDispatchState {
  date: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'unknown';
  updatedAt: number;
  projectId: string;
  projectPath: string;
  sessionId?: string;
  source: string;
  runId?: string;
  note?: string;
}

interface DailySystemReviewDispatchState {
  date: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'unknown';
  updatedAt: number;
  sessionId?: string;
  source: string;
  runId?: string;
  appendOnly?: boolean;
  backup?: {
    enabled: boolean;
    localDir: string;
    obsidianDir?: string;
  };
  baseline?: Array<{
    name: string;
    targetPath: string;
    existed: boolean;
    snapshotPath?: string;
  }>;
  note?: string;
}

async function readJsonlTasks(): Promise<string[]> {
  try {
    const raw = await fs.readFile(TASK_PATH, 'utf-8');
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const byText = new Map<string, 'pending' | 'completed'>();
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as JsonlTaskRecord;
        if (rec.type !== 'heartbeat_task') continue;
        if (rec.action === 'batch_add' && Array.isArray(rec.batch)) {
          for (const item of rec.batch) {
            const text = (item.text ?? '').trim();
            if (text && item.status !== 'completed') byText.set(text, 'pending');
          }
          continue;
        }
        if (rec.action === 'batch_complete' && Array.isArray(rec.batch)) {
          for (const item of rec.batch) { const t = (item.text ?? '').trim(); if (t) byText.set(t, 'completed'); }
          continue;
        }
        if (rec.action === 'batch_remove' && Array.isArray(rec.batch)) {
          for (const item of rec.batch) { const t = (item.text ?? '').trim(); if (t) byText.delete(t); }
          continue;
        }
        const text = (rec.task?.text ?? '').trim();
        if (!text) continue;
        if (rec.action === 'remove') { byText.delete(text); continue; }
        if (rec.action === 'add') { byText.set(text, rec.task?.status === 'completed' ? 'completed' : 'pending'); continue; }
        if (rec.action === 'complete') { byText.set(text, 'completed'); continue; }
      } catch { /* skip */ }
    }
    return Array.from(byText.entries()).filter(([, s]) => s === 'pending').map(([t]) => t);
  } catch { return []; }
}

function buildHeartbeatPrompt(pendingTasks: string[]): string {
  if (pendingTasks.length === 0) return '';
  const taskLines = pendingTasks.map((text, i) => `${i + 1}. ${text}`).join('\n');
  return [
    '# Heartbeat Check', '',
    '当前待办任务：', taskLines, '',
    '处理规则：',
    '1. 使用 heartbeat.completeTask 标记已完成的任务。',
    '2. 无法处理的任务保持现状，等待下一轮。',
    '3. 完成后用 heartbeat.listTasks 确认剩余任务。',
  ].join('\n');
}

export class HeartbeatScheduler {
  private timer: NodeJS.Timeout | null = null;
  private autoResumeTimer: NodeJS.Timeout | null = null;
  private configWatcher: FSWatcher | null = null;
  private config: HeartbeatConfig = {};
  private lastConfigReloadAt = 0;
  private lastRun: Map<string, number> = new Map();
  private lastMailboxPromptAt: Map<string, number> = new Map();
  private mailboxPromptDeferredByAgent: Set<string> = new Set();
  private lastNightlyDreamByProject: Map<string, string> = new Map();
  private nightlyDreamDispatchState: Map<string, NightlyDreamDispatchState> = new Map();
  private lastDailySystemReviewDate: string | null = null;
  private dailySystemReviewDispatchState: DailySystemReviewDispatchState | null = null;
  private ticking = false;
  private idleGuardBlocked = false;
  private idleGuardLastLoggedAt = 0;
  private idleGuardLastReason = '';

    private heartbeatState: HeartbeatState = 'RUNNING';
  private heartbeatStateContext: HeartbeatStateContext = { state: 'RUNNING' };
  private heartbeatStateChangedAt = 0;

constructor(private deps: AgentRuntimeDeps) {}

  async start(): Promise<void> {
    await this.loadConfig();
    this.ensureDefaultConfig();
    await this.loadRuntimeState();
    this.watchConfig();
    if (!this.timer) {

      // Check if any nightly/daily tasks are in window before immediate tick
      const now = new Date();
      const hour = now.getHours();
      const nightlyCfg = this.resolveNightlyDreamConfig();
      const dailyCfg = this.resolveDailySystemReviewConfig();
      const inNightlyWindow = nightlyCfg.enabled && this.isHourInWindow(hour, nightlyCfg.windowStartHour, nightlyCfg.windowEndHour);
      const inDailyWindow = dailyCfg.enabled && this.isHourInWindow(hour, dailyCfg.windowStartHour, dailyCfg.windowEndHour);
      
      if (inNightlyWindow || inDailyWindow) {
        log.info('[HeartbeatScheduler] Started (in task window)', {
          tickMs: DEFAULT_TICK_MS,
          currentHour: hour,
          inNightlyWindow,
          inDailyWindow,
        });
        this.armTick(0); // Immediate tick when in window
      } else {
        log.debug('[HeartbeatScheduler] Ready (outside task windows)', {
          tickMs: DEFAULT_TICK_MS,
          currentHour: hour,
          nightlyWindow: `${nightlyCfg.windowStartHour}-${nightlyCfg.windowEndHour}`,
          dailyWindow: `${dailyCfg.windowStartHour}-${dailyCfg.windowEndHour}`,
        });
        this.armTick(DEFAULT_TICK_MS); // Normal tick delay
      }
    }
  }

  stop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.configWatcher) { this.configWatcher.close(); this.configWatcher = null; }
  }

  private async loadConfig(): Promise<LoadConfigResult> {
    try {
      await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
      const exists = await fs.access(CONFIG_PATH).then(() => true).catch(() => false);
      if (!exists) {
        const defaultConfig: HeartbeatConfig = {
          global: { intervalMs: DEFAULT_TASK_INTERVAL_MS, enabled: true, dispatch: 'mailbox' },
          projects: {},
          nightlyDream: {
            enabled: true,
            windowStartHour: DEFAULT_NIGHTLY_DREAM_WINDOW_START_HOUR,
            windowEndHour: DEFAULT_NIGHTLY_DREAM_WINDOW_END_HOUR,
            includeMonitoredProjects: true,
            includeTodayActiveProjects: true,
            maxProjectsPerRun: DEFAULT_NIGHTLY_DREAM_MAX_PROJECTS_PER_RUN,
            maxQueueWaitMs: DEFAULT_NIGHTLY_DREAM_MAX_QUEUE_WAIT_MS,
            progressDelivery: DEFAULT_NIGHTLY_DREAM_PROGRESS_DELIVERY ?? undefined,
          },
          dailySystemReview: {
            enabled: true,
            windowStartHour: DEFAULT_DAILY_SYSTEM_REVIEW_WINDOW_START_HOUR,
            windowEndHour: DEFAULT_DAILY_SYSTEM_REVIEW_WINDOW_END_HOUR,
            maxQueueWaitMs: DEFAULT_DAILY_SYSTEM_REVIEW_MAX_QUEUE_WAIT_MS,
            appendOnly: true,
            backup: {
              enabled: false,
              localDir: DEFAULT_DAILY_SYSTEM_REVIEW_BACKUP_LOCAL_DIR,
            },
            progressDelivery: DEFAULT_SCHEDULED_PROGRESS_DELIVERY ?? undefined,
          },
        };
        await fs.appendFile(CONFIG_PATH,
          `${JSON.stringify({ ts: new Date().toISOString(), type: 'heartbeat_config', config: defaultConfig })}\n`, 'utf-8');
        this.config = defaultConfig;
        log.info('[HeartbeatScheduler] Default config created');
        return { ok: true, config: defaultConfig, created: true };
      }
      this.config = await readJsonlHeartbeatConfig(CONFIG_PATH);
      if (!this.config.nightlyDream) {
        this.config.nightlyDream = {
          enabled: true,
          windowStartHour: DEFAULT_NIGHTLY_DREAM_WINDOW_START_HOUR,
          windowEndHour: DEFAULT_NIGHTLY_DREAM_WINDOW_END_HOUR,
          includeMonitoredProjects: true,
          includeTodayActiveProjects: true,
          maxProjectsPerRun: DEFAULT_NIGHTLY_DREAM_MAX_PROJECTS_PER_RUN,
          maxQueueWaitMs: DEFAULT_NIGHTLY_DREAM_MAX_QUEUE_WAIT_MS,
          progressDelivery: DEFAULT_NIGHTLY_DREAM_PROGRESS_DELIVERY ?? undefined,
        };
      }
      if (!this.config.dailySystemReview) {
        this.config.dailySystemReview = {
          enabled: true,
          windowStartHour: DEFAULT_DAILY_SYSTEM_REVIEW_WINDOW_START_HOUR,
          windowEndHour: DEFAULT_DAILY_SYSTEM_REVIEW_WINDOW_END_HOUR,
          maxQueueWaitMs: DEFAULT_DAILY_SYSTEM_REVIEW_MAX_QUEUE_WAIT_MS,
          appendOnly: true,
          backup: {
            enabled: false,
            localDir: DEFAULT_DAILY_SYSTEM_REVIEW_BACKUP_LOCAL_DIR,
          },
          progressDelivery: DEFAULT_SCHEDULED_PROGRESS_DELIVERY ?? undefined,
        };
      }
      await this.migrateLegacyDailyReviewBackupPathIfNeeded();
      this.lastConfigReloadAt = Date.now();
      log.info('[HeartbeatScheduler] Config loaded');
      return { ok: true, config: this.config, created: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('[HeartbeatScheduler] Failed to load config', { message });
      return { ok: false, error: message };
    }
    // unreachable - handled above
    return { ok: false, error: 'unknown' };
  }

  private ensureDefaultConfig(): void {
    if (this.config && Object.keys(this.config).length > 0) return;
    this.config = {
      global: { intervalMs: DEFAULT_TASK_INTERVAL_MS, enabled: true, dispatch: 'mailbox' },
      projects: {},
      nightlyDream: {
        enabled: true,
        windowStartHour: DEFAULT_NIGHTLY_DREAM_WINDOW_START_HOUR,
        windowEndHour: DEFAULT_NIGHTLY_DREAM_WINDOW_END_HOUR,
        includeMonitoredProjects: true,
        includeTodayActiveProjects: true,
        maxProjectsPerRun: DEFAULT_NIGHTLY_DREAM_MAX_PROJECTS_PER_RUN,
        maxQueueWaitMs: DEFAULT_NIGHTLY_DREAM_MAX_QUEUE_WAIT_MS,
        progressDelivery: DEFAULT_NIGHTLY_DREAM_PROGRESS_DELIVERY ?? undefined,
      },
      dailySystemReview: {
        enabled: true,
        windowStartHour: DEFAULT_DAILY_SYSTEM_REVIEW_WINDOW_START_HOUR,
        windowEndHour: DEFAULT_DAILY_SYSTEM_REVIEW_WINDOW_END_HOUR,
        maxQueueWaitMs: DEFAULT_DAILY_SYSTEM_REVIEW_MAX_QUEUE_WAIT_MS,
        appendOnly: true,
        backup: {
          enabled: false,
          localDir: DEFAULT_DAILY_SYSTEM_REVIEW_BACKUP_LOCAL_DIR,
        },
        progressDelivery: DEFAULT_SCHEDULED_PROGRESS_DELIVERY ?? undefined,
      },
    };
    log.info('[HeartbeatScheduler] Default config applied (config was empty or failed to load)');
  }

  private async migrateLegacyDailyReviewBackupPathIfNeeded(): Promise<void> {

    const current = this.config.dailySystemReview?.backup?.obsidianDir;
    const normalized = normalizeDailyReviewObsidianDir(current);
    if (!normalized.value || normalized.value === current) return;

    if (!this.config.dailySystemReview) this.config.dailySystemReview = {};
    if (!this.config.dailySystemReview.backup) this.config.dailySystemReview.backup = {};
    this.config.dailySystemReview.backup.obsidianDir = normalized.value;

    try {
      await fs.appendFile(
        CONFIG_PATH,
        `${JSON.stringify({ ts: new Date().toISOString(), type: 'heartbeat_config', config: this.config })}\n`,
        'utf-8',
      );
      log.warn('[HeartbeatScheduler] Migrated dailySystemReview.backup.obsidianDir', {
        from: current,
        to: normalized.value,
        reason: normalized.migrated ? 'legacy_obsidian_vault_path' : 'home_path_normalization',
      });
    } catch (error) {
      log.error('[HeartbeatScheduler] Failed to persist heartbeat config migration', error instanceof Error ? error : undefined, {
        from: current,
        to: normalized.value,
      });
    }
  }

  private watchConfig(): void {
    if (this.configWatcher) return;
    try {
      this.configWatcher = watch(CONFIG_PATH, { persistent: false }, (eventType) => {
        if (eventType !== 'change') return;
        if (Date.now() - this.lastConfigReloadAt < CONFIG_RELOAD_DEBOUNCE_MS) return;
        void this.loadConfig();
      });
      this.configWatcher.on('error', (error) => {
        const detail = describeWatcherError(error);
        log.warn('[HeartbeatScheduler] Config watcher error, disabling watcher', detail);
        if (this.configWatcher) {
          this.configWatcher.close();
          this.configWatcher = null;
        }
      });
      log.info(`[HeartbeatScheduler] Watching config: ${CONFIG_PATH}`);
    } catch (error) {
      log.error('[HeartbeatScheduler] Failed to watch config', error instanceof Error ? error : undefined);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      log.debug('[HeartbeatScheduler] Skip tick: previous round still running');
      this.armTick(DEFAULT_TICK_MS);
      return;
    }
    this.ticking = true;
    try {
      const idleGate = await this.awaitTickStepWithTimeout(
        'evaluateIdleMaintenanceGate',
        this.evaluateIdleMaintenanceGate(),
      );
      if (!idleGate.idle) {
        const now = Date.now();
        const shouldLog = !this.idleGuardBlocked
          || now - this.idleGuardLastLoggedAt >= HEARTBEAT_IDLE_GUARD_LOG_THROTTLE_MS
          || this.idleGuardLastReason !== idleGate.reason;
        if (shouldLog) {
          log.info('[HeartbeatScheduler] Skip tick: non-idle runtime/recovery in progress', {
            reason: idleGate.reason,
            ...(idleGate.details ? { details: idleGate.details } : {}),
          });
          this.idleGuardLastLoggedAt = now;
          this.idleGuardLastReason = idleGate.reason;
        }
        this.idleGuardBlocked = true;
        try {
          await this.awaitTickStepWithTimeout('persistRuntimeState(non_idle)', this.persistRuntimeState());
        }
        catch (error) { log.error('[HeartbeatScheduler] persistRuntimeState error', error instanceof Error ? error : undefined); }
        return;
      }
      if (this.idleGuardBlocked) {
        log.info('[HeartbeatScheduler] Runtime idle restored; resume scheduled heartbeat/mailbox tasks');
        this.idleGuardBlocked = false;
        this.idleGuardLastReason = '';
      }
      try { await this.awaitTickStepWithTimeout('dispatchDueTasks', this.dispatchDueTasks()); }
      catch (error) { log.error('[HeartbeatScheduler] dispatchDueTasks error', error instanceof Error ? error : undefined); }
      try { await this.awaitTickStepWithTimeout('dispatchNightlyDreamTasks', this.dispatchNightlyDreamTasks()); }
      catch (error) { log.error('[HeartbeatScheduler] dispatchNightlyDreamTasks error', error instanceof Error ? error : undefined); }
      try { await this.awaitTickStepWithTimeout('dispatchDailySystemReviewTask', this.dispatchDailySystemReviewTask()); }
      catch (error) { log.error('[HeartbeatScheduler] dispatchDailySystemReviewTask error', error instanceof Error ? error : undefined); }
      
      // 评估心跳状态
      const newState = this.evaluateHeartbeatState();
      if (newState !== this.heartbeatState) {
        this.transitionHeartbeatState(newState, 'mailbox_health_evaluation');
      }
      
      // 根据状态决定是否继续 mailbox prompt
      if (this.heartbeatState === 'PAUSED' || this.heartbeatState === 'STOPPED') {
        log.info('[HeartbeatScheduler] Skip mailbox prompt: paused/stopped state', { state: this.heartbeatState });
      } else {
        try { await this.awaitTickStepWithTimeout('promptMailboxChecks', this.promptMailboxChecks()); }
        catch (error) { log.error('[HeartbeatScheduler] promptMailboxChecks error', error instanceof Error ? error : undefined); }
      }
      try { await this.awaitTickStepWithTimeout('persistRuntimeState(final)', this.persistRuntimeState()); }
      catch (error) { log.error('[HeartbeatScheduler] persistRuntimeState error', error instanceof Error ? error : undefined); }
    } catch (error) {
      log.error('[HeartbeatScheduler] Unexpected tick failure', error instanceof Error ? error : undefined);
    } finally {
      this.ticking = false;
      this.armTick(DEFAULT_TICK_MS);
    }
  }
  private evaluateHeartbeatState(): HeartbeatState {
    // 使用 heartbeatMailbox.list() 计算系统 mailbox 健康数据
    const systemMessages = heartbeatMailbox.list("finger-system-agent");
    const pending = systemMessages.filter(m => m.status === "pending");
    const processing = systemMessages.filter(m => m.status === "processing");
    const oldestPending = pending.length > 0 ? pending.reduce((a, b) => 
      (new Date(a.createdAt).getTime() < new Date(b.createdAt).getTime()) ? a : b) : null;
    
    const now = Date.now();
    
    const health = {
      pending: pending.length,
      processing: processing.length,
      oldestPendingAgeMs: oldestPending ? now - new Date(oldestPending.createdAt).getTime() : undefined,
    };
    const cfg = HEARTBEAT_STATE_CONFIG;
    
    // 检查 DEGRADED → PAUSED（持续恶化）
    if (this.heartbeatState === 'DEGRADED') {
      if (health.pending > cfg.degradedToPausedThreshold) {
        return 'PAUSED';
      }
      const degradedDuration = now - (this.heartbeatStateContext.degradedAt || now);
      if (degradedDuration > cfg.degradedDurationThresholdMs) {
        return 'PAUSED';
      }
    }
    
    // 检查 RUNNING → DEGRADED
    if (this.heartbeatState === 'RUNNING') {
      if (health.pending > cfg.mailboxPendingThreshold) {
        return 'DEGRADED';
      }
      if (health.oldestPendingAgeMs && health.oldestPendingAgeMs > cfg.mailboxPendingAgeMs) {
        return 'DEGRADED';
      }
    }
    
    // 检查 DEGRADED → RUNNING（自动恢复）
    if (this.heartbeatState === 'DEGRADED') {
      if (health.pending <= cfg.mailboxPendingRecoveryThreshold) {
        const ageOk = !health.oldestPendingAgeMs || health.oldestPendingAgeMs < cfg.mailboxProcessingAgeMs;
        if (ageOk) {
          return 'RUNNING';
        }
      }
    }
    
    // 检查 PAUSED → RUNNING (自动恢复)
    if (this.heartbeatState === 'PAUSED') {
      // 1. 条件：mailbox 恢复健康
      if (health.pending <= cfg.mailboxPendingRecoveryThreshold) {
        const ageOk = !health.oldestPendingAgeMs || health.oldestPendingAgeMs < cfg.mailboxProcessingAgeMs;
        if (ageOk) {
          return 'RUNNING';
        }
      }
      // 2. 条件：超时自动恢复 (如果有配置)
      // 注意：这里假设 cfg.autoResumeAfterMs 存在，否则默认不自动恢复
    }
    
    return this.heartbeatState;
  }

  private transitionHeartbeatState(newState: HeartbeatState, reason: string): void {
    const now = Date.now();
    const prevState = this.heartbeatState;
    
    if (newState === prevState) {
      return;
    }
    
    this.heartbeatState = newState;
    this.heartbeatStateChangedAt = now;
    
    // 更新 context
    this.heartbeatStateContext.state = newState;
    
    if (newState === 'DEGRADED') {
      this.heartbeatStateContext.degradedAt = now;
      this.heartbeatStateContext.degradedReason = reason;
      log.warn('[HeartbeatScheduler] State transition: RUNNING -> DEGRADED', { reason });
      appendHeartbeatEventSync('heartbeat_degraded', 'warn', { prevState, newState, reason, degradedAt: now });
    } else if (newState === 'PAUSED') {
      this.heartbeatStateContext.pausedAt = now;
      this.heartbeatStateContext.pausedReason = reason;
      log.error('[HeartbeatScheduler] State transition: DEGRADED/RUNNING -> PAUSED', undefined, { reason, prevState });
      const eventType: HeartbeatEventType = prevState === 'DEGRADED' ? 'heartbeat_degraded_to_paused' : 'heartbeat_stopped';
      const severity: HeartbeatEventSeverity = prevState === 'DEGRADED' ? 'error' : 'critical';
      appendHeartbeatEventSync(eventType, severity, { prevState, newState, reason, pausedAt: now });
    } else if (newState === 'RUNNING') {
      this.heartbeatStateContext.degradedAt = undefined;
      this.heartbeatStateContext.degradedReason = undefined;
      this.heartbeatStateContext.pausedAt = undefined;
      this.heartbeatStateContext.pausedReason = undefined;
      log.info('[HeartbeatScheduler] State transition: DEGRADED/PAUSED -> RUNNING', { reason, prevState });
      const eventType2: HeartbeatEventType = reason.includes('auto') ? 'heartbeat_auto_resume' : 'heartbeat_resumed';
      appendHeartbeatEventSync(eventType2, 'info', { prevState, newState, reason });
    }
  }



  private async awaitTickStepWithTimeout<T>(
    step: string,
    promise: Promise<T>,
    timeoutMs = HEARTBEAT_STEP_TIMEOUT_MS,
  ): Promise<T> {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timeoutError = new Error(`[HeartbeatScheduler] step timeout: ${step} after ${timeoutMs}ms`);
        (timeoutError as NodeJS.ErrnoException).code = 'HEARTBEAT_STEP_TIMEOUT';
        reject(timeoutError);
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async evaluateIdleMaintenanceGate(): Promise<{
    idle: boolean;
    reason: string;
    details?: Record<string, unknown>;
  }> {
    const recovery = this.detectActiveProjectRecoverySessions();
    if (recovery.active) {
      return {
        idle: false,
        reason: 'project_recovery_active',
        details: {
          sessionIds: recovery.sessionIds,
          taskSessionIds: recovery.taskSessionIds,
          lifecycleSessionIds: recovery.lifecycleSessionIds,
          staleTaskSessionIds: recovery.staleTaskSessionIds,
          staleLifecycleSessionIds: recovery.staleLifecycleSessionIds,
        },
      };
    }

    try {
      const snapshot = await this.deps.agentRuntimeBlock.execute('runtime_view', {});
      const busyAgents = HEARTBEAT_IDLE_GUARD_AGENT_IDS
        .map((agentId) => {
          const state = extractAgentStatusFromRuntimeView(snapshot, agentId);
          if (state.busy !== true) return null;
          return {
            agentId,
            status: state.status ?? 'busy',
          };
        })
        .filter((item): item is { agentId: string; status: string } => item !== null);
      if (busyAgents.length > 0) {
        return {
          idle: false,
          reason: 'runtime_busy',
          details: { busyAgents },
        };
      }
    } catch (error) {
      log.warn('[HeartbeatScheduler] runtime_view failed in idle gate; proceed tick to avoid starvation', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { idle: true, reason: 'idle' };
  }

  private detectActiveProjectRecoverySessions(): {
    active: boolean;
    sessionIds: string[];
    taskSessionIds: string[];
    lifecycleSessionIds: string[];
    staleTaskSessionIds: string[];
    staleLifecycleSessionIds: string[];
  } {
    const listSessions = (this.deps.sessionManager as {
      listSessions?: () => Array<{ id: string; context?: Record<string, unknown> }>;
    }).listSessions;
    if (typeof listSessions !== 'function') {
      return {
        active: false,
        sessionIds: [],
        taskSessionIds: [],
        lifecycleSessionIds: [],
        staleTaskSessionIds: [],
        staleLifecycleSessionIds: [],
      };
    }
    const sessions = listSessions.call(this.deps.sessionManager) ?? [];
    const taskSessionIds: string[] = [];
    const lifecycleSessionIds: string[] = [];
    const staleTaskSessionIds: string[] = [];
    const staleLifecycleSessionIds: string[] = [];
    const nowMs = Date.now();
    for (const session of sessions) {
      const context = session && typeof session.context === 'object' && session.context !== null
        ? session.context as Record<string, unknown>
        : {};
      const sessionTier = typeof context.sessionTier === 'string' ? context.sessionTier.trim() : '';
      if (sessionTier === 'heartbeat-control') continue;

      const taskState = parseProjectTaskState(context.projectTaskState);
      if (taskState && isProjectTaskStateActive(taskState)) {
        const updatedAtMs = Date.parse(taskState.updatedAt);
        const ageMs = Number.isFinite(updatedAtMs) ? Math.max(0, nowMs - updatedAtMs) : Number.POSITIVE_INFINITY;
        if (ageMs <= PROJECT_RECOVERY_ACTIVE_MAX_AGE_MS) {
          taskSessionIds.push(session.id);
        } else {
          staleTaskSessionIds.push(session.id);
        }
      }

      const lifecycle = parseExecutionLifecycleState(context.executionLifecycle);
      if (lifecycle && lifecycle.targetAgentId === FINGER_PROJECT_AGENT_ID && this.shouldResumeLifecycle(lifecycle)) {
        const lastTransitionMs = Date.parse(lifecycle.lastTransitionAt);
        const ageMs = Number.isFinite(lastTransitionMs) ? Math.max(0, nowMs - lastTransitionMs) : Number.POSITIVE_INFINITY;
        if (ageMs <= PROJECT_RECOVERY_ACTIVE_MAX_AGE_MS) {
          lifecycleSessionIds.push(session.id);
        } else {
          staleLifecycleSessionIds.push(session.id);
        }
      }
    }
    const sessionIds = Array.from(new Set([...taskSessionIds, ...lifecycleSessionIds]));
    return {
      active: sessionIds.length > 0,
      sessionIds,
      taskSessionIds,
      lifecycleSessionIds,
      staleTaskSessionIds: Array.from(new Set(staleTaskSessionIds)),
      staleLifecycleSessionIds: Array.from(new Set(staleLifecycleSessionIds)),
    };
  }

  private async dispatchDueTasks(): Promise<void> {
    const agents = await listAgents();
    const monitoredAgents = agents.filter((a) => a.monitored === true);

    if (this.config.global?.enabled !== false) {
      const interval = this.config.global?.intervalMs ?? DEFAULT_TASK_INTERVAL_MS;
      if (this.shouldRun('global', interval)) {
        await this.runExecutionWatchdog(SYSTEM_AGENT_ID, undefined);
        const pendingTasks = await readJsonlTasks();
        if (pendingTasks.length > 0) {
          const prompt = this.config.global?.prompt ?? buildHeartbeatPrompt(pendingTasks);
          await this.dispatchTask('finger-system-agent', 'global', undefined, { ...this.config.global, prompt });
        }
        this.lastRun.set('global', Date.now());
      }
    }

    for (const agent of monitoredAgents) {
      const projectId = agent.projectId;
      const runtimeTargetAgentId = FINGER_PROJECT_AGENT_ID;
      const projectSessionId = this.resolveLatestProjectSessionId(agent.projectPath, runtimeTargetAgentId);
      const projectConfig = this.resolveProjectConfig(agent.projectId, agent.projectPath);
      if (projectConfig.enabled === false) continue;
      const projectKey = `project:${projectId}`;
      const projectInterval = projectConfig.intervalMs ?? this.config.global?.intervalMs ?? DEFAULT_TASK_INTERVAL_MS;
      if (this.shouldRun(projectKey, projectInterval)) {
        await this.runExecutionWatchdog(runtimeTargetAgentId, projectId, projectSessionId ?? undefined);
        await this.dispatchTask(runtimeTargetAgentId, projectKey, projectId, projectConfig, projectSessionId ?? undefined);
        this.lastRun.set(projectKey, Date.now());
      }
      for (const [taskId, taskConfig] of Object.entries(projectConfig.tasks ?? {})) {
        if (taskConfig.enabled === false) continue;
        const taskKey = `task:${projectId}:${taskId}`;
        const taskInterval = taskConfig.intervalMs ?? projectInterval;
        if (this.shouldRun(taskKey, taskInterval)) {
          await this.dispatchTask(runtimeTargetAgentId, taskId, projectId, taskConfig, projectSessionId ?? undefined);
          this.lastRun.set(taskKey, Date.now());
        }
      }
    }
  }

  private resolveNightlyDreamConfig(): Required<Pick<NightlyDreamConfig,
    'enabled' | 'windowStartHour' | 'windowEndHour' | 'maxProjectsPerRun' | 'includeMonitoredProjects' | 'includeTodayActiveProjects' | 'maxQueueWaitMs' | 'lockTtlMs' | 'maxDispatchRetries' | 'retryBackoffMs'
  >> & { progressDelivery?: ProgressDeliveryPolicy } {
    const raw = this.config.nightlyDream;
    const windowStartHour = Number.isFinite(raw?.windowStartHour)
      ? Math.min(23, Math.max(0, Math.floor(raw?.windowStartHour ?? DEFAULT_NIGHTLY_DREAM_WINDOW_START_HOUR)))
      : DEFAULT_NIGHTLY_DREAM_WINDOW_START_HOUR;
    const windowEndHour = Number.isFinite(raw?.windowEndHour)
      ? Math.min(23, Math.max(0, Math.floor(raw?.windowEndHour ?? DEFAULT_NIGHTLY_DREAM_WINDOW_END_HOUR)))
      : DEFAULT_NIGHTLY_DREAM_WINDOW_END_HOUR;
    const maxProjectsPerRun = Number.isFinite(raw?.maxProjectsPerRun)
      ? Math.max(1, Math.floor(raw?.maxProjectsPerRun ?? DEFAULT_NIGHTLY_DREAM_MAX_PROJECTS_PER_RUN))
      : DEFAULT_NIGHTLY_DREAM_MAX_PROJECTS_PER_RUN;
    const maxQueueWaitMs = Number.isFinite(raw?.maxQueueWaitMs)
      ? Math.max(0, Math.floor(raw?.maxQueueWaitMs ?? DEFAULT_NIGHTLY_DREAM_MAX_QUEUE_WAIT_MS))
      : DEFAULT_NIGHTLY_DREAM_MAX_QUEUE_WAIT_MS;
    const lockTtlMs = Number.isFinite(raw?.lockTtlMs)
      ? Math.max(60_000, Math.floor(raw?.lockTtlMs ?? DEFAULT_PROJECT_DREAM_LOCK_TTL_MS))
      : DEFAULT_PROJECT_DREAM_LOCK_TTL_MS;
    const maxDispatchRetries = Number.isFinite(raw?.maxDispatchRetries)
      ? Math.max(0, Math.floor(raw?.maxDispatchRetries ?? DEFAULT_NIGHTLY_DREAM_MAX_DISPATCH_RETRIES))
      : DEFAULT_NIGHTLY_DREAM_MAX_DISPATCH_RETRIES;
    const retryBackoffMs = Number.isFinite(raw?.retryBackoffMs)
      ? Math.max(0, Math.floor(raw?.retryBackoffMs ?? DEFAULT_NIGHTLY_DREAM_RETRY_BACKOFF_MS))
      : DEFAULT_NIGHTLY_DREAM_RETRY_BACKOFF_MS;
    return {
      enabled: raw?.enabled === true,
      windowStartHour,
      windowEndHour,
      maxProjectsPerRun,
      includeMonitoredProjects: raw?.includeMonitoredProjects !== false,
      includeTodayActiveProjects: raw?.includeTodayActiveProjects !== false,
      maxQueueWaitMs,
      lockTtlMs,
      maxDispatchRetries,
      retryBackoffMs,
      progressDelivery: normalizeProgressDeliveryPolicy(raw?.progressDelivery)
        ?? DEFAULT_NIGHTLY_DREAM_PROGRESS_DELIVERY
        ?? undefined,
    };
  }

  private localDateKey(value: Date): string {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private isHourInWindow(hour: number, startHour: number, endHour: number): boolean {
    if (startHour <= endHour) return hour >= startHour && hour <= endHour;
    return hour >= startHour || hour <= endHour;
  }

  private isEphemeralProjectPath(projectPath: string): boolean {
    const normalized = normalizeProjectPath(projectPath);
    return normalized.startsWith('/tmp/')
      || normalized === '/tmp'
      || normalized.startsWith('/private/tmp/')
      || normalized === '/private/tmp'
      || normalized.startsWith('/var/folders/');
  }

  private async hasDirectoryAt(projectPath: string): Promise<boolean> {
    const trimmed = typeof projectPath === 'string' ? projectPath.trim() : '';
    if (!trimmed || !path.isAbsolute(trimmed)) return false;
    try {
      const stat = await fs.stat(trimmed);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  private stableHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
      hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
  }

  private buildProjectSlug(projectPath: string): string {
    const normalized = normalizeProjectPath(projectPath);
    const readable = normalized
      .replace(/^\/+/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const base = readable.length > 0 ? readable.slice(0, 60) : 'project';
    const hash = this.stableHash(normalized).slice(0, 8);
    return `${base}-${hash}`;
  }

  private buildNightlyDreamPrompt(params: {
    projectId: string;
    projectPath: string;
    projectSlug: string;
    sources: string[];
    dateKey: string;
    taskId: string;
  }): string {
    const projectMemoryRoot = path.join(FINGER_PATHS.home, 'memory', 'projects', params.projectSlug);
    return [
      '# Nightly Project Dream Task',
      '',
      '目标：执行项目级记忆蒸馏（不是日报），产出可复用执行资产。',
      `projectId: ${params.projectId}`,
      `projectPath: ${params.projectPath}`,
      `projectSlug: ${params.projectSlug}`,
      `triggerDate: ${params.dateKey}`,
      `taskId: ${params.taskId}`,
      `triggerSources: ${params.sources.join(',')}`,
      `projectMemoryRoot: ${projectMemoryRoot}`,
      '',
      '执行规则：',
      '1) digest-first 检索（先看 digest，再按需扩张 detail=true 原文）。',
      '2) 清洗噪音：heartbeat no-op、重复无状态变化、纯 ack 通知。',
      '3) 项目复盘重点：总结本项目“做错且反复错了什么、做对了什么、为什么做对、关键流程节点是什么”。',
      '4) 重复问题治理：同类项目错误重复出现时，标记 recurring project defects 并给出优先级提升的根因修复动作。',
      '5) 仅保留高信号沉淀：规则/防呆/流程模板/交付模式（仅项目相关）。',
      '6) 写入项目 memory：MEMORY.md 索引 + memories/*.md 主题文件。',
      '7) 严禁跨项目写入；只允许写 projectMemoryRoot 下内容。',
      '8) 用户画像写入边界：不要在项目梦境任务中直接修改系统用户画像（~/.finger/USER.md）；如发现高价值用户偏好线索，仅作为 candidate 信号回传。',
      '',
      '交付回传：',
      `- 必须调用 report-task-completion(action=report, taskId="${params.taskId}", sessionId=<当前会话>, result=success|failure, projectId="${params.projectId}")`,
      '- taskSummary 必须写清本轮高信号沉淀（不是日报）',
      '- changed_files',
      '- rules_added / rules_updated / stale_removed',
      '- recurring_project_defects（项目重复问题 + 修复优先级）',
      '- user_signal_candidates（可供 system 用户画像更新的候选信号，不直接落 USER.md）',
      '- evidence_slots',
      '- insufficient evidence（如证据不足必须显式说明）',
    ].join('\n');
  }

  private async dispatchNightlyDreamTasks(): Promise<void> {
    const cfg = this.resolveNightlyDreamConfig();
    if (!cfg.enabled) return;

    const now = new Date();
    if (!this.isHourInWindow(now.getHours(), cfg.windowStartHour, cfg.windowEndHour)) return;

    const dateKey = this.localDateKey(now);
    const batchStartedAt = Date.now();
    const agents = await listAgents();
    const byPath = new Map<string, { projectId: string; projectPath: string; sources: Set<string> }>();

    const addCandidate = (projectPath: string, projectId: string, source: 'monitored' | 'today-active') => {
      const normalizedPath = normalizeProjectPath(projectPath);
      if (!normalizedPath) return;
      if (normalizedPath === normalizeProjectPath(SYSTEM_PROJECT_PATH)) return;
      const existing = byPath.get(normalizedPath);
      if (existing) {
        existing.sources.add(source);
        return;
      }
      byPath.set(normalizedPath, {
        projectId: projectId || normalizedPath,
        projectPath,
        sources: new Set([source]),
      });
    };

    if (cfg.includeMonitoredProjects) {
      for (const agent of agents) {
        if (agent.monitored !== true) continue;
        addCandidate(agent.projectPath, agent.projectId, 'monitored');
      }
    }

    if (cfg.includeTodayActiveProjects) {
      const listRootSessions = (this.deps.sessionManager as {
        listRootSessions?: () => Array<{ projectPath?: string; lastAccessedAt?: string }>;
      }).listRootSessions;
      const sessions = typeof listRootSessions === 'function'
        ? listRootSessions.call(this.deps.sessionManager)
        : [];
      const registryByPath = new Map<string, { projectId: string; projectPath: string }>();
      for (const agent of agents) {
        const key = normalizeProjectPath(agent.projectPath);
        if (!key) continue;
        registryByPath.set(key, { projectId: agent.projectId, projectPath: agent.projectPath });
      }
      for (const session of sessions) {
        const projectPath = typeof session.projectPath === 'string' ? session.projectPath.trim() : '';
        if (!projectPath) continue;
        const lastAccessedAt = typeof session.lastAccessedAt === 'string' ? session.lastAccessedAt : '';
        if (!lastAccessedAt) continue;
        const sessionDate = new Date(lastAccessedAt);
        if (Number.isNaN(sessionDate.getTime())) continue;
        if (this.localDateKey(sessionDate) !== dateKey) continue;
        const normalizedPath = normalizeProjectPath(projectPath);
        const registry = registryByPath.get(normalizedPath);
        addCandidate(
          registry?.projectPath ?? projectPath,
          registry?.projectId ?? normalizedPath,
          'today-active',
        );
      }
    }

    const candidatesRaw = Array.from(byPath.values())
      .sort((a, b) => a.projectPath.localeCompare(b.projectPath));
    const candidates: Array<{
      projectId: string;
      projectPath: string;
      projectSlug: string;
      sourceList: string[];
    }> = [];
    for (const item of candidatesRaw) {
      const sourceList = Array.from(item.sources.values()).sort();
      const monitored = item.sources.has('monitored');
      // 防污染：today-active 只接受“真实项目目录”；监控项目维持高优先级直通。
      if (!monitored) {
        if (this.isEphemeralProjectPath(item.projectPath)) {
          continue;
        }
        if (!(await this.hasDirectoryAt(item.projectPath))) {
          continue;
        }
      }
      candidates.push({
        ...item,
        projectSlug: this.buildProjectSlug(item.projectPath),
        sourceList,
      });
      if (candidates.length >= cfg.maxProjectsPerRun) break;
    }
    let dispatchedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const candidate of candidates) {
      if (this.lastNightlyDreamByProject.get(candidate.projectSlug) === dateKey) {
        continue;
      }

      const sessionId = await this.ensureHeartbeatControlSession(
        FINGER_PROJECT_AGENT_ID,
        candidate.projectId,
      );
      const taskId = `nightly-dream:${candidate.projectSlug}:${dateKey}`;
      const prompt = this.buildNightlyDreamPrompt({
        projectId: candidate.projectId,
        projectPath: candidate.projectPath,
        projectSlug: candidate.projectSlug,
        sources: candidate.sourceList,
        dateKey,
        taskId,
      });
      const lock = await acquireProjectDreamLock({
        projectSlug: candidate.projectSlug,
        runId: taskId,
        lockTtlMs: cfg.lockTtlMs,
        owner: 'system-nightly-dream',
      });
      if (!lock.acquired) {
        skippedCount += 1;
        this.nightlyDreamDispatchState.set(candidate.projectSlug, {
          date: dateKey,
          status: 'processing',
          updatedAt: Date.now(),
          projectId: candidate.projectId,
          projectPath: candidate.projectPath,
          sessionId,
          source: candidate.sourceList.join(','),
          runId: taskId,
          note: lock.reason === 'reentrant'
            ? 'skip_duplicate_same_run_id'
            : lock.reason === 'busy'
              ? 'skip_lock_busy'
              : 'skip_lock_invalid',
        });
        log.info('[HeartbeatScheduler] Nightly dream skipped by lock', {
          projectId: candidate.projectId,
          projectPath: candidate.projectPath,
          projectSlug: candidate.projectSlug,
          runId: taskId,
          reason: lock.reason,
          existingRunId: lock.existingRunId,
        });
        continue;
      }

      const runStartedAt = Date.now();
      try {
        let rawStatus = 'unknown';
        let dispatchError: string | undefined;
        let attempt = 0;
        while (attempt <= cfg.maxDispatchRetries) {
          attempt += 1;
          try {
            const result = await this.deps.agentRuntimeBlock.execute('dispatch', {
              sourceAgentId: 'system-nightly-dream',
              targetAgentId: FINGER_PROJECT_AGENT_ID,
              task: prompt,
              projectPath: candidate.projectPath,
              ...(sessionId
                ? { sessionId, sessionStrategy: 'current' as const }
                : { sessionStrategy: 'latest' as const }),
              queueOnBusy: true,
              maxQueueWaitMs: cfg.maxQueueWaitMs,
              blocking: false,
              metadata: {
                source: 'nightly-dream',
                role: 'system',
                taskId,
                projectId: candidate.projectId,
                projectPath: candidate.projectPath,
                projectSlug: candidate.projectSlug,
                dispatchReason: 'nightly_project_dream',
                dispatchSource: 'system-heartbeat',
                dreamDate: dateKey,
                dreamSources: candidate.sourceList,
                ...(cfg.progressDelivery ? { scheduledProgressDelivery: cfg.progressDelivery } : {}),
              },
            }) as { status?: string } | null;
            rawStatus = typeof result?.status === 'string' ? result.status : 'unknown';
            dispatchError = undefined;
          } catch (error) {
            rawStatus = 'failed';
            dispatchError = error instanceof Error ? error.message : String(error);
          }
          if (rawStatus !== 'failed') break;
          if (attempt <= cfg.maxDispatchRetries && cfg.retryBackoffMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, cfg.retryBackoffMs));
          }
        }

        const status = rawStatus === 'queued'
          || rawStatus === 'processing'
          || rawStatus === 'completed'
          || rawStatus === 'failed'
          ? rawStatus
          : 'unknown';

        this.lastNightlyDreamByProject.set(candidate.projectSlug, dateKey);
        this.nightlyDreamDispatchState.set(candidate.projectSlug, {
          date: dateKey,
          status,
          updatedAt: Date.now(),
          projectId: candidate.projectId,
          projectPath: candidate.projectPath,
          sessionId,
          source: candidate.sourceList.join(','),
          runId: taskId,
        });
        if (status === 'failed') {
          failedCount += 1;
        } else {
          dispatchedCount += 1;
        }
        if (status === 'failed' || status === 'completed') {
          await releaseProjectDreamLock({
            projectSlug: candidate.projectSlug,
            runId: taskId,
          });
        }
        log.info('[HeartbeatScheduler] Nightly dream dispatched', {
          dream_run_id: taskId,
          source: 'nightly-dream',
          status,
          duration_ms: Date.now() - runStartedAt,
          retry_count: cfg.maxDispatchRetries,
          projectId: candidate.projectId,
          projectPath: candidate.projectPath,
          projectSlug: candidate.projectSlug,
          sessionId,
          sources: candidate.sourceList,
          ...(dispatchError ? { dispatchError } : {}),
        });
      } catch (error) {
        failedCount += 1;
        this.nightlyDreamDispatchState.set(candidate.projectSlug, {
          date: dateKey,
          status: 'failed',
          updatedAt: Date.now(),
          projectId: candidate.projectId,
          projectPath: candidate.projectPath,
          sessionId,
          source: candidate.sourceList.join(','),
          runId: taskId,
          note: 'dispatch_failed',
        });
        await releaseProjectDreamLock({
          projectSlug: candidate.projectSlug,
          runId: taskId,
        });
        log.warn('[HeartbeatScheduler] Nightly dream dispatch failed', {
          dream_run_id: taskId,
          source: 'nightly-dream',
          status: 'failed',
          duration_ms: Date.now() - runStartedAt,
          projectId: candidate.projectId,
          projectPath: candidate.projectPath,
          projectSlug: candidate.projectSlug,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (candidates.length > 0) {
      log.info('[HeartbeatScheduler] Nightly dream batch summary', {
        source: 'nightly-dream',
        dream_date: dateKey,
        candidates: candidates.length,
        dispatched: dispatchedCount,
        failed: failedCount,
        skipped: skippedCount,
        duration_ms: Date.now() - batchStartedAt,
      });
    }
  }

  private resolveDailySystemReviewConfig(): Required<Pick<DailySystemReviewConfig,
    'enabled' | 'windowStartHour' | 'windowEndHour' | 'maxQueueWaitMs' | 'appendOnly'
  >> & {
    backup: {
      enabled: boolean;
      obsidianDir?: string;
      localDir: string;
    };
    progressDelivery?: ProgressDeliveryPolicy;
  } {
    const raw = this.config.dailySystemReview;
    const windowStartHour = Number.isFinite(raw?.windowStartHour)
      ? Math.min(23, Math.max(0, Math.floor(raw?.windowStartHour ?? DEFAULT_DAILY_SYSTEM_REVIEW_WINDOW_START_HOUR)))
      : DEFAULT_DAILY_SYSTEM_REVIEW_WINDOW_START_HOUR;
    const windowEndHour = Number.isFinite(raw?.windowEndHour)
      ? Math.min(23, Math.max(0, Math.floor(raw?.windowEndHour ?? DEFAULT_DAILY_SYSTEM_REVIEW_WINDOW_END_HOUR)))
      : DEFAULT_DAILY_SYSTEM_REVIEW_WINDOW_END_HOUR;
    const maxQueueWaitMs = Number.isFinite(raw?.maxQueueWaitMs)
      ? Math.max(0, Math.floor(raw?.maxQueueWaitMs ?? DEFAULT_DAILY_SYSTEM_REVIEW_MAX_QUEUE_WAIT_MS))
      : DEFAULT_DAILY_SYSTEM_REVIEW_MAX_QUEUE_WAIT_MS;
    const appendOnly = raw?.appendOnly !== false;
    const rawBackup = raw?.backup;
    const backupEnabled = rawBackup?.enabled === true;
    const backupObsidianNormalized = normalizeDailyReviewObsidianDir(rawBackup?.obsidianDir);
    const backupObsidianDir = backupObsidianNormalized.value;
    const backupLocalDir = typeof rawBackup?.localDir === 'string' && rawBackup.localDir.trim().length > 0
      ? rawBackup.localDir.trim()
      : DEFAULT_DAILY_SYSTEM_REVIEW_BACKUP_LOCAL_DIR;
    return {
      enabled: raw?.enabled === true,
      windowStartHour,
      windowEndHour,
      maxQueueWaitMs,
      appendOnly,
      backup: {
        enabled: backupEnabled,
        ...(backupObsidianDir ? { obsidianDir: backupObsidianDir } : {}),
        localDir: backupLocalDir,
      },
      progressDelivery: normalizeProgressDeliveryPolicy(raw?.progressDelivery)
        ?? DEFAULT_SCHEDULED_PROGRESS_DELIVERY
        ?? undefined,
    };
  }

  private buildDailySystemReviewPrompt(params: {
    dateKey: string;
    taskId: string;
    appendOnly: boolean;
    backup: {
      enabled: boolean;
      obsidianDir?: string;
      localDir: string;
    };
  }): string {
    const dailyReportPath = path.join(FINGER_PATHS.home, 'system', 'daily', `${params.dateKey}.md`);
    const backupDateFolder = params.dateKey;
    const obsidianBackupRoot = params.backup.obsidianDir;
    const localBackupRoot = params.backup.localDir;
    return [
      '# Daily System Review Task',
      '',
      '目标：系统级每日复盘必须发生，且必须有可审计交付。',
      `date: ${params.dateKey}`,
      `taskId: ${params.taskId}`,
      `dailyReportPath: ${dailyReportPath}`,
      `appendOnly: ${params.appendOnly ? 'true' : 'false'}`,
      `backup.localDir: ${localBackupRoot}`,
      `backup.obsidianDir: ${obsidianBackupRoot ?? '(not configured)'}`,
      `backup.dateFolder: ${backupDateFolder}`,
      '',
      '必须完成：',
      '1) 基于 ledger + 当日关键任务，产出当日系统复盘（成功/失败/反复错误/防复发动作）。',
      '2) 更新 `~/.finger/USER.md`：仅保留高信号用户画像（称呼、偏好、强烈厌恶、隐私边界、流程偏好）。',
      '3) 同步更新相关项目的 FLOW.md / MEMORY.md（只追加，不覆盖历史）。',
      `4) 写入每日总结文件：${dailyReportPath}（包含证据索引与待改进项）。`,
      '5) 严禁写“无待办=完成”；必须检查用户目标与真实交付证据是否匹配。',
      params.appendOnly
        ? '6) USER/FLOW/MEMORY 必须 append-only：禁止删除或覆盖历史条目。'
        : '6) 即使 appendOnly=false，仍不允许静默覆盖历史，需显式追加版本段。',
      params.backup.enabled
        ? `7) 备份更新后的 USER/FLOW/MEMORY 到本地备份目录（${localBackupRoot}/${backupDateFolder}/...）并同步到 Obsidian 目录（${obsidianBackupRoot ?? '未配置'}）。`
        : `7) 备份至少写入本地目录（${localBackupRoot}/${backupDateFolder}/...）；若需要 Obsidian 备份请开启 backup.enabled 并配置 backup.obsidianDir。`,
      '',
      '交付回传：',
      `- 必须调用 report-task-completion(action=report, taskId="${params.taskId}", sessionId=<当前会话>, result=success|failure)`,
      '- taskSummary 必须包含：今日完成、今日失败、反复错误、已加刚性约束、明日优先项',
      '- taskSummary 必须包含：做对了什么 / 做错了什么 / 重复错误 / 新增约束',
      '- evidence 必须给出具体日志/文件路径',
    ].join('\n');
  }

  private async captureDailySystemReviewBaseline(dateKey: string, taskId: string): Promise<Array<{
    name: string;
    targetPath: string;
    existed: boolean;
    snapshotPath?: string;
  }>> {
    const targets = [
      { name: 'USER.md', targetPath: path.join(FINGER_PATHS.home, 'USER.md') },
      { name: 'FLOW.md', targetPath: path.join(SYSTEM_PROJECT_PATH, 'FLOW.md') },
      { name: 'MEMORY.md', targetPath: path.join(SYSTEM_PROJECT_PATH, 'MEMORY.md') },
    ];
    const baselineDir = path.join(
      FINGER_PATHS.runtime.schedulesDir,
      'daily-system-review-baseline',
      `${dateKey}-${sanitizeSessionKey(taskId) || 'run'}`,
    );
    await fs.mkdir(baselineDir, { recursive: true });
    const baseline: Array<{
      name: string;
      targetPath: string;
      existed: boolean;
      snapshotPath?: string;
    }> = [];
    for (const target of targets) {
      try {
        const content = await fs.readFile(target.targetPath, 'utf-8');
        const snapshotPath = path.join(baselineDir, target.name);
        await fs.writeFile(snapshotPath, content, 'utf-8');
        baseline.push({
          name: target.name,
          targetPath: target.targetPath,
          existed: true,
          snapshotPath,
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code && code !== 'ENOENT') {
          log.warn('[HeartbeatScheduler] Daily review baseline capture read failed', {
            taskId,
            date: dateKey,
            targetPath: target.targetPath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        baseline.push({
          name: target.name,
          targetPath: target.targetPath,
          existed: false,
        });
      }
    }
    return baseline;
  }

  private async dispatchDailySystemReviewTask(): Promise<void> {
    const cfg = this.resolveDailySystemReviewConfig();
    if (!cfg.enabled) return;

    const now = new Date();
    if (!this.isHourInWindow(now.getHours(), cfg.windowStartHour, cfg.windowEndHour)) return;
    const dateKey = this.localDateKey(now);
    const nowMs = Date.now();
    const currentState = this.dailySystemReviewDispatchState;
    const stateDate = typeof currentState?.date === 'string' ? currentState.date.trim() : '';
    const stateStatus = typeof currentState?.status === 'string' ? currentState.status.trim() : '';
    const stateUpdatedAt = Number.isFinite(currentState?.updatedAt)
      ? Math.max(0, Math.floor(currentState?.updatedAt ?? 0))
      : 0;
    const activeStateForToday = stateDate === dateKey
      && (stateStatus === 'queued' || stateStatus === 'processing' || stateStatus === 'unknown');
    const activeStateTtlMs = Math.max(10 * 60_000, cfg.maxQueueWaitMs * 4);
    // At-most-once semantics for daily review dispatch:
    // same-day queued/processing/unknown/completed are treated as already dispatched.
    // Only failed state is eligible for bounded retry.
    if (stateDate === dateKey && stateStatus === 'completed') {
      this.lastDailySystemReviewDate = dateKey;
      return;
    }
    if (activeStateForToday) {
      return;
    }
    if (stateDate === dateKey && stateStatus === 'failed' && stateUpdatedAt > 0 && (nowMs - stateUpdatedAt) < activeStateTtlMs) {
      return;
    }
    if (
      this.lastDailySystemReviewDate === dateKey
      && !activeStateForToday
      && !(stateDate === dateKey && stateStatus === 'failed')
    ) {
      return;
    }

    const sessionId = await this.ensureHeartbeatControlSession(SYSTEM_AGENT_ID, 'system-daily-review');
    const taskId = `daily-system-review:${dateKey}`;
    const prompt = this.buildDailySystemReviewPrompt({
      dateKey,
      taskId,
      appendOnly: cfg.appendOnly,
      backup: cfg.backup,
    });
    let baseline: Array<{
      name: string;
      targetPath: string;
      existed: boolean;
      snapshotPath?: string;
    }> = [];
    try {
      baseline = await this.captureDailySystemReviewBaseline(dateKey, taskId);
    } catch (error) {
      log.warn('[HeartbeatScheduler] Daily review baseline capture failed', {
        taskId,
        date: dateKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const progressDelivery = cfg.progressDelivery ?? DEFAULT_SCHEDULED_PROGRESS_DELIVERY;

    try {
      const result = await this.deps.agentRuntimeBlock.execute('dispatch', {
        sourceAgentId: 'system-daily-review',
        targetAgentId: SYSTEM_AGENT_ID,
        task: prompt,
        sessionId,
        queueOnBusy: true,
        maxQueueWaitMs: cfg.maxQueueWaitMs,
        blocking: false,
        metadata: {
          source: 'system-daily-review',
          sourceType: 'heartbeat',
          role: 'system',
          taskId,
          dispatchReason: 'daily_system_review',
          dispatchSource: 'system-heartbeat',
          reviewDate: dateKey,
          ...(progressDelivery ? { scheduledProgressDelivery: progressDelivery } : {}),
        },
      }) as { status?: string } | null;

      const rawStatus = typeof result?.status === 'string' ? result.status : 'unknown';
      const status = rawStatus === 'queued'
        || rawStatus === 'processing'
        || rawStatus === 'completed'
        || rawStatus === 'failed'
        ? rawStatus
        : 'unknown';

      if (status === 'completed') {
        this.lastDailySystemReviewDate = dateKey;
      }
      this.dailySystemReviewDispatchState = {
        date: dateKey,
        status,
        updatedAt: Date.now(),
        sessionId,
        source: 'system-heartbeat',
        runId: taskId,
        appendOnly: cfg.appendOnly,
        backup: cfg.backup,
        baseline,
      };
      log.info('[HeartbeatScheduler] Daily system review dispatched', {
        taskId,
        date: dateKey,
        status,
        sessionId,
      });
    } catch (error) {
      this.dailySystemReviewDispatchState = {
        date: dateKey,
        status: 'failed',
        updatedAt: Date.now(),
        sessionId,
        source: 'system-heartbeat',
        runId: taskId,
        appendOnly: cfg.appendOnly,
        backup: cfg.backup,
        baseline,
        note: error instanceof Error ? error.message : String(error),
      };
      log.warn('[HeartbeatScheduler] Daily system review dispatch failed', {
        taskId,
        date: dateKey,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private shouldResumeLifecycle(lifecycle: ExecutionLifecycleState): boolean {
    const finishReason = typeof lifecycle.finishReason === 'string'
      ? lifecycle.finishReason.trim().toLowerCase()
      : '';
    const substage = typeof lifecycle.substage === 'string'
      ? lifecycle.substage.trim().toLowerCase()
      : '';
    if (finishReason === 'stop') return false;
    if (lifecycle.stage === 'completed') return false;
    if (substage === 'turn_stop_tool_pending') return true;
    if (ACTIVE_LIFECYCLE_STAGES.has(lifecycle.stage)) return true;
    return lifecycle.stage === 'failed';
  }

  private shouldResetLifecycleAfterRestart(lifecycle: ExecutionLifecycleState): boolean {
    const finishReason = typeof lifecycle.finishReason === 'string'
      ? lifecycle.finishReason.trim().toLowerCase()
      : '';
    if (finishReason !== 'stop') return false;
    if (lifecycle.stage !== 'completed') return true;
    const substage = typeof lifecycle.substage === 'string'
      ? lifecycle.substage.trim().toLowerCase()
      : '';
    return substage === 'turn_stop_tool_pending';
  }

  private resolveProjectTaskStateFromSession(sessionId: string): ReturnType<typeof parseProjectTaskState> {
    const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalized) return null;
    const getSession = (this.deps.sessionManager as {
      getSession?: (id: string) => { context?: Record<string, unknown> } | undefined;
    }).getSession;
    if (typeof getSession !== 'function') return null;
    const session = getSession.call(this.deps.sessionManager, normalized);
    if (!session) return null;
    return parseProjectTaskState(session.context?.projectTaskState);
  }

  private isActionableProjectTaskState(
    state: ReturnType<typeof parseProjectTaskState>,
    targetAgentId: string,
  ): boolean {
    if (!state) return false;
    if (state.targetAgentId !== targetAgentId) return false;
    return isProjectTaskStateActive(state);
  }

  private tryAutoCloseStaleProjectTaskState(params: {
    sessionId: string;
    targetAgentId: string;
    state: ReturnType<typeof parseProjectTaskState>;
    lifecycle: ExecutionLifecycleState | null;
  }): ReturnType<typeof parseProjectTaskState> {
    const current = params.state;
    if (!current || !current.active) return current;
    if (current.targetAgentId !== params.targetAgentId) return current;
    const lifecycle = params.lifecycle;
    const finishReason = typeof lifecycle?.finishReason === 'string'
      ? lifecycle.finishReason.trim().toLowerCase()
      : '';
    const lifecycleCompletedStop = lifecycle?.stage === 'completed' && finishReason === 'stop';
    if (!lifecycleCompletedStop) return current;

    const note = typeof current.note === 'string' ? current.note.trim().toLowerCase() : '';
    const updatedAtMs = Date.parse(current.updatedAt);
    const stateAgeMs = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs : Number.POSITIVE_INFINITY;
    const hasSuppressedDispatchNote = note.startsWith('dispatch_suppressed_');
    const isLikelyStaleActiveState = stateAgeMs >= 15 * 60 * 1000;
    if (!hasSuppressedDispatchNote && !isLikelyStaleActiveState) {
      return current;
    }

    const sessionManager = this.deps.sessionManager as {
      getSession?: (id: string) => { context?: Record<string, unknown> } | undefined;
    };
    const session = typeof sessionManager.getSession === 'function'
      ? sessionManager.getSession.call(this.deps.sessionManager, params.sessionId)
      : undefined;
    const currentRegistry = parseDelegatedProjectTaskRegistry(session?.context?.projectTaskRegistry);
    const closedRegistryNote = hasSuppressedDispatchNote
      ? 'heartbeat_auto_closed_suppressed_dispatch_after_completed_stop'
      : 'heartbeat_auto_closed_stale_active_state_after_completed_stop';
    const closedRegistrySummary = hasSuppressedDispatchNote
      ? 'Auto-closed stale projectTaskRegistry entry generated by dispatch_suppressed_* after completed stop lifecycle.'
      : 'Auto-closed stale active projectTaskRegistry entry after completed stop lifecycle.';
    const nextRegistry = currentRegistry.map((entry) => {
      if (entry.targetAgentId !== params.targetAgentId) return entry;
      const sameTaskId = current.taskId && entry.taskId ? current.taskId === entry.taskId : false;
      const sameTaskName = !current.taskId && current.taskName && entry.taskName
        ? current.taskName === entry.taskName
        : false;
      if (!sameTaskId && !sameTaskName) return entry;
      return {
        ...entry,
        active: false,
        status: 'closed',
        updatedAt: new Date().toISOString(),
        note: closedRegistryNote,
        summary: closedRegistrySummary,
      };
    });
    const closedState = mergeProjectTaskState(current, {
      active: false,
      status: 'closed',
      note: closedRegistryNote,
      summary: hasSuppressedDispatchNote
        ? 'Auto-closed stale projectTaskState generated by dispatch_suppressed_* after completed stop lifecycle.'
        : 'Auto-closed stale active projectTaskState after completed stop lifecycle.',
    });
    applyProjectStatusGatewayPatch({
      sessionManager: this.deps.sessionManager,
      sessionIds: [params.sessionId],
      source: 'heartbeat-scheduler.auto_close_stale',
      patch: {
        active: false,
        status: 'closed',
        ...(typeof current.revision === 'number' ? { revision: current.revision + 1 } : {}),
        note: closedRegistryNote,
        summary: closedState.summary,
        taskId: current.taskId,
        taskName: current.taskName,
        dispatchId: current.dispatchId,
        boundSessionId: current.boundSessionId,
        sourceAgentId: current.sourceAgentId,
        targetAgentId: current.targetAgentId,
        assigneeWorkerId: current.assigneeWorkerId,
        assigneeWorkerName: current.assigneeWorkerName,
        blockedBy: current.blockedBy,
      },
    });
    this.deps.sessionManager.updateContext(params.sessionId, {
      projectTaskRegistry: nextRegistry,
    });
    log.info('[HeartbeatScheduler] Auto-closed stale project task state', {
      sessionId: params.sessionId,
      targetAgentId: params.targetAgentId,
      taskId: current.taskId,
      taskName: current.taskName,
      status: current.status,
      note: current.note,
      lifecycleStage: lifecycle?.stage,
      lifecycleFinishReason: lifecycle?.finishReason,
      stateAgeMs: Number.isFinite(stateAgeMs) ? stateAgeMs : undefined,
    });
    return closedState;
  }

  private isActionableReviewRoute(
    route: {
      taskId: string;
      taskName?: string;
      projectSessionId?: string;
    },
    targetAgentId: string,
  ): boolean {
    const projectSessionId = typeof route.projectSessionId === 'string'
      ? route.projectSessionId.trim()
      : '';
    if (!projectSessionId) return false;
    const state = this.resolveProjectTaskStateFromSession(projectSessionId);
    if (!this.isActionableProjectTaskState(state, targetAgentId)) return false;
    if (route.taskId && state?.taskId && route.taskId !== state.taskId) return false;
    if (route.taskName && state?.taskName && route.taskName.trim() && state.taskName.trim()) {
      if (route.taskName.trim() !== state.taskName.trim()) return false;
    }
    return true;
  }

  private resolveLatestBoundSessionId(agentId: string, preferredSessionId?: string): string | null {
    const store = new SessionControlPlaneStore();
    const sessionManager = this.deps.sessionManager as {
      getSession?: (sessionId: string) => unknown;
      getOrCreateSystemSession?: () => { id?: string };
    };
    const getSession = sessionManager.getSession;
    const preferred = typeof preferredSessionId === 'string' ? preferredSessionId.trim() : '';
    if (agentId === SYSTEM_AGENT_ID && typeof sessionManager.getOrCreateSystemSession === 'function') {
      const system = sessionManager.getOrCreateSystemSession();
      const systemId = typeof system?.id === 'string' ? system.id.trim() : '';
      if (systemId.length > 0) {
        if (typeof getSession !== 'function' || getSession.call(this.deps.sessionManager, systemId)) {
          return systemId;
        }
      }
    }
    if (preferred.length > 0) {
      if (typeof getSession === 'function') {
        if (getSession.call(this.deps.sessionManager, preferred)) return preferred;
      } else {
        return preferred;
      }
    }
    const bindings = store.list({ agentId, provider: 'finger' });
    const latest = bindings.find((binding) => (
      typeof getSession === 'function' ? !!getSession.call(this.deps.sessionManager, binding.fingerSessionId) : true
    )) ?? bindings[0];
    if (latest?.fingerSessionId) return latest.fingerSessionId;
    if (agentId === SYSTEM_AGENT_ID && typeof sessionManager.getOrCreateSystemSession === 'function') {
      const session = sessionManager.getOrCreateSystemSession();
      if (session?.id && typeof session.id === 'string' && session.id.trim().length > 0) {
        return session.id.trim();
      }
    }
    return null;
  }

  private resolveLatestProjectSessionId(projectPath: string, targetAgentId: string): string | null {
    const trimmedPath = typeof projectPath === 'string' ? projectPath.trim() : '';
    if (!trimmedPath) return null;
    const sessionManager = this.deps.sessionManager as {
      findSessionsByProjectPath?: (projectPath: string) => Array<{
        id: string;
        lastAccessedAt?: string;
        projectPath?: string;
        context?: Record<string, unknown>;
      }>;
    };
    const finder = sessionManager.findSessionsByProjectPath;
    if (typeof finder !== 'function') return null;
    const sessions = finder.call(this.deps.sessionManager, trimmedPath)
      .filter((session) => !this.deps.isRuntimeChildSession(session as { context?: Record<string, unknown> }))
      .filter((session) => {
        const context = session && typeof session.context === 'object' && session.context !== null
          ? session.context as Record<string, unknown>
          : {};
        const ownerAgentId = typeof context.ownerAgentId === 'string' ? context.ownerAgentId.trim() : '';
        const sessionTier = typeof context.sessionTier === 'string' ? context.sessionTier.trim() : '';
        if (sessionTier === 'heartbeat-control') return false;
        // If ownerAgentId is explicitly recorded, bind by owner to prevent cross-agent session pollution.
        if (ownerAgentId.length > 0) {
          return ownerAgentId === targetAgentId;
        }
        // Legacy sessions without explicit owner metadata: exclude known system-tier sessions
        // when selecting a project worker session.
        if (targetAgentId === FINGER_PROJECT_AGENT_ID) {
          if (sessionTier === 'system') return false;
          if (session?.projectPath === SYSTEM_PROJECT_PATH) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aTs = a.lastAccessedAt ? Date.parse(a.lastAccessedAt) : 0;
        const bTs = b.lastAccessedAt ? Date.parse(b.lastAccessedAt) : 0;
        return bTs - aTs;
      });
    return sessions[0]?.id ?? null;
  }

  private resolveHeartbeatControlSessionId(
    targetAgentId: string,
    projectId?: string,
  ): string {
    const normalizedTarget = sanitizeSessionKey(targetAgentId || 'agent');
    const normalizedProject = sanitizeSessionKey(projectId || 'global');
    return `${HEARTBEAT_CONTROL_SESSION_PREFIX}-${normalizedTarget}-${normalizedProject}`;
  }

  private async ensureHeartbeatControlSession(
    targetAgentId: string,
    projectId?: string,
  ): Promise<string> {
    const sessionId = this.resolveHeartbeatControlSessionId(targetAgentId, projectId);
    const resolvedProjectPath = projectId
      ? (await resolveProjectPath(projectId)) || SYSTEM_PROJECT_PATH
      : SYSTEM_PROJECT_PATH;
    const sessionManager = this.deps.sessionManager as {
      getSession?: (sessionId: string) => { id?: string } | null;
      ensureSession?: (sessionId: string, projectPath: string, name?: string) => { id?: string } | null;
      updateContext?: (sessionId: string, context: Record<string, unknown>) => boolean;
    };
    if (typeof sessionManager.ensureSession === 'function') {
      const ensured = sessionManager.ensureSession.call(
        this.deps.sessionManager,
        sessionId,
        resolvedProjectPath,
        `[hb] ${targetAgentId}${projectId ? `:${projectId}` : ''}`,
      );
      if (ensured?.id && typeof ensured.id === 'string' && ensured.id.trim().length > 0) {
        if (typeof sessionManager.updateContext === 'function') {
          sessionManager.updateContext.call(this.deps.sessionManager, ensured.id, {
            ownerAgentId: targetAgentId,
            sessionTier: 'heartbeat-control',
            controlPath: 'heartbeat',
            controlSession: true,
            userInputAllowed: false,
          });
        }
        return ensured.id.trim();
      }
    }
    return sessionId;
  }

  private hasSession(sessionId: string): boolean {
    const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalized) return false;
    const getSession = (this.deps.sessionManager as {
      getSession?: (id: string) => unknown;
    }).getSession;
    if (typeof getSession !== 'function') return true;
    return !!getSession.call(this.deps.sessionManager, normalized);
  }

  private async runExecutionWatchdog(agentId: string, projectId?: string, preferredSessionId?: string): Promise<void> {
    const preferred = typeof preferredSessionId === 'string' ? preferredSessionId.trim() : '';
    if (projectId && !preferred) {
      const staleRoutes = listReviewRoutes().filter((route) => route.projectId === projectId);
      if (staleRoutes.length > 0) {
        let removed = 0;
        for (const route of staleRoutes) {
          if (removeReviewRoute(route.taskId)) removed += 1;
        }
        if (removed > 0) {
          log.info('[HeartbeatScheduler] Cleared stale project routes without bound session', {
            projectId,
            agentId,
            removed,
          });
        }
      }
      return;
    }
    if (projectId && preferred && !this.hasSession(preferred)) {
      log.debug('[HeartbeatScheduler] Skip project watchdog: preferred session missing', {
        projectId,
        agentId,
        preferredSessionId: preferred,
      });
      return;
    }
    const sessionId = projectId
      ? preferred
      : this.resolveLatestBoundSessionId(agentId, preferredSessionId);
    if (!sessionId) return;
    let lifecycle = getExecutionLifecycleState(this.deps.sessionManager, sessionId);
    if (lifecycle && this.shouldResetLifecycleAfterRestart(lifecycle)) {
      applyExecutionLifecycleTransition(this.deps.sessionManager, sessionId, {
        stage: 'completed',
        substage: 'watchdog_reset_after_stop',
        updatedBy: 'heartbeat-scheduler',
        targetAgentId: agentId,
        finishReason: 'stop',
        turnId: lifecycle.turnId,
        dispatchId: lifecycle.dispatchId,
        detail: 'watchdog reset: runtime stop was already reached before restart',
      });
      log.info('[HeartbeatScheduler] Watchdog reset stale stop lifecycle to completed', {
        sessionId,
        projectId,
        agentId,
        previousStage: lifecycle.stage,
        previousSubstage: lifecycle.substage ?? 'none',
        finishReason: lifecycle.finishReason ?? 'none',
      });
      lifecycle = getExecutionLifecycleState(this.deps.sessionManager, sessionId);
    }
    const lifecycleNeedsResume = lifecycle ? this.shouldResumeLifecycle(lifecycle) : false;
    let projectTaskState = this.resolveProjectTaskStateFromSession(sessionId);
    projectTaskState = this.tryAutoCloseStaleProjectTaskState({
      sessionId,
      targetAgentId: agentId,
      state: projectTaskState,
      lifecycle,
    });
    const projectRoutes = projectId
      ? listReviewRoutes().filter((route) => route.projectId === projectId)
      : [];
    const openRoutes = projectRoutes.filter((route) => {
      const routeSessionId = typeof route.projectSessionId === 'string' ? route.projectSessionId.trim() : '';
      if (routeSessionId && routeSessionId !== sessionId) return false;
      return this.isActionableReviewRoute(route, agentId);
    });
    const projectTaskActive = this.isActionableProjectTaskState(projectTaskState, agentId);
    const hasActionableWork = lifecycleNeedsResume || openRoutes.length > 0 || projectTaskActive;
    if (lifecycleNeedsResume && !projectTaskActive && openRoutes.length === 0 && lifecycle) {
      const lifecycleSubstage = typeof lifecycle.substage === 'string' ? lifecycle.substage.trim().toLowerCase() : '';
      const isStopToolPending = lifecycleSubstage === 'turn_stop_tool_pending';
      const lifecycleAgeMs = (() => {
        const ts = Date.parse(lifecycle.lastTransitionAt);
        return Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : Number.POSITIVE_INFINITY;
      })();
      const shouldSkipLifecycleOnlyWake = !isStopToolPending && (
        lifecycle.stage === 'failed'
        || lifecycle.stage === 'completed'
        || lifecycle.stage === 'interrupted'
        || lifecycleAgeMs >= 2 * 60 * 1000
      );
      if (shouldSkipLifecycleOnlyWake) {
        applyExecutionLifecycleTransition(this.deps.sessionManager, sessionId, {
          stage: 'completed',
          substage: 'watchdog_skip_lifecycle_only_no_actionable',
          updatedBy: 'heartbeat-scheduler',
          targetAgentId: agentId,
          detail: `skip lifecycle-only watchdog wake (stage=${lifecycle.stage}, ageMs=${Number.isFinite(lifecycleAgeMs) ? lifecycleAgeMs : -1})`,
          finishReason: 'stop',
        });
        log.info('[HeartbeatScheduler] Skip lifecycle-only watchdog wake (no actionable task)', {
          sessionId,
          projectId,
          agentId,
          lifecycleStage: lifecycle.stage,
          lifecycleSubstage: lifecycle.substage,
          lifecycleAgeMs: Number.isFinite(lifecycleAgeMs) ? lifecycleAgeMs : undefined,
        });
        return;
      }
    }
    if (projectId && projectRoutes.length > 0) {
      let removed = 0;
      for (const route of projectRoutes) {
        const routeSessionId = typeof route.projectSessionId === 'string' ? route.projectSessionId.trim() : '';
        const routeBoundToCurrent = !routeSessionId || routeSessionId === sessionId;
        if (routeBoundToCurrent && this.isActionableReviewRoute(route, agentId)) continue;
        if (removeReviewRoute(route.taskId)) removed += 1;
      }
      if (removed > 0) {
        log.info('[HeartbeatScheduler] Auto-cleaned stale review routes for project heartbeat', {
          projectId,
          agentId,
          removed,
          sessionId,
        });
      }
    }
    if (!hasActionableWork) {
      return;
    }

    const routeSummary = openRoutes.length > 0
      ? openRoutes.slice(0, 3).map((route) => route.taskName || route.taskId).join('；')
      : '';
    const watchdogReason = lifecycleNeedsResume ? 'lifecycle_resume' : 'open_task_resume';
    const watchdogTaskId = `watchdog:${watchdogReason}:${projectId ?? 'system'}`;
    const promptLines = [
      '# Execution Watchdog',
      lifecycleNeedsResume
        ? '检测到上一轮执行未 finish_reason=stop，请从中断点继续执行直到真正完成。'
        : '检测到该 agent 仍有未完成任务，请继续执行，不要提前停止。',
      `agent: ${agentId}`,
      `session: ${sessionId}`,
      lifecycle?.stage ? `lifecycle: ${lifecycle.stage}${lifecycle.substage ? `/${lifecycle.substage}` : ''}` : '',
      openRoutes.length > 0 ? `openTaskCount: ${openRoutes.length}` : '',
      routeSummary ? `openTasks: ${routeSummary}` : '',
    ].filter(Boolean);

    await this.dispatchDirect(
      agentId,
      watchdogTaskId,
      projectId,
      promptLines.join('\n'),
      { progressDelivery: normalizeProgressDeliveryPolicy({ mode: 'silent' }) ?? undefined },
      sessionId,
    );
  }

  private resolveProjectConfig(projectId: string, projectPath: string): HeartbeatProjectConfig {
    const byId = this.config.projects?.[projectId];
    if (byId) return byId;
    const normalizedPath = normalizeProjectPath(projectPath);
    for (const config of Object.values(this.config.projects ?? {})) {
      const candidates = [config.path, config.realPath]
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => normalizeProjectPath(item));
      if (candidates.includes(normalizedPath)) return config;
    }
    return {};
  }

  private shouldRun(key: string, intervalMs: number): boolean {
    return Date.now() - (this.lastRun.get(key) ?? 0) >= intervalMs;
  }

  private hasPendingHeartbeatTask(targetAgentId: string, taskId: string, projectId: string | undefined): boolean {
    const pending = heartbeatMailbox.list(targetAgentId, { status: 'pending', category: 'heartbeat-task' });
    return pending.some((message) => {
      const content = typeof message.content === 'object' && message.content ? message.content as Record<string, unknown> : {};
      return (typeof content.taskId === 'string' ? content.taskId.trim() : '') === taskId
        && (typeof content.projectId === 'string' ? content.projectId.trim() : '') === (projectId ?? '').trim();
    });
  }

  private async dispatchTask(
    targetAgentId: string, taskId: string, projectId: string | undefined, config?: HeartbeatTaskConfig,
    preferredSessionId?: string,
  ): Promise<void> {
    const projectPath = projectId ? await resolveProjectPath(projectId) : SYSTEM_PROJECT_PATH;
    if (projectId && !projectPath) {
      log.warn('[HeartbeatScheduler] Skip: project path not found', { targetAgentId, taskId, projectId });
      return;
    }

    let prompt = config?.prompt ?? '';
    if (!prompt && !projectId) {
      const pendingTasks = await readJsonlTasks();
      if (pendingTasks.length === 0) {
        log.debug('[HeartbeatScheduler] Skip: no pending tasks', { targetAgentId, taskId });
        return;
      }
      prompt = buildHeartbeatPrompt(pendingTasks);
    } else if (!prompt && projectId) {
      // Project heartbeat must not wake agents with a generic empty checklist prompt.
      // For monitored project agents, actionable wake-up is driven by runExecutionWatchdog
      // and explicit configured task prompts only.
      log.debug('[HeartbeatScheduler] Skip: empty project heartbeat prompt (watchdog-only mode)', {
        targetAgentId,
        taskId,
        projectId,
      });
      return;
    }
    if (!prompt.trim()) {
      log.debug('[HeartbeatScheduler] Skip: empty prompt', { targetAgentId, taskId, projectId });
      return;
    }

    if (config?.dispatch === 'dispatch') {
      await this.dispatchDirect(targetAgentId, taskId, projectId, prompt, config, preferredSessionId);
      return;
    }

    if (this.hasPendingHeartbeatTask(targetAgentId, taskId, projectId)) {
      log.debug('[HeartbeatScheduler] Skip: pending heartbeat task exists', { targetAgentId, taskId, projectId });
      return;
    }

    // 计算 mailbox 健康（用于 inject prompt）
    const now = Date.now();
    const systemMessages = heartbeatMailbox.list("finger-system-agent");
    const pending = systemMessages.filter(m => m.status === "pending");
    const processing = systemMessages.filter(m => m.status === "processing");
    const oldestPending = pending.length > 0 ? pending.reduce((a, b) => 
      (new Date(a.createdAt).getTime() < new Date(b.createdAt).getTime()) ? a : b) : null;
    const mailboxHealth = {
      pending: pending.length,
      processing: processing.length,
      oldestPendingAgeMs: oldestPending ? now - new Date(oldestPending.createdAt).getTime() : undefined,
    };
    
    const envelope = buildHeartbeatEnvelopeWithInject(prompt, this.heartbeatState, mailboxHealth, projectId);
    heartbeatMailbox.append(targetAgentId, {
      type: 'heartbeat-task', taskId, projectId, prompt, envelope, envelopeId: envelope.id, requiresFeedback: true,
    }, {
      sender: 'system-heartbeat', sourceType: 'control', category: 'heartbeat-task', priority: 1, metadata: { envelope },
    });
    log.debug('[HeartbeatScheduler] Appended heartbeat envelope', { agentId: targetAgentId, envelopeId: envelope.id, taskId });
  }

  private async dispatchDirect(
    targetAgentId: string,
    taskId: string,
    projectId: string | undefined,
    prompt: string,
    config?: HeartbeatTaskConfig | { progressDelivery?: ProgressDeliveryPolicy },
    preferredSessionId?: string,
  ): Promise<boolean> {
    const controlSessionId = await this.ensureHeartbeatControlSession(targetAgentId, projectId);
    const sessionId = typeof controlSessionId === 'string' ? controlSessionId.trim() : '';
    if (!sessionId) {
      log.warn('[HeartbeatScheduler] Skip dispatchDirect: heartbeat control session unresolved', {
        targetAgentId,
        taskId,
        projectId,
      });
      return false;
    }
    if (!this.hasSession(sessionId)) {
      log.warn('[HeartbeatScheduler] Skip dispatchDirect: heartbeat control session missing', {
        targetAgentId,
        taskId,
        projectId,
        sessionId,
      });
      return false;
    }
    try {
      const snapshot = await this.deps.agentRuntimeBlock.execute('runtime_view', {});
      const busyState = extractAgentStatusFromRuntimeView(snapshot, targetAgentId);
      if (busyState.busy !== false) {
        log.debug('[HeartbeatScheduler] Skip dispatchDirect: target busy or unknown', {
          targetAgentId,
          taskId,
          projectId,
          status: busyState.status ?? 'unknown',
        });
        return false;
      }
    } catch (error) {
      log.warn('[HeartbeatScheduler] runtime_view lookup failed; skip dispatchDirect', {
        targetAgentId,
        taskId,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    const resolvedProgressDelivery = config?.progressDelivery ?? DEFAULT_SCHEDULED_PROGRESS_DELIVERY;
    try {
      await this.deps.agentRuntimeBlock.execute('dispatch', {
        sourceAgentId: 'system-heartbeat', targetAgentId, task: prompt, sessionId,
        queueOnBusy: false,
        maxQueueWaitMs: 0,
        metadata: {
          source: 'system-heartbeat',
          sourceType: 'heartbeat',
          role: 'system',
          systemDirectInject: true,
          deliveryMode: 'direct',
          taskId,
          projectId,
          ...(resolvedProgressDelivery ? { scheduledProgressDelivery: resolvedProgressDelivery } : {}),
        },
        blocking: false,
      });
      return true;
    } catch (error) {
      log.warn('[HeartbeatScheduler] dispatchDirect execute failed', {
        targetAgentId,
        taskId,
        projectId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async promptMailboxChecks(): Promise<void> {
    await promptMailboxChecks({
      lastMailboxPromptAt: this.lastMailboxPromptAt,
      mailboxPromptDeferredByAgent: this.mailboxPromptDeferredByAgent,
      resolveMailboxCheckIntervalMs: (projectId?: string) => {
        const projectConfig = projectId ? this.config.projects?.[projectId] : undefined;
        const raw = projectConfig?.mailboxCheckIntervalMs
          ?? this.config.global?.mailboxCheckIntervalMs
          ?? DEFAULT_MAILBOX_CHECK_INTERVAL_MS;
        return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAILBOX_CHECK_INTERVAL_MS;
      },
      dispatchDirect: (targetAgentId, taskId, projectId, prompt, options) =>
        this.dispatchDirect(targetAgentId, taskId, projectId, prompt, options),
    });
  }

  private armTick(delayMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const normalized = Number.isFinite(delayMs) && delayMs >= 0 ? Math.floor(delayMs) : DEFAULT_TICK_MS;
    this.timer = setTimeout(() => {
      void this.tick();
    }, normalized);
    this.timer.unref?.();
  }

  private async loadRuntimeState(): Promise<void> {
    try {
      const raw = await fs.readFile(RUNTIME_STATE_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as HeartbeatRuntimeState;
      if (parsed.lastRun && typeof parsed.lastRun === 'object') {
        this.lastRun = new Map(Object.entries(parsed.lastRun)
          .filter(([, value]) => Number.isFinite(value as number))
          .map(([key, value]) => [key, Math.floor(value as number)]));
      }
      if (parsed.lastMailboxPromptAt && typeof parsed.lastMailboxPromptAt === 'object') {
        this.lastMailboxPromptAt = new Map(Object.entries(parsed.lastMailboxPromptAt)
          .filter(([, value]) => Number.isFinite(value as number))
          .map(([key, value]) => [key, Math.floor(value as number)]));
      }
      if (Array.isArray(parsed.mailboxPromptDeferredByAgent)) {
        this.mailboxPromptDeferredByAgent = new Set(
          parsed.mailboxPromptDeferredByAgent.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
        );
      }
      if (parsed.lastNightlyDreamByProject && typeof parsed.lastNightlyDreamByProject === 'object') {
        this.lastNightlyDreamByProject = new Map(
          Object.entries(parsed.lastNightlyDreamByProject)
            .filter(([key, value]) => typeof key === 'string' && key.trim().length > 0 && typeof value === 'string' && value.trim().length > 0)
            .map(([key, value]) => [key, value]),
        );
      }
      if (parsed.nightlyDreamDispatchState && typeof parsed.nightlyDreamDispatchState === 'object') {
        this.nightlyDreamDispatchState = new Map(
          Object.entries(parsed.nightlyDreamDispatchState)
            .filter(([key, value]) => typeof key === 'string' && key.trim().length > 0 && value && typeof value === 'object')
            .map(([key, value]) => [key, value as NightlyDreamDispatchState]),
        );
      }
      if (typeof parsed.lastDailySystemReviewDate === 'string' && parsed.lastDailySystemReviewDate.trim().length > 0) {
        this.lastDailySystemReviewDate = parsed.lastDailySystemReviewDate.trim();
      }
      if (parsed.dailySystemReviewDispatchState && typeof parsed.dailySystemReviewDispatchState === 'object') {
        this.dailySystemReviewDispatchState = parsed.dailySystemReviewDispatchState;
      }
      if (parsed.heartbeatState === 'RUNNING' || parsed.heartbeatState === 'DEGRADED' || parsed.heartbeatState === 'PAUSED' || parsed.heartbeatState === 'STOPPED') {
        this.heartbeatState = parsed.heartbeatState;
      }
      if (parsed.heartbeatStateContext && typeof parsed.heartbeatStateContext === 'object') {
        this.heartbeatStateContext = parsed.heartbeatStateContext;
      }
      if (typeof parsed.heartbeatStateChangedAt === 'number' && Number.isFinite(parsed.heartbeatStateChangedAt)) {
        this.heartbeatStateChangedAt = parsed.heartbeatStateChangedAt;
      }
      log.info('[HeartbeatScheduler] Runtime state loaded', {
        runKeys: this.lastRun.size,
        mailboxPromptKeys: this.lastMailboxPromptAt.size,
        nightlyDreamKeys: this.lastNightlyDreamByProject.size,
        dailySystemReviewDate: this.lastDailySystemReviewDate ?? undefined,
      });
    } catch {
      // No state file yet.
    }
  }

  // === 公开方法（供 Kernel Tools 调用） ===
  public getState(): HeartbeatState {
    return this.heartbeatState;
  }

  public getStateContext(): HeartbeatStateContext {
    return { ...this.heartbeatStateContext }; // 返回副本，防止外部修改
  }

  public requestStop(reason: string, permanent: boolean = false, resumeAfterMinutes?: number): void {
    const newState = permanent ? 'STOPPED' : 'PAUSED';
    this.transitionHeartbeatState(newState, reason);
    // 如果 resumeAfterMinutes 有值，设置自动恢复定时器
    if (resumeAfterMinutes && !permanent) {
      this.setAutoResumeTimer(resumeAfterMinutes, reason);
    }
  }

  public requestResume(reason: string): void {
    // 清理自动恢复定时器（如果手动恢复）
    this.clearAutoResumeTimer();
    
    if (this.heartbeatState === 'PAUSED' || this.heartbeatState === 'STOPPED') {
      this.transitionHeartbeatState('RUNNING', reason);
    } else {
      log.warn('[HeartbeatScheduler] Resume requested but state is not PAUSED/STOPPED', {
        currentState: this.heartbeatState,
        reason,
      });
    }
  }

  // === 自动恢复定时器 helper === 
  private setAutoResumeTimer(minutes: number, originalReason: string): void {
    this.clearAutoResumeTimer(); // 先清理已有定时器
    
    const resumeAfterMs = minutes * 60 * 1000;
    log.info('[HeartbeatScheduler] Setting auto-resume timer', { minutes, resumeAfterMs });
    
    this.autoResumeTimer = setTimeout(() => {
      if (this.heartbeatState === 'PAUSED') {
        log.info('[HeartbeatScheduler] Auto-resume triggered', { originalReason });
        this.requestResume('auto_resume_after_timeout: ' + originalReason);
      }
    }, resumeAfterMs);
  }

  private clearAutoResumeTimer(): void {
    if (this.autoResumeTimer) {
      clearTimeout(this.autoResumeTimer);
      this.autoResumeTimer = null;
      log.debug('[HeartbeatScheduler] Auto-resume timer cleared');
    }
  }

  // === 私有方法 ===

  private async persistRuntimeState(): Promise<void> {
    const state: HeartbeatRuntimeState = {
      lastRun: Object.fromEntries(this.lastRun.entries()),
      lastMailboxPromptAt: Object.fromEntries(this.lastMailboxPromptAt.entries()),
      mailboxPromptDeferredByAgent: Array.from(this.mailboxPromptDeferredByAgent.values()),
      lastNightlyDreamByProject: Object.fromEntries(this.lastNightlyDreamByProject.entries()),
      nightlyDreamDispatchState: Object.fromEntries(this.nightlyDreamDispatchState.entries()),
      ...(this.lastDailySystemReviewDate ? { lastDailySystemReviewDate: this.lastDailySystemReviewDate } : {}),
      ...(this.dailySystemReviewDispatchState ? { dailySystemReviewDispatchState: this.dailySystemReviewDispatchState } : {}),
      heartbeatState: this.heartbeatState,
      heartbeatStateContext: this.heartbeatStateContext,
      heartbeatStateChangedAt: this.heartbeatStateChangedAt,
    };
    await writeFileAtomic(RUNTIME_STATE_PATH, JSON.stringify(state, null, 2));
  }
}
