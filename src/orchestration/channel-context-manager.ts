/**
 * Channel Context Manager
 * Persists current target agent for each channel
 */

import fs from 'fs';
import path from 'path';
import { FINGER_PATHS } from '../core/finger-paths.js';
import { loadOrchestrationConfig } from './orchestration-config.js';

export interface ChannelContext {
  channelId: string;
  currentMode: 'business' | 'system';
  currentAgentId: string;
  projectId?: string;
  projectPath?: string;
  projectAlias?: string;
  previousContext?: {
    agentId: string;
    sessionId: string;
    projectPath: string;
  };
  switchedAt?: number;
}

const CONTEXT_FILE = path.join(FINGER_PATHS.config.dir, 'channel-contexts.json');

export class ChannelContextManager {
  private contexts: Map<string, ChannelContext> = new Map();
  private defaultTargetAgentId = 'finger-system-agent';

  static #instance: ChannelContextManager;

  static getInstance(): ChannelContextManager {
    if (!ChannelContextManager.#instance) {
      ChannelContextManager.#instance = new ChannelContextManager();
    }
    return ChannelContextManager.#instance;
  }

  constructor() {
    this.loadContexts();
    this.defaultTargetAgentId = this.resolveDefaultTargetAgent();
  }

  getTargetAgent(channelId: string, parsed: { type: string; targetAgent: string }): string {
    if (parsed.type === 'super_command' && parsed.targetAgent) {
      return parsed.targetAgent;
    }

    const ctx = this.contexts.get(channelId);
    if (ctx) {
      return ctx.currentAgentId;
    }

    return this.defaultTargetAgentId;
  }

  updateContext(
    channelId: string,
    mode: 'business' | 'system',
    agentId: string,
    previousContext?: ChannelContext['previousContext'],
    projectContext?: { projectId?: string; projectPath?: string; projectAlias?: string },
  ): void {
    const now = Date.now();
    const existing = this.contexts.get(channelId);

    this.contexts.set(channelId, {
      channelId,
      currentMode: mode,
      currentAgentId: agentId,
      projectId: projectContext?.projectId ?? existing?.projectId,
      projectPath: projectContext?.projectPath ?? existing?.projectPath,
      projectAlias: projectContext?.projectAlias ?? existing?.projectAlias,
      previousContext: previousContext ?? existing?.previousContext,
      switchedAt: now,
    });

    this.persistContexts();
  }

  getContext(channelId: string): ChannelContext | undefined {
    return this.contexts.get(channelId);
  }

  getCurrentMode(channelId: string): 'business' | 'system' {
    return this.contexts.get(channelId)?.currentMode ?? 'business';
  }

  clearContext(channelId: string): void {
    this.contexts.delete(channelId);
    this.persistContexts();
  }

  private loadContexts(): void {
    try {
      if (!fs.existsSync(CONTEXT_FILE)) {
        return;
      }

      const data = fs.readFileSync(CONTEXT_FILE, 'utf-8');
      const parsed = JSON.parse(data) as Record<string, ChannelContext>;

      for (const [key, value] of Object.entries(parsed)) {
        this.contexts.set(key, value);
      }
    } catch {
      this.contexts.clear();
    }
  }

  private resolveDefaultTargetAgent(): string {
    try {
      const loaded = loadOrchestrationConfig();
      const profile = loaded.config.profiles.find((item) => item.id === loaded.config.activeProfileId);
      const orchestrator = profile?.agents.find(
        (item) => item.enabled !== false && item.role === 'orchestrator'
      );
      const resolved = orchestrator?.targetAgentId?.trim();
      if (resolved) return resolved;
    } catch {
      // keep default
    }
    return 'finger-system-agent';
  }

  private persistContexts(): void {
    try {
      const data: Record<string, ChannelContext> = {};
      for (const [key, value] of this.contexts.entries()) {
        data[key] = value;
      }

      const dir = path.dirname(CONTEXT_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(CONTEXT_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // ignore persistence failures
    }
  }
}

let instance: ChannelContextManager | null = null;

export function getChannelContextManager(): ChannelContextManager {
  if (!instance) {
    instance = new ChannelContextManager();
  }
  return instance;
}
