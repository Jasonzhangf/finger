import path from 'path';
import { MessageHub } from '../orchestration/message-hub.js';
import { ModuleRegistry, OutputModule } from '../orchestration/module-registry.js';
import { GatewayDeliveryMode, GatewayInboundEnvelope, ResolvedGatewayModule } from './types.js';
import {
  ensureGatewayDir,
  installGatewayFromCommand,
  installGatewayModule,
  listGatewayModules,
  probeGatewayModule,
  removeGatewayModule,
} from './module-registry.js';
import { GatewayProcessSession } from './process-session.js';

interface DispatchInputParams {
  target?: string;
  message: unknown;
  blocking?: boolean;
  sender?: string;
}

export interface GatewayManagerOptions {
  daemonUrl: string;
}

interface GatewaySummary {
  id: string;
  name: string;
  version: string;
  description: string;
  direction: string;
  mode: string;
  command: string;
  args: string[];
  enabled: boolean;
  readmePath?: string;
  cliDocPath?: string;
}

export class GatewayManager {
  private readonly hub: MessageHub;
  private readonly moduleRegistry: ModuleRegistry;
  private readonly daemonUrl: string;
  private readonly sessions = new Map<string, GatewayProcessSession>();
  private readonly modules = new Map<string, ResolvedGatewayModule>();
  private readonly registeredOutputModuleIds = new Set<string>();

  constructor(hub: MessageHub, moduleRegistry: ModuleRegistry, options: GatewayManagerOptions) {
    this.hub = hub;
    this.moduleRegistry = moduleRegistry;
    this.daemonUrl = options.daemonUrl;
  }

  async start(): Promise<void> {
    ensureGatewayDir();
    await this.installBuiltins();
    await this.reload();
  }

  async stop(): Promise<void> {
    for (const id of Array.from(this.registeredOutputModuleIds)) {
      await this.moduleRegistry.unregister(id).catch(() => {
        // ignore
      });
      this.registeredOutputModuleIds.delete(id);
    }

    for (const session of this.sessions.values()) {
      await session.stop().catch(() => {
        // ignore
      });
    }
    this.sessions.clear();
    this.modules.clear();
  }

  async reload(): Promise<void> {
    await this.stop();
    const modules = listGatewayModules();

    for (const module of modules) {
      if (module.manifest.enabled === false) continue;
      this.modules.set(module.manifest.id, module);
      await this.registerGatewayModule(module);
    }
  }

  list(): GatewaySummary[] {
    const result: GatewaySummary[] = [];
    for (const module of this.modules.values()) {
      result.push({
        id: module.manifest.id,
        name: module.manifest.name,
        version: module.manifest.version,
        description: module.manifest.description,
        direction: module.manifest.direction,
        mode: `${module.manifest.mode.default} [${module.manifest.mode.supported.join(', ')}]`,
        command: module.manifest.process.command,
        args: module.manifest.process.args ?? [],
        enabled: module.manifest.enabled !== false,
        readmePath: module.readmePath,
        cliDocPath: module.cliDocPath,
      });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }

  inspect(id: string): ResolvedGatewayModule | null {
    return this.modules.get(id) ?? null;
  }

  probe(id: string): ReturnType<typeof probeGatewayModule> | null {
    const module = this.modules.get(id);
    if (!module) return null;
    return probeGatewayModule(module);
  }

  async registerFromPath(sourcePath: string): Promise<ResolvedGatewayModule> {
    const installed = installGatewayModule(sourcePath);
    await this.reload();
    return installed;
  }

  async unregister(id: string): Promise<boolean> {
    const removed = removeGatewayModule(id);
    await this.reload();
    return removed;
  }

  async dispatchInput(gatewayId: string, params: DispatchInputParams): Promise<unknown> {
    const module = this.modules.get(gatewayId);
    if (!module) {
      throw new Error(`Gateway not found: ${gatewayId}`);
    }
    if (module.manifest.direction === 'output') {
      throw new Error(`Gateway ${gatewayId} does not support inbound input`);
    }

    const target = params.target ?? module.manifest.input?.defaultTarget;
    if (!target) {
      throw new Error(`Gateway ${gatewayId} has no inbound target`);
    }

    if (params.blocking) {
      const result = await this.hub.sendToModule(target, params.message);
      if (params.sender) {
        await this.trySendCallback(params.sender, result);
      }
      return result;
    }

    this.hub
      .sendToModule(target, params.message)
      .then(async (result) => {
        if (params.sender) {
          await this.trySendCallback(params.sender, result);
        }
      })
      .catch((error) => {
        console.error(`[Gateway:${gatewayId}] async inbound dispatch failed: ${String(error)}`);
      });

    return {
      accepted: true,
      gatewayId,
      target,
    };
  }

  private async registerGatewayModule(module: ResolvedGatewayModule): Promise<void> {
    const direction = module.manifest.direction;
    if (direction === 'output' || direction === 'bidirectional') {
      const outputModule = this.createOutputProxyModule(module);
      await this.moduleRegistry.register(outputModule);
      this.registeredOutputModuleIds.add(module.manifest.id);
    }

    if (direction === 'input' || direction === 'bidirectional') {
      await this.ensureSession(module);
    }
  }

  private createOutputProxyModule(module: ResolvedGatewayModule): OutputModule {
    const inputCapability = inferInputCapability(module.manifest.id);
    return {
      id: module.manifest.id,
      type: 'output',
      name: module.manifest.name,
      version: module.manifest.version,
      metadata: {
        gateway: true,
        direction: module.manifest.direction,
        transport: module.manifest.transport,
        readmePath: module.readmePath,
        cliDocPath: module.cliDocPath,
        inputCapability,
      },
      handle: async (message: unknown, callback?: (result: unknown) => void): Promise<unknown> => {
        const session = await this.ensureSession(module);
        const deliveryMode = this.resolveDeliveryMode(module, message);
        const result = await session.request(deliveryMode, message);
        if (callback) {
          callback(result);
        }
        return result;
      },
    };
  }

  private resolveDeliveryMode(module: ResolvedGatewayModule, message: unknown): GatewayDeliveryMode {
    const supported = module.manifest.mode.supported;
    const fallback = module.manifest.mode.default;
    const requested = extractDeliveryMode(message);
    if (!requested) return fallback;
    if (!supported.includes(requested)) {
      return fallback;
    }
    return requested;
  }

  private async ensureSession(module: ResolvedGatewayModule): Promise<GatewayProcessSession> {
    const existing = this.sessions.get(module.manifest.id);
    if (existing) {
      await existing.start();
      return existing;
    }

    const session = new GatewayProcessSession({
      module,
      onInbound: async (inbound: GatewayInboundEnvelope) => {
        await this.dispatchInput(module.manifest.id, {
          target: inbound.target,
          sender: inbound.sender,
          blocking: inbound.blocking,
          message: inbound.message,
        });
      },
      onEvent: async (event) => {
        console.log(`[Gateway:${module.manifest.id}] event ${event.name}`);
      },
    });

    this.sessions.set(module.manifest.id, session);
    await session.start();
    return session;
  }

  private async trySendCallback(sender: string, result: unknown): Promise<void> {
    try {
      await this.hub.sendToModule(sender, {
        type: 'callback',
        payload: result,
      });
    } catch {
      // ignore callback failures
    }
  }

  private async installBuiltins(): Promise<void> {
    const cliPath = path.join(process.cwd(), 'dist', 'cli', 'index.js');
    const command = process.execPath;

    const existing = listGatewayModules();
    const hasChat = existing.some((item) => item.manifest.id === 'chat-gateway');
    const hasChatCodex = existing.some((item) => item.manifest.id === 'chat-codex-gateway');

    if (!hasChat) {
      installGatewayFromCommand({
        id: 'chat-gateway',
        name: 'Chat Gateway',
        version: '1.0.0',
        description: 'CLI gateway for router chat agent',
        command,
        args: [cliPath, 'gateway-worker', '--adapter', 'chat', '--daemon-url', this.daemonUrl, '--target', 'router-chat-agent'],
        direction: 'output',
        supportedModes: ['sync', 'async'],
        defaultMode: 'sync',
        helpArgs: [cliPath, 'gateway-worker', '--help'],
        versionArgs: [],
      });
    }

    if (!hasChatCodex) {
      installGatewayFromCommand({
        id: 'chat-codex-gateway',
        name: 'Chat Codex Gateway',
        version: '1.0.0',
        description: 'CLI gateway for chat-codex module',
        command,
        args: [cliPath, 'gateway-worker', '--adapter', 'chat-codex', '--daemon-url', this.daemonUrl, '--target', 'chat-codex'],
        direction: 'output',
        supportedModes: ['sync', 'async'],
        defaultMode: 'sync',
        helpArgs: [cliPath, 'gateway-worker', '--help'],
        versionArgs: [],
      });
    }
  }
}

function inferInputCapability(moduleId: string): {
  acceptText: boolean;
  acceptImages: boolean;
  acceptFiles: boolean;
  acceptedFileMimePrefixes?: string[];
} {
  if (moduleId === 'chat-codex-gateway') {
    return {
      acceptText: true,
      acceptImages: true,
      acceptFiles: false,
      acceptedFileMimePrefixes: ['image/'],
    };
  }

  if (moduleId === 'chat-gateway') {
    return {
      acceptText: true,
      acceptImages: false,
      acceptFiles: false,
    };
  }

  return {
    acceptText: true,
    acceptImages: true,
    acceptFiles: true,
  };
}

function extractDeliveryMode(message: unknown): GatewayDeliveryMode | null {
  if (!isRecord(message)) return null;
  const raw = message.deliveryMode;
  if (raw === 'sync' || raw === 'async') return raw;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
