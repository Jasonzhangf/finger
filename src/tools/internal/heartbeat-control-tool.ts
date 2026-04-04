import type { InternalTool } from './types.js';
import path from 'path';
import { promises as fs } from 'fs';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { logger } from '../../core/logger.js';

const log = logger.module('HeartbeatControlTool');

const MAX_INTERVAL_MS = 3_600_000; // 1 hour max

interface HeartbeatConfig {
  global?: { enabled?: boolean; intervalMs?: number; dispatch?: string };
  projects?: Record<string, { enabled?: boolean }>;
}

interface HeartbeatConfigRecord {
  ts: string;
  type: 'heartbeat_config';
  config: HeartbeatConfig;
}

interface HeartbeatTaskRecord {
  ts: string;
  type: 'heartbeat_task';
  action: 'add' | 'complete' | 'remove' | 'batch_add' | 'batch_complete' | 'batch_remove';
  task: {
    text: string;
    section?: string;
    status?: 'pending' | 'completed';
  };
  batch?: Array<{ text: string; section?: string; status?: 'pending' | 'completed' }>;
}

const CONFIG_PATH = path.join(FINGER_PATHS.runtime.schedulesDir, 'heartbeat-config.jsonl');
const TASK_PATH = path.join(FINGER_PATHS.runtime.schedulesDir, 'heartbeat-tasks.jsonl');

// ---------- Config IO ----------

async function readConfig(): Promise<HeartbeatConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const r = JSON.parse(lines[i]) as HeartbeatConfigRecord;
        if (r?.type === 'heartbeat_config' && typeof r.config === 'object') return r.config ?? {};
      } catch (err) {
        log.debug('[heartbeat.readConfig] Invalid config line skipped', {
          lineIndex: i,
          error: err instanceof Error ? err.message : String(err),
          linePreview: lines[i]?.slice(0, 120) ?? '',
        });
      }
    }
    return {};
  } catch (err) {
    log.warn('[heartbeat.readConfig] Failed to read config file, fallback to empty config', {
      path: CONFIG_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

async function writeConfig(config: HeartbeatConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.appendFile(CONFIG_PATH,
    `${JSON.stringify({ ts: new Date().toISOString(), type: 'heartbeat_config', config } as HeartbeatConfigRecord)}\n`, 'utf-8');
}

function clampInterval(intervalMs?: number): number {
  const val = typeof intervalMs === 'number' && intervalMs > 0 ? Math.floor(intervalMs) : 300_000;
  return Math.min(val, MAX_INTERVAL_MS);
}

function buildLongIntervalPrompt(intervalMs: number): string {
  return `\n⚠️ 心跳间隔已达到上限（${Math.round(intervalMs / 60000)} 分钟）。请检查当前所有任务是否空闲，此唤醒间隔是否仍然合理。如果不合理，请用 heartbeat.enable 缩短间隔。`;
}

// ---------- Task IO ----------

async function readTaskRecords(): Promise<HeartbeatTaskRecord[]> {
  try {
    const raw = await fs.readFile(TASK_PATH, 'utf-8');
    return raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).map((l) => JSON.parse(l) as HeartbeatTaskRecord);
  } catch (err) {
    log.warn('[heartbeat.readTaskRecords] Failed to read task records, fallback to empty list', {
      path: TASK_PATH,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function appendTaskRecord(record: HeartbeatTaskRecord): Promise<void> {
  await fs.mkdir(path.dirname(TASK_PATH), { recursive: true });
  await fs.appendFile(TASK_PATH, `${JSON.stringify(record)}\n`, 'utf-8');
}

function resolveCurrentTasks(records: HeartbeatTaskRecord[]): Array<{
  text: string;
  section: string;
  status: 'pending' | 'completed';
  ts: string;
}> {
  const byText = new Map<string, { text: string; section: string; status: 'pending' | 'completed'; ts: string }>();
  for (const rec of records) {
    if (rec.type !== 'heartbeat_task') continue;

    // Handle batch records
    if (rec.action === 'batch_add' && Array.isArray(rec.batch)) {
      for (const item of rec.batch) {
        const text = (item.text ?? '').trim();
        if (!text) continue;
        byText.set(text, {
          text,
          section: (item.section ?? '未分类').trim() || '未分类',
          status: 'pending',
          ts: rec.ts,
        });
      }
      continue;
    }
    if (rec.action === 'batch_complete' && Array.isArray(rec.batch)) {
      for (const item of rec.batch) {
        const text = (item.text ?? '').trim();
        if (!text) continue;
        const existing = byText.get(text);
        byText.set(text, {
          text,
          section: (existing?.section ?? item.section ?? '未分类').trim() || '未分类',
          status: 'completed',
          ts: rec.ts,
        });
      }
      continue;
    }
    if (rec.action === 'batch_remove' && Array.isArray(rec.batch)) {
      for (const item of rec.batch) {
        const text = (item.text ?? '').trim();
        if (!text) continue;
        byText.delete(text);
      }
      continue;
    }

    // Single-item records
    const text = (rec.task?.text ?? '').trim();
    if (!text) continue;
    const existing = byText.get(text);
    if (rec.action === 'remove') {
      byText.delete(text);
      continue;
    }
    if (rec.action === 'add') {
      byText.set(text, {
        text,
        section: (rec.task?.section ?? existing?.section ?? '未分类').trim() || '未分类',
        status: rec.task?.status === 'completed' ? 'completed' : 'pending',
        ts: rec.ts,
      });
      continue;
    }
    // complete
    byText.set(text, {
      text,
      section: (existing?.section ?? rec.task?.section ?? '未分类').trim() || '未分类',
      status: 'completed',
      ts: rec.ts,
    });
  }
  return Array.from(byText.values()).sort((a, b) => a.ts.localeCompare(b.ts));
}

// ---------- Tools ----------

export const heartbeatEnableTool: InternalTool = {
  name: 'heartbeat.enable',
  executionModel: 'state',
  description: 'Enable heartbeat scheduler. Optionally set interval (max 1 hour).',
  inputSchema: {
    type: 'object',
    properties: {
      intervalMs: { type: 'number', description: 'Interval in ms (default 5min, max 1h)' },
      dispatch: { type: 'string', enum: ['mailbox', 'dispatch'], description: 'Dispatch mode' },
    },
  },
  async execute(_params: unknown) {
    const params = _params as { intervalMs?: number; dispatch?: string };
    const config = await readConfig();
    if (!config.global) config.global = {};
    config.global.enabled = true;
    config.global.intervalMs = clampInterval(params.intervalMs);
    if (params.dispatch) config.global.dispatch = params.dispatch;
    await writeConfig(config);
    const longPrompt = config.global.intervalMs! >= MAX_INTERVAL_MS ? buildLongIntervalPrompt(config.global.intervalMs) : '';
    log.info('[heartbeat.enable] Heartbeat enabled', { intervalMs: config.global.intervalMs, dispatch: config.global.dispatch });
    return {
      success: true,
      message: `Heartbeat enabled (interval=${config.global.intervalMs}ms ≈ ${Math.round(config.global.intervalMs / 60000)}min)${longPrompt}`,
      intervalMs: config.global.intervalMs,
      dispatch: config.global.dispatch,
    };
  },
};

export const heartbeatDisableTool: InternalTool = {
  name: 'heartbeat.disable',
  executionModel: 'state',
  description: 'Disable heartbeat scheduler globally or for a specific project.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project ID to disable (omit for global)' },
    },
  },
  async execute(_params: unknown) {
    const params = _params as { projectId?: string };
    const config = await readConfig();
    if (params.projectId) {
      if (!config.projects) config.projects = {};
      if (!config.projects[params.projectId]) config.projects[params.projectId] = {};
      config.projects[params.projectId].enabled = false;
      await writeConfig(config);
      return { success: true, message: `Heartbeat disabled for project: ${params.projectId}` };
    }
    if (!config.global) config.global = {};
    config.global.enabled = false;
    await writeConfig(config);
    return { success: true, message: 'Heartbeat disabled globally' };
  },
};

export const heartbeatStatusTool: InternalTool = {
  name: 'heartbeat.status',
  executionModel: 'state',
  description: 'Get current heartbeat configuration. Does NOT expose file paths.',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    const config = await readConfig();
    const records = await readTaskRecords();
    const tasks = resolveCurrentTasks(records);
    const pendingCount = tasks.filter((t) => t.status === 'pending').length;
    const completedCount = tasks.filter((t) => t.status === 'completed').length;
    return {
      success: true,
      enabled: config.global?.enabled ?? false,
      intervalMs: config.global?.intervalMs ?? 300000,
      dispatch: config.global?.dispatch ?? 'mailbox',
      projects: config.projects,
      taskStats: { pending: pendingCount, completed: completedCount, total: tasks.length },
    };
  },
};

export const heartbeatAddTaskTool: InternalTool = {
  name: 'heartbeat.addTask',
  executionModel: 'state',
  description: 'Add a task to heartbeat task list. Do NOT write any markdown files directly.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Task description' },
      section: { type: 'string', description: 'Section heading (e.g. "系统维护")' },
    },
    required: ['text'],
  },
  async execute(_params: unknown) {
    const params = _params as { text: string; section?: string };
    const record: HeartbeatTaskRecord = {
      ts: new Date().toISOString(),
      type: 'heartbeat_task',
      action: 'add',
      task: { text: params.text.trim(), section: params.section?.trim() || '未分类', status: 'pending' },
    };
    await appendTaskRecord(record);
    log.info('[heartbeat.addTask]', { text: params.text, section: params.section });
    return { success: true, message: `Task added`, task: record.task };
  },
};

export const heartbeatCompleteTaskTool: InternalTool = {
  name: 'heartbeat.completeTask',
  executionModel: 'state',
  description: 'Mark a task as completed. Do NOT edit any markdown files directly.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Exact task text to match' },
    },
    required: ['text'],
  },
  async execute(_params: unknown) {
    const params = _params as { text: string };
    const record: HeartbeatTaskRecord = {
      ts: new Date().toISOString(),
      type: 'heartbeat_task',
      action: 'complete',
      task: { text: params.text.trim(), status: 'completed' },
    };
    await appendTaskRecord(record);
    log.info('[heartbeat.completeTask]', { text: params.text });
    return { success: true, message: `Task marked completed`, task: record.task };
  },
};

export const heartbeatRemoveTaskTool: InternalTool = {
  name: 'heartbeat.removeTask',
  executionModel: 'state',
  description: 'Remove a task from the heartbeat task list. Do NOT edit any markdown files directly.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Exact task text to match' },
    },
    required: ['text'],
  },
  async execute(_params: unknown) {
    const params = _params as { text: string };
    const record: HeartbeatTaskRecord = {
      ts: new Date().toISOString(),
      type: 'heartbeat_task',
      action: 'remove',
      task: { text: params.text.trim() },
    };
    await appendTaskRecord(record);
    log.info('[heartbeat.removeTask]', { text: params.text });
    return { success: true, message: `Task removed`, task: record.task };
  },
};

export const heartbeatListTasksTool: InternalTool = {
  name: 'heartbeat.listTasks',
  executionModel: 'state',
  description: 'List current heartbeat tasks. Do NOT cat any markdown files directly.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['pending', 'completed', 'all'] },
    },
  },
  async execute(_params: unknown) {
    const params = _params as { status?: string };
    const records = await readTaskRecords();
    const filter = params.status && params.status !== 'all' ? params.status : undefined;
    const tasks = resolveCurrentTasks(records)
      .filter((task) => !filter || task.status === filter)
      .map((task) => ({ text: task.text, section: task.section, status: task.status, ts: task.ts }));
    return { success: true, tasks };
  },
};

// ---------- Batch Tools ----------

export const heartbeatBatchAddTool: InternalTool = {
  name: 'heartbeat.batchAdd',
  executionModel: 'state',
  description: 'Batch add multiple tasks to heartbeat task list in a single operation.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Task description' },
            section: { type: 'string', description: 'Section heading' },
          },
          required: ['text'],
        },
        description: 'Array of tasks to add',
      },
    },
    required: ['tasks'],
  },
  async execute(_params: unknown) {
    const params = _params as { tasks: Array<{ text: string; section?: string }> };
    if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
      return { success: false, message: 'tasks must be a non-empty array' };
    }
    const batch = params.tasks.map((t) => ({
      text: t.text.trim(),
      section: t.section?.trim() || '未分类',
      status: 'pending' as const,
    }));
    const record: HeartbeatTaskRecord = {
      ts: new Date().toISOString(),
      type: 'heartbeat_task',
      action: 'batch_add',
      task: { text: '', section: '未分类' },
      batch,
    };
    await appendTaskRecord(record);
    log.info('[heartbeat.batchAdd]', { count: batch.length });
    return { success: true, message: `Batch added ${batch.length} tasks`, count: batch.length };
  },
};

export const heartbeatBatchCompleteTool: InternalTool = {
  name: 'heartbeat.batchComplete',
  executionModel: 'state',
  description: 'Batch mark multiple tasks as completed in a single operation.',
  inputSchema: {
    type: 'object',
    properties: {
      texts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of exact task texts to mark completed',
      },
    },
    required: ['texts'],
  },
  async execute(_params: unknown) {
    const params = _params as { texts: string[] };
    if (!Array.isArray(params.texts) || params.texts.length === 0) {
      return { success: false, message: 'texts must be a non-empty array' };
    }
    const batch = params.texts.map((text) => ({ text: text.trim(), status: 'completed' as const }));
    const record: HeartbeatTaskRecord = {
      ts: new Date().toISOString(),
      type: 'heartbeat_task',
      action: 'batch_complete',
      task: { text: '', section: '未分类', status: 'completed' },
      batch,
    };
    await appendTaskRecord(record);
    log.info('[heartbeat.batchComplete]', { count: batch.length });
    return { success: true, message: `Batch completed ${batch.length} tasks`, count: batch.length };
  },
};

export const heartbeatBatchRemoveTool: InternalTool = {
  name: 'heartbeat.batchRemove',
  executionModel: 'state',
  description: 'Batch remove multiple tasks from the heartbeat task list in a single operation.',
  inputSchema: {
    type: 'object',
    properties: {
      texts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of exact task texts to remove',
      },
    },
    required: ['texts'],
  },
  async execute(_params: unknown) {
    const params = _params as { texts: string[] };
    if (!Array.isArray(params.texts) || params.texts.length === 0) {
      return { success: false, message: 'texts must be a non-empty array' };
    }
    const batch = params.texts.map((text) => ({ text: text.trim() }));
    const record: HeartbeatTaskRecord = {
      ts: new Date().toISOString(),
      type: 'heartbeat_task',
      action: 'batch_remove',
      task: { text: '' },
      batch,
    };
    await appendTaskRecord(record);
    log.info('[heartbeat.batchRemove]', { count: batch.length });
    return { success: true, message: `Batch removed ${batch.length} tasks`, count: batch.length };
  },
};
