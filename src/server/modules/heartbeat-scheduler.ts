import { promises as fs, watch, type FSWatcher } from 'fs';
import path from 'path';
import { logger } from '../../core/logger.js';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { heartbeatMailbox } from './heartbeat-mailbox.js';
import { listAgents } from '../../agents/finger-system-agent/registry.js';
import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import { SessionControlPlaneStore } from '../../runtime/session-control-plane.js';

const log = logger.module('HeartbeatScheduler');

type DispatchMode = 'mailbox' | 'dispatch';

interface HeartbeatTaskConfig {
  intervalMs?: number;
  enabled?: boolean;
  dispatch?: DispatchMode;
  prompt?: string;
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
const CONFIG_PATH = path.join(FINGER_PATHS.config.dir, 'heartbeat-tasks.json');
const CONFIG_RELOAD_DEBOUNCE_MS = 1000;

export class HeartbeatScheduler {
  private timer: NodeJS.Timeout | null = null;
  private configWatcher: FSWatcher | null = null;
  private config: HeartbeatConfig = {};
  private lastConfigReloadAt = 0;
  private lastRun: Map<string, number> = new Map();
  private lastMailboxPromptAt: Map<string, number> = new Map();

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
    const dispatchMode = config?.dispatch ?? 'mailbox';
    const prompt = config?.prompt
      ?? `# Heartbeat Check\n\n请检查项目根目录的 HEARTBEAT.md 并执行待办任务。\n\n` +
         (projectId ? `项目ID: ${projectId}\n` : '');

    if (dispatchMode === 'dispatch') {
      await this.dispatchDirect(targetAgentId, taskId, projectId, prompt);
      return;
    }

    const mailboxPayload = {
      type: 'heartbeat-task',
      taskId,
      projectId,
      prompt,
      requiresFeedback: true,
    };
    heartbeatMailbox.append(targetAgentId, mailboxPayload, {
      sender: 'system-heartbeat',
      sourceType: 'control',
      category: 'notification',
      priority: 1,
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
    if (!latest) return;

    await this.deps.agentRuntimeBlock.execute('dispatch', {
      sourceAgentId: 'system-heartbeat',
      targetAgentId,
      task: prompt,
      sessionId: latest.fingerSessionId,
      metadata: {
        source: 'system-heartbeat',
        role: 'system',
        taskId,
        projectId,
      },
      blocking: false,
    });
  }

  private async promptMailboxChecks(): Promise<void> {
    const agents = await listAgents();
    for (const agent of agents) {
      // Allow idle and completed agents to receive mailbox tasks
      if (agent.status !== 'idle' && agent.status !== 'completed') continue;
      const pending = heartbeatMailbox.listPending(agent.agentId) ?? [];
      if (pending.length === 0) continue;

      const now = Date.now();
      const lastPrompt = this.lastMailboxPromptAt.get(agent.agentId) ?? 0;
      if (now - lastPrompt < DEFAULT_TICK_MS) continue;

      const lines = [
        '# Mailbox Check',
        '你有待处理的系统任务，请逐条执行。',
        '每个任务完成后必须调用 report-task-completion 工具提交 summary。',
        '如果提交失败必须重试直到成功，避免断链。',
        '',
        '待办任务列表：',
      ];

      for (const msg of pending) {
        const content = typeof msg.content === 'object' && msg.content ? msg.content as Record<string, unknown> : {};
        const taskId = typeof content.taskId === 'string' ? content.taskId : 'unknown';
        const projectId = typeof content.projectId === 'string' ? content.projectId : 'unknown';
        lines.push(`- messageId=${msg.id} taskId=${taskId} projectId=${projectId}`);
      }

      const prompt = lines.join('\n');
      await this.dispatchDirect(agent.agentId, 'mailbox-check', agent.projectId, prompt);
      this.lastMailboxPromptAt.set(agent.agentId, now);
    }
  }
}
