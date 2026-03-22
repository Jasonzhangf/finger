import type { InternalTool, ToolExecutionContext } from './types.js';
import path from 'path';
import { promises as fs } from 'fs';
import { FINGER_PATHS } from '../../core/finger-paths.js';
import { logger } from '../../core/logger.js';

const log = logger.module('HeartbeatControlTool');

interface HeartbeatConfig {
  global?: { enabled?: boolean; intervalMs?: number; dispatch?: string };
  projects?: Record<string, { enabled?: boolean }>;
}

const CONFIG_PATH = path.join(FINGER_PATHS.config.dir, 'heartbeat-tasks.json');

async function readConfig(): Promise<HeartbeatConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as HeartbeatConfig;
  } catch {
    return {};
  }
}

async function writeConfig(config: HeartbeatConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

export const heartbeatEnableTool: InternalTool = {
  name: 'heartbeat.enable',
  description: 'Enable heartbeat scheduler. Optionally set interval and dispatch mode.',
  inputSchema: {
    type: 'object',
    properties: {
      intervalMs: {
        type: 'number',
        description: 'Heartbeat interval in ms (default: 300000 = 5min)',
      },
      dispatch: {
        type: 'string',
        enum: ['mailbox', 'dispatch'],
        description: 'Dispatch mode (default: mailbox)',
      },
    },
  },
  async execute(_params: unknown, _context: ToolExecutionContext) {
    const params = _params as { intervalMs?: number; dispatch?: string };
    const config = await readConfig();
    if (!config.global) config.global = {};
    config.global.enabled = true;
    if (params.intervalMs) config.global.intervalMs = params.intervalMs;
    if (params.dispatch) config.global.dispatch = params.dispatch;
    await writeConfig(config);

    log.info('[heartbeat.enable] Heartbeat enabled', {
      intervalMs: config.global.intervalMs,
      dispatch: config.global.dispatch,
    });

    return {
      success: true,
      message: `Heartbeat enabled (interval=${config.global.intervalMs ?? 300000}ms, dispatch=${config.global.dispatch ?? 'mailbox'})`,
      config: config.global,
    };
  },
};

export const heartbeatDisableTool: InternalTool = {
  name: 'heartbeat.disable',
  description: 'Disable heartbeat scheduler globally or for a specific project.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: {
        type: 'string',
        description: 'Project ID to disable (omit for global disable)',
      },
    },
  },
  async execute(_params: unknown, _context: ToolExecutionContext) {
    const params = _params as { projectId?: string };
    const config = await readConfig();

    if (params.projectId) {
      if (!config.projects) config.projects = {};
      if (!config.projects[params.projectId]) config.projects[params.projectId] = {};
      config.projects[params.projectId].enabled = false;
      log.info('[heartbeat.disable] Disabled for project', { projectId: params.projectId });
      return {
        success: true,
        message: `Heartbeat disabled for project: ${params.projectId}`,
      };
    }

    if (!config.global) config.global = {};
    config.global.enabled = false;
    await writeConfig(config);

    log.info('[heartbeat.disable] Heartbeat disabled globally');
    return {
      success: true,
      message: 'Heartbeat disabled globally',
    };
  },
};

export const heartbeatStatusTool: InternalTool = {
  name: 'heartbeat.status',
  description: 'Get current heartbeat scheduler status and configuration.',
  inputSchema: { type: 'object', properties: {} },
  async execute(_params: unknown, _context: ToolExecutionContext) {
    const config = await readConfig();
    return {
      success: true,
      message: 'Heartbeat status',
      config,
    };
  },
};
