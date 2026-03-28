/**
 * Finger Core Daemon - Main Entry
 * 
 * Supervisor + HUB + Registry + Snapshot + Timer
 */

import fs from 'fs';
import path from 'path';
import { FINGER_PATHS, ensureDir, ensureFingerLayout } from './finger-paths.js';
import type { Message } from './schema.js';
import { HubCore } from './hub-core.js';
import { SnapshotManager } from './snapshot.js';
import { TimerSystem } from './timer.js';
import { Supervisor } from './supervisor.js';
import { loadInputsConfig, loadOutputsConfig, loadRoutesConfig } from './config-loader.js';
import type { Input } from '../inputs/base.js';
import type { Output } from '../outputs/base.js';
import { StdinInput } from '../inputs/stdin.js';
import { TimerInput } from '../inputs/timer.js';
import { OpenClawInput } from '../inputs/openclaw.js';
import { ExecOutput } from '../outputs/exec.js';
import { FileOutput } from '../outputs/file.js';
import { OpenClawOutput } from '../outputs/openclaw.js';
import type { ExecConfig } from '../outputs/exec.js';
import type { FileConfig } from '../outputs/file.js';
import type { RegistryEntry, RouteRule } from './schema.js';
import { registry } from './registry-new.js';
import { OpenClawGateBlock, type OpenClawGateEvent } from '../blocks/openclaw-gate/index.js';
import { invokeOpenClawFromMessage, toOpenClawToolDefinition } from '../orchestration/openclaw-adapter/index.js';
import { globalToolRegistry } from '../runtime/tool-registry.js';
import { getChannelBridgeManager, type ChannelBridgeManager, type ChannelMessage } from '../bridges/index.js';
import type { ChannelBridgeConfig } from '../bridges/types.js';
import { createMessage, type OpenClawChannelMeta } from './schema.js';
import { logger } from './logger.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('Daemon');

const log = logger.module('Daemon');

const FINGER_DIR = FINGER_PATHS.runtime.dir;
const PID_FILE = FINGER_PATHS.runtime.daemonPid;

export interface CoreDaemonConfig {
  snapshotInterval?: number;
  checkInterval?: number;
}

export class CoreDaemon {
  private hub: HubCore;
  private snapshot: SnapshotManager;
  private timer: TimerSystem;
  private supervisor: Supervisor;
  private inputs: Map<string, Input> = new Map();
  private outputs: Map<string, Output> = new Map();
  private running = false;
  private healthTimer: NodeJS.Timeout | null = null;
  private stopTimeout: NodeJS.Timeout | null = null;
  private openClawGate = new OpenClawGateBlock('openclaw-gate');
  private channelBridgeManager: ChannelBridgeManager | null = null;
  private channelsConfigWatcherPath: string | null = null;
  private channelsConfigReloadTimer: NodeJS.Timeout | null = null;
  private channelsConfigLastRaw = '';

  constructor(private config: CoreDaemonConfig = {}) {
    this.hub = new HubCore(registry);
    this.snapshot = new SnapshotManager(registry);
    this.timer = new TimerSystem();
    this.supervisor = new Supervisor();
  }

  async start(): Promise<void> {
    ensureFingerLayout();

    // Clean up stale PID file if process is dead
    if (fs.existsSync(PID_FILE)) {
      try {
        const stalePid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
        if (isNaN(stalePid)) {
          log.info('Removing invalid PID file');
          fs.unlinkSync(PID_FILE);
        } else {
          process.kill(stalePid, 0);
          // Process is still alive
          clog.log('[Daemon] Already running with PID', stalePid);
          return;
        }
      } catch {
        // Stale PID file - process is dead, clean it up
        log.info('Cleaning up stale PID file');
        try {
          fs.unlinkSync(PID_FILE);
        } catch {}
      }
    }

    if (this.isRunning()) {
      log.info('Already running');
      return;
    }

    ensureDir(FINGER_DIR);

    // Initialize ChannelBridgeManager
    this.channelBridgeManager = getChannelBridgeManager({
      onMessage: async (msg: ChannelMessage) => {
        await this.handleChannelMessage(msg);
      },
      onError: (err: Error) => {
        clog.error('[Daemon] Channel bridge error:', err);
      },
      onReady: () => {
        log.info('Channel bridge ready');
      },
      onClose: () => {
        log.info('Channel bridge closed');
      },
    });

    const snap = this.snapshot.load();
    if (snap) {
      registry.fromSnapshot(snap as { entries: RegistryEntry[]; routes: RouteRule[] });
    }

    const inputsCfg = loadInputsConfig();
    const outputsCfg = loadOutputsConfig();
    const routesCfg = loadRoutesConfig();

    const openClawInputConfig = inputsCfg.inputs.find((item) => item.kind === 'openclaw' && item.enabled)?.config as { pluginDir?: string } | undefined;
    const openClawOutputConfig = outputsCfg.outputs.find((item) => item.kind === 'openclaw' && item.enabled)?.config as { pluginDir?: string } | undefined;
    const openClawPluginDir = openClawInputConfig?.pluginDir ?? openClawOutputConfig?.pluginDir;
    this.openClawGate = new OpenClawGateBlock('openclaw-gate', { pluginDir: openClawPluginDir });
    await this.openClawGate.initialize();

    this.openClawGate.addEventListener((event: OpenClawGateEvent) => {
      switch (event.type) {
        case 'plugin_enabled':
        case 'plugin_installed':
          for (const tool of event.tools) {
            globalToolRegistry.register(toOpenClawToolDefinition(event.pluginId, tool, this.openClawGate));
          }
          break;
        case 'plugin_disabled':
        case 'plugin_uninstalled':
          for (const toolName of event.toolNames) {
            globalToolRegistry.unregister(toolName);
          }
          break;
      }
    });

    // Load channel bridge configs
    await this.loadChannelBridgeConfigs();
    this.startChannelConfigHotReload();

    for (const route of routesCfg.routes) {
      registry.addRoute(route);
      this.snapshot.markDirty();
    }

    for (const out of outputsCfg.outputs) {
      if (!out.enabled) continue;
      
      let output: Output;
      switch (out.kind) {
        case 'exec':
          output = new ExecOutput(out.id, out.config as unknown as ExecConfig);
          break;
        case 'file':
          output = new FileOutput(out.id, out.config as unknown as FileConfig);
          break;
        case 'openclaw':
          output = new OpenClawOutput(out.id, out.config as never);
          break;
        default:
          clog.warn(`[Daemon] Unknown output kind: ${out.kind}`);
          continue;
      }

      this.outputs.set(out.id, output);
      this.hub.registerOutput(out.id, (msg) => output.handle(msg));
      registry.register({ id: out.id, type: 'output', kind: out.kind, config: out.config || {}, status: 'active' });
      await output.start();
    }

    for (const inp of inputsCfg.inputs) {
      if (!inp.enabled) continue;

      let input: Input;
      switch (inp.kind) {
        case 'stdin':
          input = new StdinInput();
          break;
        case 'timer': {
          const timerCfg = inp.config as { interval: number; type: string; payload: unknown };
          input = new TimerInput(inp.id, timerCfg);
          break;
        }
        case 'openclaw':
          input = new OpenClawInput(inp.id, inp.config as never);
          break;
        default:
          clog.warn(`[Daemon] Unknown input kind: ${inp.kind}`);
          continue;
      }

      this.inputs.set(inp.id, input);
      registry.register({ id: inp.id, type: 'input', kind: inp.kind, config: inp.config || {}, status: 'active' });
      
      if ('setEmitter' in input) {
        (input as { setEmitter: (emitter: (msg: Message) => Promise<void>) => void }).setEmitter(async (msg) => {
          await this.handleMessage(msg);
        });
      }
      
      await input.start();
    }

    this.snapshot.start();
    this.snapshot.markDirty();

    const checkInterval = this.config.checkInterval || 10;
    this.healthTimer = setInterval(() => {
      this.supervisor.checkHealth();
    }, checkInterval * 1000);

    fs.writeFileSync(PID_FILE, String(process.pid));
    
    this.running = true;
    clog.log('[Daemon] Started with PID', process.pid);
    
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
    process.on('uncaughtException', (err) => {
      clog.error('[Daemon] Uncaught exception:', err);
      this.stop();
      process.exit(1);
    });
    process.on('unhandledRejection', (reason) => {
      clog.error('[Daemon] Unhandled rejection:', reason);
      this.stop();
      process.exit(1);
    });
  }

  async stop(): Promise<void> {
    log.info('Stopping...');
    this.running = false;

    if (this.stopTimeout) {
      clearTimeout(this.stopTimeout);
    }

    this.stopTimeout = setTimeout(() => {
      log.error('Stop timeout exceeded, forcing exit');
      process.exit(1);
    }, 10_000).unref();

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
    }
    if (this.channelsConfigWatcherPath) {
      try {
        fs.unwatchFile(this.channelsConfigWatcherPath);
      } catch {}
      this.channelsConfigWatcherPath = null;
    }
    if (this.channelsConfigReloadTimer) {
      clearTimeout(this.channelsConfigReloadTimer);
      this.channelsConfigReloadTimer = null;
    }

    try {
      if (this.channelBridgeManager) {
        await this.channelBridgeManager.stopAll();
      }
    } catch (err) {
      clog.error('[Daemon] Failed to stop channel bridges:', err);
    }

    try {
      await this.supervisor.stopAll();
    } catch (err) {
      clog.error('[Daemon] Failed to stop supervisor:', err);
    }

    for (const input of this.inputs.values()) {
      try {
        await input.stop();
      } catch (err) {
        clog.error('[Daemon] Failed to stop input:', err);
      }
    }

    for (const output of this.outputs.values()) {
      try {
        await output.stop();
      } catch (err) {
        clog.error('[Daemon] Failed to stop output:', err);
      }
    }

    try {
      this.snapshot.stop();
    } catch (err) {
      clog.error('[Daemon] Failed to stop snapshot:', err);
    }

    try {
      fs.unlinkSync(PID_FILE);
    } catch {}

    if (this.stopTimeout) {
      clearTimeout(this.stopTimeout);
      this.stopTimeout = null;
    }

    log.info('Stopped');
  }

  async restart(): Promise<void> {
    log.info('Restarting...');
    await this.stop();
    await new Promise(resolve => setTimeout(resolve, 500));
    await this.start();
    log.info('Restarted');
  }

  private async handleChannelMessage(channelMsg: ChannelMessage): Promise<void> {
    this.snapshot.markDirty();

    const channelMeta: OpenClawChannelMeta = {
      channelId: channelMsg.channelId,
      accountId: channelMsg.accountId,
      senderId: channelMsg.senderId,
      senderName: channelMsg.senderName,
      chatType: channelMsg.type,
      threadId: channelMsg.threadId,
      messageId: channelMsg.id,
      originalTimestamp: channelMsg.timestamp,
    };

    const msg = createMessage('channel-message', {
      text: channelMsg.content,
      attachments: channelMsg.attachments,
    }, channelMsg.channelId, { channelMeta });

    const results = await this.hub.route(msg);
    clog.log('[Daemon] Routed channel message', channelMsg.id, 'to', results.length, 'outputs');
  }

  private async handleMessage(msg: Message): Promise<void> {
    this.snapshot.markDirty();

    if (msg.type === 'openclaw-call') {
      const openClawResult = await invokeOpenClawFromMessage(msg, this.openClawGate);
      if (openClawResult) {
        clog.log('[Daemon] OpenClaw message handled via gate', msg.meta.id, openClawResult.ok);
        return;
      }
    }

    const results = await this.hub.route(msg);
    clog.log('[Daemon] Routed message', msg.meta.id, 'to', results.length, 'outputs');
  }

  isRunning(): boolean {
    if (!fs.existsSync(PID_FILE)) return false;
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
      if (isNaN(pid)) {
        fs.unlinkSync(PID_FILE);
        return false;
      }
      process.kill(pid, 0);
      return true;
    } catch {
      try {
        fs.unlinkSync(PID_FILE);
      } catch {}
      return false;
    }
  }

  private async loadChannelBridgeConfigs(): Promise<void> {
    clog.log('[Daemon] loadChannelBridgeConfigs called, manager:', !!this.channelBridgeManager);
    if (!this.channelBridgeManager) return;

    const channelsConfigPath = path.join(FINGER_PATHS.config.dir, 'channels.json');
    let configs: ChannelBridgeConfig[] = [];
    let rawConfig = '';

    try {
      if (fs.existsSync(channelsConfigPath)) {
        rawConfig = fs.readFileSync(channelsConfigPath, 'utf-8');
        const parsed = JSON.parse(rawConfig);
        configs = parsed.channels || [];
        clog.log('[Daemon] Found channels config file, channels:', configs.length);
      } else {
        clog.log('[Daemon] channels.json not found at:', channelsConfigPath);
      }
    } catch (err) {
      clog.warn('[Daemon] Failed to load channels config:', err);
    }

    if (configs.length > 0) {
      log.info('Loading channel bridge configs...');
      try {
        await this.channelBridgeManager.loadConfigs(configs);
        this.channelsConfigLastRaw = rawConfig;
        clog.log('[Daemon] Loaded', configs.length, 'channel bridge configs successfully');
      } catch (err) {
        clog.error('[Daemon] Failed to load channel bridges:', err instanceof Error ? err.message : String(err));
      }
    } else {
      log.info('No channel bridge configs to load');
    }
  }

  private startChannelConfigHotReload(): void {
    if (!this.channelBridgeManager) return;

    const channelsConfigPath = path.join(FINGER_PATHS.config.dir, 'channels.json');
    this.channelsConfigWatcherPath = channelsConfigPath;
    fs.watchFile(channelsConfigPath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;
      this.scheduleChannelConfigReload();
    });
    clog.log('[Daemon] Watching channels.json for hot reload:', channelsConfigPath);
  }

  private scheduleChannelConfigReload(): void {
    if (this.channelsConfigReloadTimer) {
      clearTimeout(this.channelsConfigReloadTimer);
    }
    this.channelsConfigReloadTimer = setTimeout(() => {
      this.channelsConfigReloadTimer = null;
      this.reloadChannelConfigHot().catch((err) => {
        clog.error('[Daemon] channels.json hot reload failed:', err instanceof Error ? err.message : String(err));
      });
    }, 400);
  }

  private async reloadChannelConfigHot(): Promise<void> {
    if (!this.channelBridgeManager) return;
    const channelsConfigPath = path.join(FINGER_PATHS.config.dir, 'channels.json');
    if (!fs.existsSync(channelsConfigPath)) return;

    const raw = fs.readFileSync(channelsConfigPath, 'utf-8');
    if (raw === this.channelsConfigLastRaw) return;

    const parsed = JSON.parse(raw);
    const configs: ChannelBridgeConfig[] = Array.isArray(parsed.channels) ? parsed.channels : [];
    this.channelBridgeManager.upsertConfigs(configs);
    this.channelsConfigLastRaw = raw;

    clog.log('[Daemon] Hot reloaded channels config:', {
      channels: configs.length,
      updatedAt: new Date().toISOString(),
    });
  }

  getStatus() {
    return {
      running: this.running,
      inputs: this.inputs.size,
      outputs: this.outputs.size,
      bridges: this.channelBridgeManager?.getRunningBridges().length || 0,
    };
  }
}
