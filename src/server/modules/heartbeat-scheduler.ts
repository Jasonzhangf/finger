import { promises as fs, watch, type FSWatcher } from 'fs';
import path from 'path';
import { logger } from '../../core/logger.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { heartbeatMailbox } from './heartbeat-mailbox.js';
import { listAgents } from '../../agents/finger-system-agent/registry.js';
import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import { SessionControlPlaneStore } from '../../runtime/session-control-plane.js';
import {
  resolveHeartbeatMdPath,
  shouldStopHeartbeat,
  validateHeartbeatMd,
  truncateHeartbeatRecords,
  checkHeartbeatNeedsTruncation,
} from './heartbeat-md-parser.js';
import { buildHeartbeatEnvelope, formatEnvelopesForContext, type MailboxEnvelope } from './mailbox-envelope.js';
import { formatLegacyMailboxPrompt, resolveProjectPath, dispatchAutoRepairTask, buildMailboxCheckTargets, cleanupDispatchResultNotifications } from './heartbeat-helpers.js';

const log = logger.module('HeartbeatScheduler');

type DispatchMode = 'mailbox' | 'dispatch';

interface HeartbeatTaskConfig {
  intervalMs?: number;
  enabled?: boolean;
  dispatch?: DispatchMode;
  prompt?: string;
  mailboxCheckIntervalMs?: number;
}

interface HeartbeatProjectConfig extends HeartbeatTaskConfig {
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

const DEFAULT_TICK_MS = 10_000; // 10 seconds (configurable via heartbeat-tasks.json)
const DEFAULT_TASK_INTERVAL_MS = 5 * 60_000; // 5 minutes
const DEFAULT_MAILBOX_CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes
const HEARTBEAT_RECORDS_MAX = 10;
const HEARTBEAT_TRUNCATE_CHECK_INTERVAL_MS = 10 * 60_000; // 10 minutes
const CONFIG_PATH = path.join(FINGER_PATHS.config.dir, 'heartbeat-tasks.json');
const CONFIG_RELOAD_DEBOUNCE_MS = 1000;
const SYSTEM_AGENT_ID = 'finger-system-agent';

export class HeartbeatScheduler {
  private timer: NodeJS.Timeout | null = null;
  private configWatcher: FSWatcher | null = null;
  private config: HeartbeatConfig = {};
  private lastConfigReloadAt = 0;
  private lastRun: Map<string, number> = new Map();
  private lastMailboxPromptAt: Map<string, number> = new Map();
  private mailboxPromptDeferredByAgent: Set<string> = new Set();
  private lastHeartbeatTruncateCheckAt = 0;

  constructor(private deps: AgentRuntimeDeps) {}

  async start(): Promise<void> {
    await this.loadConfig();
    this.watchConfig();
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick();
      }, DEFAULT_TICK_MS);
      log.info(`[HeartbeatScheduler] Started (tick=${DEFAULT_TICK_MS}ms)`);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.configWatcher) {
      this.configWatcher.close();
      this.configWatcher = null;
    }
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
        await fs.writeFile(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2), 'utf-8');
        this.config = defaultConfig;
        log.info('[HeartbeatScheduler] Default config created');
        return { ok: true, config: defaultConfig, created: true };
      }
      const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
      let parsed: HeartbeatConfig;
      try {
        parsed = JSON.parse(raw) as HeartbeatConfig;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn('[HeartbeatScheduler] Failed to parse config', { message });
        return { ok: false, error: message };
      }
      this.config = parsed;
      this.lastConfigReloadAt = Date.now();
      log.info('[HeartbeatScheduler] Config loaded');
      return { ok: true, config: parsed };
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
        const now = Date.now();
        if (now - this.lastConfigReloadAt < CONFIG_RELOAD_DEBOUNCE_MS) return;
        void this.loadConfig();
      });
      log.info(`[HeartbeatScheduler] Watching config: ${CONFIG_PATH}`);
    } catch (error) {
      log.error('[HeartbeatScheduler] Failed to watch config', error instanceof Error ? error : undefined);
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.trimHeartbeatRecordsIfNeeded();
    } catch (error) {
      log.error('[HeartbeatScheduler] trimHeartbeatRecordsIfNeeded error', error instanceof Error ? error : undefined);
    }
    try {
      await this.dispatchDueTasks();
    } catch (error) {
      log.error('[HeartbeatScheduler] dispatchDueTasks error', error instanceof Error ? error : undefined);
    }
    try {
      await this.promptMailboxChecks();
    } catch (error) {
      log.error('[HeartbeatScheduler] promptMailboxChecks error', error instanceof Error ? error : undefined);
    }
  }

  private async trimHeartbeatRecordsIfNeeded(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHeartbeatTruncateCheckAt < HEARTBEAT_TRUNCATE_CHECK_INTERVAL_MS) {
      return;
    }
    this.lastHeartbeatTruncateCheckAt = now;

    const heartbeatMdPath = resolveHeartbeatMdPath('finger-system-agent', undefined, FINGER_PATHS.home);
    if (!heartbeatMdPath) return;

    const needsTruncate = await checkHeartbeatNeedsTruncation(heartbeatMdPath, HEARTBEAT_RECORDS_MAX * 2);
    if (!needsTruncate) return;

    const result = await truncateHeartbeatRecords(heartbeatMdPath, HEARTBEAT_RECORDS_MAX);
    if (result.truncated) {
      log.info('[HeartbeatScheduler] Truncated HEARTBEAT.md records', {
        path: heartbeatMdPath,
        before: result.before,
        after: result.after,
      });
    }
  }

  private async dispatchDueTasks(): Promise<void> {
    const agents = await listAgents();
    const projectById = new Map(agents.map(a => [a.projectId, a]));

    // Global task
    if (this.config.global?.enabled !== false) {
      const interval = this.config.global?.intervalMs ?? DEFAULT_TASK_INTERVAL_MS;
      if (this.shouldRun('global', interval)) {
        await this.dispatchTask('finger-system-agent', 'global', undefined, this.config.global);
        this.lastRun.set('global', Date.now());
      }
    }

    // Project tasks
    for (const [projectId, projectConfig] of Object.entries(this.config.projects ?? {})) {
      if (projectConfig.enabled === false) continue;
      const agent = projectById.get(projectId);
      if (!agent) continue;

      // Project-level heartbeat
      const projectKey = `project:${projectId}`;
      const projectInterval = projectConfig.intervalMs ?? this.config.global?.intervalMs ?? DEFAULT_TASK_INTERVAL_MS;
      if (this.shouldRun(projectKey, projectInterval)) {
        await this.dispatchTask(agent.agentId, projectKey, projectId, projectConfig);
        this.lastRun.set(projectKey, Date.now());
      }

      // Task-level overrides
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

  private shouldRun(key: string, intervalMs: number): boolean {
    const last = this.lastRun.get(key) ?? 0;
    return Date.now() - last >= intervalMs;
  }

  private async dispatchTask(
    targetAgentId: string,
    taskId: string,
    projectId: string | undefined,
    config?: HeartbeatTaskConfig,
  ): Promise<void> {
    const heartbeatMdPath = resolveHeartbeatMdPath(projectId, await resolveProjectPath(projectId), FINGER_PATHS.home);

    // Validate HEARTBEAT.md format
    if (heartbeatMdPath) {
      const validation = await validateHeartbeatMd(heartbeatMdPath);
      if (!validation.valid) {
        log.warn('[HeartbeatScheduler] HEARTBEAT.md validation failed', {
          projectId,
          heartbeatMdPath,
          errors: validation.errors,
          warnings: validation.warnings,
        });

        // Dispatch auto-repair task to system agent
        dispatchAutoRepairTask(projectId, heartbeatMdPath, validation);

        // Do not proceed with heartbeat dispatch when format is invalid
        return;
      }

      // Check auto-stop conditions
      const stopResult = await shouldStopHeartbeat(heartbeatMdPath);
      if (stopResult.shouldStop) {
        log.info('[HeartbeatScheduler] Heartbeat auto-stop triggered', {
          projectId,
          heartbeatMdPath,
          reason: stopResult.reason,
        });
        return;
      }
    }

    const dispatchMode = config?.dispatch ?? 'mailbox';
    const prompt = config?.prompt
      ?? `# Heartbeat Check\n\n请检查项目根目录的 HEARTBEAT.md 并执行待办任务。\n\n` +
         (projectId ? `项目ID: ${projectId}\n` : '');

    if (dispatchMode === 'dispatch') {
      await this.dispatchDirect(targetAgentId, taskId, projectId, prompt);
      return;
    }

    const envelope = buildHeartbeatEnvelope(prompt, projectId);
    heartbeatMailbox.append(targetAgentId, {
      type: 'heartbeat-task',
      taskId,
      projectId,
      prompt,
      envelope,
      envelopeId: envelope.id,
      requiresFeedback: true,
    }, {
      sender: 'system-heartbeat',
      sourceType: 'control',
      category: 'heartbeat-task',
      priority: 1,
      metadata: { envelope },
    });
    log.debug('[HeartbeatScheduler] Appended heartbeat envelope to mailbox', {
      agentId: targetAgentId,
      envelopeId: envelope.id,
      taskId,
    });
  }

  private async dispatchDirect(
    targetAgentId: string,
    taskId: string,
    projectId: string | undefined,
    prompt: string,
  ): Promise<void> {
    const sessionStore = new SessionControlPlaneStore();
    const bindings = sessionStore.list({ agentId: targetAgentId });
    const latest = bindings[0];
    let sessionId = latest?.fingerSessionId;
    if (!sessionId && targetAgentId === SYSTEM_AGENT_ID) {
      const getSystemSession = (this.deps.sessionManager as any)?.getOrCreateSystemSession;
      if (typeof getSystemSession === 'function') {
        const systemSession = getSystemSession.call(this.deps.sessionManager);
        if (systemSession?.id && typeof systemSession.id === 'string') {
          sessionId = systemSession.id;
        }
      }
    }
    if (!sessionId) {
      log.debug('[HeartbeatScheduler] Skip dispatchDirect without session binding', {
        targetAgentId,
        taskId,
        projectId,
      });
      return;
    }

    await this.deps.agentRuntimeBlock.execute('dispatch', {
      sourceAgentId: 'system-heartbeat',
      targetAgentId,
      task: prompt,
      sessionId,
      metadata: {
        source: 'system-heartbeat',
        role: 'system',
        systemDirectInject: true,
        deliveryMode: 'direct',
        taskId,
        projectId,
      },
      blocking: false,
    });
  }

  private async promptMailboxChecks(): Promise<void> {
    const projectAgents = await listAgents();
    const agents = buildMailboxCheckTargets(projectAgents);
    for (const agent of agents) {
      const now = Date.now();
      const mailboxCheckIntervalMs = this.resolveMailboxCheckIntervalMs(agent.projectId);
      const lastPrompt = this.lastMailboxPromptAt.get(agent.agentId) ?? 0;
      const due = now - lastPrompt >= mailboxCheckIntervalMs;

      // Need pending snapshot before busy check:
      // if check time arrives while busy, remember deferred check and execute it
      // at the first idle window.
      const pendingAll = heartbeatMailbox.listPending(agent.agentId) ?? [];

      // Skip agents that are actively executing tasks
      if (agent.status === 'busy') {
        if (due && pendingAll.length > 0) {
          this.mailboxPromptDeferredByAgent.add(agent.agentId);
        }
        log.debug('[HeartbeatScheduler] Skipping busy agent', { agentId: agent.agentId, status: agent.status });
        continue;
      }

      const notificationCleanup = cleanupDispatchResultNotifications(agent.agentId);
      if (notificationCleanup.removed > 0) {
        log.debug('[HeartbeatScheduler] Cleaned dispatch-result notifications', {
          agentId: agent.agentId,
          matched: notificationCleanup.matched,
          removed: notificationCleanup.removed,
        });
      }

      if (pendingAll.length === 0) continue;

      const actionablePending = pendingAll.filter((msg) => msg.category !== 'notification');
      const notificationOnly = actionablePending.length === 0;
      const pending = notificationOnly ? pendingAll : actionablePending;
      const deferredNotificationCount = notificationOnly ? 0 : pendingAll.length - actionablePending.length;
      if (pending.length === 0) continue;

      const deferred = this.mailboxPromptDeferredByAgent.has(agent.agentId);
      if (!deferred && !due) continue;

      // Build envelopes from pending messages
      const envelopes: MailboxEnvelope[] = [];
      const messageRefs: string[] = [];
      for (const msg of pending) {
        const msgContent = typeof msg.content === 'object' && msg.content ? msg.content as Record<string, unknown> : {};
        const storedEnvelope = typeof msgContent.envelope === 'object' && msgContent.envelope
          ? msgContent.envelope as MailboxEnvelope
          : undefined;
        if (storedEnvelope) {
          envelopes.push(storedEnvelope);
        } else if (msgContent.envelopeId) {
          // Reconstruct a minimal envelope from stored content for formatting
          const prompt = typeof msgContent.prompt === 'string' ? msgContent.prompt : '';
          const projectId = typeof msgContent.projectId === 'string' ? msgContent.projectId : undefined;
          if (prompt) {
            envelopes.push(buildHeartbeatEnvelope(prompt, projectId));
          }
        }
        const refParts = [
          `messageId=${msg.id}`,
          typeof msgContent.dispatchId === 'string' ? `dispatchId=${msgContent.dispatchId}` : null,
          typeof msgContent.taskId === 'string' ? `taskId=${msgContent.taskId}` : null,
        ].filter((part): part is string => typeof part === 'string');
        messageRefs.push(`- ${refParts.join(' ')}`);
      }

      // Format mailbox context using envelope builder
      const mailboxContext = envelopes.length > 0
        ? formatEnvelopesForContext(envelopes)
        : formatLegacyMailboxPrompt(pending);

      const prompt = [
        mailboxContext,
        '',
        ...(deferredNotificationCount > 0
          ? [`还有 ${deferredNotificationCount} 条 notification 已延后，等当前待办清空后再读。`, '']
          : []),
        '待确认消息：',
        ...(messageRefs.length > 0 ? messageRefs : ['- (none)']),
        '',
        ...(notificationOnly
          ? [
              '处理规则：',
              '1. 这些是 notification 类消息，只在空闲时阅读。',
              '2. 少量通知可直接 mailbox.read(id)；如果通知很多，优先用 mailbox.read_all({ category: "notification", unreadOnly: true }) 批量标记已读。',
              '3. 如果只是通知，不需要 ack，也不要强行 report-task-completion；清理已消费通知可用 mailbox.remove_all({ category: "notification" })。',
              '4. 如果读到其中包含真正待执行任务，再按任务语义处理。',
            ]
          : [
              '处理规则：',
              '1. 少量任务可逐条 mailbox.read(id)；如果同类待办很多，可先用 mailbox.read_all({ unreadOnly: true, category: "<category>" }) 批量读取，并将 pending 任务切到 processing。',
              '2. 只有真正处理完成后才能调用 mailbox.ack(id, { summary/result })；失败时用 mailbox.ack(id, { status: "failed", error })。ack 后消息会自动清理。',
              '3. 如果暂时无法处理，不要 ack；未读取的保持 pending，已读取的保持 processing。手动 mailbox.remove_all(...) 只用于清理 notification 或历史噪音。',
              '',
              '每个任务完成后必须调用 report-task-completion 工具提交 summary。',
              '如果提交失败必须重试直到成功，避免断链。',
            ]),
      ].join('\n');
      await this.dispatchDirect(agent.agentId, 'mailbox-check', agent.projectId, prompt);
      this.lastMailboxPromptAt.set(agent.agentId, now);
      this.mailboxPromptDeferredByAgent.delete(agent.agentId);
    }
  }

  private resolveMailboxCheckIntervalMs(projectId?: string): number {
    const projectConfig = projectId ? this.config.projects?.[projectId] : undefined;
    const raw = projectConfig?.mailboxCheckIntervalMs
      ?? this.config.global?.mailboxCheckIntervalMs
      ?? DEFAULT_MAILBOX_CHECK_INTERVAL_MS;
    return Number.isFinite(raw) && raw > 0
      ? Math.floor(raw)
      : DEFAULT_MAILBOX_CHECK_INTERVAL_MS;
  }

}
