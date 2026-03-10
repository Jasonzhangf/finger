/**
 * Finger Core Daemon - Main Entry
 * 
 * Supervisor + HUB + Registry + Snapshot + Timer
 */

import fs from 'fs';
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
import { OpenClawGateBlock } from '../blocks/openclaw-gate/index.js';
import { invokeOpenClawFromMessage } from '../orchestration/openclaw-adapter/index.js';

const FINGER_DIR = FINGER_PATHS.runtime.dir;
const PID_FILE = FINGER_PATHS.runtime.daemonPid;

export interface CoreDaemonConfig {
  snapshotInterval?: number;
  checkInterval?: number; // health check interval seconds
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
  private openClawGate = new OpenClawGateBlock('openclaw-gate');

  constructor(private config: CoreDaemonConfig = {}) {
    this.hub = new HubCore(registry);
    this.snapshot = new SnapshotManager(registry);
    this.timer = new TimerSystem();
    this.supervisor = new Supervisor();
  }

  async start(): Promise<void> {
    ensureFingerLayout();
    // Check if already running
    if (this.isRunning()) {
      console.log('[Daemon] Already running');
      return;
    }

    // Ensure directory exists
    ensureDir(FINGER_DIR);

    // Load snapshot
    const snap = this.snapshot.load();
    if (snap) {
      registry.fromSnapshot(snap as { entries: RegistryEntry[]; routes: RouteRule[] });
    }

    // Load YAML configs
    const inputsCfg = loadInputsConfig();
    const outputsCfg = loadOutputsConfig();
    const routesCfg = loadRoutesConfig();

    // Derive OpenClaw pluginDir from configured inputs/outputs
    const openClawInputConfig = inputsCfg.inputs.find((item) => item.kind === 'openclaw' && item.enabled)?.config as { pluginDir?: string } | undefined;
    const openClawOutputConfig = outputsCfg.outputs.find((item) => item.kind === 'openclaw' && item.enabled)?.config as { pluginDir?: string } | undefined;
    const openClawPluginDir = openClawInputConfig?.pluginDir ?? openClawOutputConfig?.pluginDir;
    this.openClawGate = new OpenClawGateBlock('openclaw-gate', { pluginDir: openClawPluginDir });

    // Register routes
    for (const route of routesCfg.routes) {
      registry.addRoute(route);
      this.snapshot.markDirty();
    }

    // Initialize outputs
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
          console.warn(`[Daemon] Unknown output kind: ${out.kind}`);
          continue;
      }

      this.outputs.set(out.id, output);
      this.hub.registerOutput(out.id, (msg) => output.handle(msg));
      registry.register({ 
        id: out.id, 
        type: 'output', 
        kind: out.kind, 
        config: out.config || {}, 
        status: 'active' 
      });
      await output.start();
    }

    // Initialize inputs
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
          console.warn(`[Daemon] Unknown input kind: ${inp.kind}`);
          continue;
      }

      this.inputs.set(inp.id, input);
      registry.register({ 
        id: inp.id, 
        type: 'input', 
        kind: inp.kind, 
        config: inp.config || {}, 
        status: 'active' 
      });
      
      if ('setEmitter' in input) {
        (input as { setEmitter: (emitter: (msg: Message) => Promise<void>) => void }).setEmitter(async (msg) => {
          await this.handleMessage(msg);
        });
      }
      
      await input.start();
    }

    // Start snapshot manager
    this.snapshot.start();
    this.snapshot.markDirty();

    // Start health check
    const checkInterval = this.config.checkInterval || 10;
    this.healthTimer = setInterval(() => {
      this.supervisor.checkHealth();
    }, checkInterval * 1000);

    // Write PID file
    fs.writeFileSync(PID_FILE, String(process.pid));
    
    this.running = true;
    console.log('[Daemon] Started with PID', process.pid);
    
    // Handle signals
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());
    process.on('uncaughtException', (err) => {
      console.error('[Daemon] Uncaught exception:', err);
      this.stop();
      process.exit(1);
    });
  }

  async stop(): Promise<void> {
    console.log('[Daemon] Stopping...');
    this.running = false;

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
    }

    await this.supervisor.stopAll();

    for (const input of this.inputs.values()) {
      await input.stop();
    }
    for (const output of this.outputs.values()) {
      await output.stop();
    }

    this.snapshot.stop();
    this.timer.stopAll();

    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }

    console.log('[Daemon] Stopped');
  }

  private async handleMessage(msg: Message): Promise<void> {
    this.snapshot.markDirty();

    if (msg.type === 'openclaw-call') {
      const openClawResult = await invokeOpenClawFromMessage(msg, this.openClawGate);
      if (openClawResult) {
        console.log('[Daemon] OpenClaw message handled via gate', msg.meta.id, openClawResult.ok);
        return;
      }
    }

    const results = await this.hub.route(msg);
    console.log('[Daemon] Routed message', msg.meta.id, 'to', results.length, 'outputs');
  }

  isRunning(): boolean {
    if (!fs.existsSync(PID_FILE)) return false;
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
      if (isNaN(pid)) return false;
      // Check if process exists
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  getStatus() {
    return {
      running: this.running,
      inputs: Array.from(this.inputs.keys()),
      outputs: Array.from(this.outputs.keys()),
      routes: registry.getRoutes().length,
    };
  }
}
