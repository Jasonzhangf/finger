import { promises as fs, watch, type FSWatcher } from 'fs';
import path from 'path';
import { logger } from '../../core/logger.js';
import { extractAgentStatusFromRuntimeView } from '../../core/agent-runtime-status.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { heartbeatMailbox } from './heartbeat-mailbox.js';
import { listAgents } from '../../agents/finger-system-agent/registry.js';
import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import { SessionControlPlaneStore } from '../../runtime/session-control-plane.js';
import { SYSTEM_PROJECT_PATH } from '../../agents/finger-system-agent/index.js';
import { buildHeartbeatEnvelope, type MailboxEnvelope } from './mailbox-envelope.js';
import {
  resolveProjectPath,
  promptMailboxChecks,
} from './heartbeat-helpers.js';
import type { ProgressDeliveryPolicy } from '../../common/progress-delivery-policy.js';
import { normalizeProgressDeliveryPolicy } from '../../common/progress-delivery-policy.js';

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
}

interface LoadConfigResult {
  ok: boolean;
  config?: HeartbeatConfig;
  error?: string;
  created?: boolean;
}

const DEFAULT_TICK_MS = 10_000;
const DEFAULT_TASK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAILBOX_CHECK_INTERVAL_MS = 5 * 60_000;
const CONFIG_PATH = path.join(FINGER_PATHS.runtime.schedulesDir, 'heartbeat-config.jsonl');
const TASK_PATH = path.join(FINGER_PATHS.runtime.schedulesDir, 'heartbeat-tasks.jsonl');
const RUNTIME_STATE_PATH = path.join(FINGER_PATHS.runtime.schedulesDir, 'heartbeat-runtime-state.json');
const CONFIG_RELOAD_DEBOUNCE_MS = 1000;
const SYSTEM_AGENT_ID = 'finger-system-agent';
const DEFAULT_SCHEDULED_PROGRESS_DELIVERY = normalizeProgressDeliveryPolicy({ mode: 'result_only' });

function normalizeProjectPath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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
  private configWatcher: FSWatcher | null = null;
  private config: HeartbeatConfig = {};
  private lastConfigReloadAt = 0;
  private lastRun: Map<string, number> = new Map();
  private lastMailboxPromptAt: Map<string, number> = new Map();
  private mailboxPromptDeferredByAgent: Set<string> = new Set();
  private ticking = false;

  constructor(private deps: AgentRuntimeDeps) {}

  async start(): Promise<void> {
    await this.loadConfig();
    await this.loadRuntimeState();
    this.watchConfig();
    if (!this.timer) {
      this.armTick(0);
      log.info(`[HeartbeatScheduler] Started (tick=${DEFAULT_TICK_MS}ms)`);
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
        };
        await fs.appendFile(CONFIG_PATH,
          `${JSON.stringify({ ts: new Date().toISOString(), type: 'heartbeat_config', config: defaultConfig })}\n`, 'utf-8');
        this.config = defaultConfig;
        log.info('[HeartbeatScheduler] Default config created');
        return { ok: true, config: defaultConfig, created: true };
      }
      this.config = await readJsonlHeartbeatConfig(CONFIG_PATH);
      this.lastConfigReloadAt = Date.now();
      log.info('[HeartbeatScheduler] Config loaded');
      return { ok: true, config: this.config, created: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('[HeartbeatScheduler] Failed to load config', { message });
      return { ok: false, error: message };
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
    try { await this.dispatchDueTasks(); }
    catch (error) { log.error('[HeartbeatScheduler] dispatchDueTasks error', error instanceof Error ? error : undefined); }
    try { await this.promptMailboxChecks(); }
    catch (error) { log.error('[HeartbeatScheduler] promptMailboxChecks error', error instanceof Error ? error : undefined); }
    try { await this.persistRuntimeState(); }
    catch (error) { log.error('[HeartbeatScheduler] persistRuntimeState error', error instanceof Error ? error : undefined); }
    this.ticking = false;
    this.armTick(DEFAULT_TICK_MS);
  }

  private async dispatchDueTasks(): Promise<void> {
    const agents = await listAgents();
    const monitoredAgents = agents.filter((a) => a.monitored === true);

    if (this.config.global?.enabled !== false) {
      const interval = this.config.global?.intervalMs ?? DEFAULT_TASK_INTERVAL_MS;
      if (this.shouldRun('global', interval)) {
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
      const projectConfig = this.resolveProjectConfig(agent.projectId, agent.projectPath);
      if (projectConfig.enabled === false) continue;
      const projectKey = `project:${projectId}`;
      const projectInterval = projectConfig.intervalMs ?? this.config.global?.intervalMs ?? DEFAULT_TASK_INTERVAL_MS;
      if (this.shouldRun(projectKey, projectInterval)) {
        await this.dispatchTask(agent.agentId, projectKey, projectId, projectConfig);
        this.lastRun.set(projectKey, Date.now());
      }
      for (const [taskId, taskConfig] of Object.entries(projectConfig.tasks ?? {})) {
        if (taskConfig.enabled === false) continue;
        const taskKey = `task:${projectId}:${taskId}`;
        const taskInterval = taskConfig.intervalMs ?? projectInterval;
        if (this.shouldRun(taskKey, taskInterval)) {
          await this.dispatchTask(agent.agentId, taskId, projectId, taskConfig);
          this.lastRun.set(taskKey, Date.now());
        }
      }
    }
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
      prompt = buildHeartbeatPrompt([]);
    }
    if (!prompt.trim()) {
      log.debug('[HeartbeatScheduler] Skip: empty prompt', { targetAgentId, taskId, projectId });
      return;
    }

    if (config?.dispatch === 'dispatch') {
      await this.dispatchDirect(targetAgentId, taskId, projectId, prompt, config);
      return;
    }

    if (this.hasPendingHeartbeatTask(targetAgentId, taskId, projectId)) {
      log.debug('[HeartbeatScheduler] Skip: pending heartbeat task exists', { targetAgentId, taskId, projectId });
      return;
    }

    const envelope = buildHeartbeatEnvelope(prompt, projectId);
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
  ): Promise<void> {
    const sessionStore = new SessionControlPlaneStore();
    const getSession = (this.deps.sessionManager as {
      getSession?: (sessionId: string) => unknown;
    }).getSession;
    const bindings = sessionStore.list({ agentId: targetAgentId, provider: 'finger' });
    const validBinding = bindings.find((binding) => (
      typeof getSession === 'function' ? !!getSession.call(this.deps.sessionManager, binding.fingerSessionId) : true
    ));
    let sessionId = validBinding?.fingerSessionId;
    if (!sessionId && bindings.length > 0) {
      log.warn('[HeartbeatScheduler] Skip stale session-control-plane bindings and self-heal', {
        targetAgentId,
        staleBindingCount: bindings.length,
      });
    }
    if (!sessionId && targetAgentId === SYSTEM_AGENT_ID) {
      const getSystemSession = (this.deps.sessionManager as any)?.getOrCreateSystemSession;
      if (typeof getSystemSession === 'function') {
        const systemSession = getSystemSession.call(this.deps.sessionManager);
        if (systemSession?.id && typeof systemSession.id === 'string') {
          const healedSessionId = systemSession.id.trim();
          sessionId = healedSessionId;
          try {
            sessionStore.set(
              healedSessionId,
              targetAgentId,
              'finger',
              healedSessionId,
              { source: 'heartbeat-scheduler-self-heal' },
            );
          } catch (error) {
            log.warn('[HeartbeatScheduler] Failed to persist healed system session binding', {
              targetAgentId,
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
    if (!sessionId) {
      log.debug('[HeartbeatScheduler] Skip dispatchDirect: no session', { targetAgentId, taskId, projectId });
      return;
    }
    try {
      const snapshot = await this.deps.agentRuntimeBlock.execute('runtime_view', {});
      const busyState = extractAgentStatusFromRuntimeView(snapshot, targetAgentId);
      if (busyState.busy !== false) {
        log.debug('[HeartbeatScheduler] Skip dispatchDirect: target busy or unknown, mailbox only', {
          targetAgentId,
          taskId,
          projectId,
          status: busyState.status ?? 'unknown',
        });
        return;
      }
    } catch (error) {
      log.warn('[HeartbeatScheduler] runtime_view lookup failed; keep mailbox only', {
        targetAgentId,
        taskId,
        projectId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const resolvedProgressDelivery = config?.progressDelivery ?? DEFAULT_SCHEDULED_PROGRESS_DELIVERY;
    await this.deps.agentRuntimeBlock.execute('dispatch', {
      sourceAgentId: 'system-heartbeat', targetAgentId, task: prompt, sessionId,
      metadata: {
        source: 'system-heartbeat',
        role: 'system',
        systemDirectInject: true,
        deliveryMode: 'direct',
        taskId,
        projectId,
        ...(resolvedProgressDelivery ? { scheduledProgressDelivery: resolvedProgressDelivery } : {}),
      },
      blocking: false,
    });
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
      log.info('[HeartbeatScheduler] Runtime state loaded', {
        runKeys: this.lastRun.size,
        mailboxPromptKeys: this.lastMailboxPromptAt.size,
      });
    } catch {
      // No state file yet.
    }
  }

  private async persistRuntimeState(): Promise<void> {
    const state: HeartbeatRuntimeState = {
      lastRun: Object.fromEntries(this.lastRun.entries()),
      lastMailboxPromptAt: Object.fromEntries(this.lastMailboxPromptAt.entries()),
      mailboxPromptDeferredByAgent: Array.from(this.mailboxPromptDeferredByAgent.values()),
    };
    const tempPath = `${RUNTIME_STATE_PATH}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tempPath, RUNTIME_STATE_PATH);
  }
}
