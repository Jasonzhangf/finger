import type { Express } from 'express';
import { logger } from '../../core/logger.js';
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { __chatCodexInternals } from '../../agents/chat-codex/chat-codex-module.js';
import {
  buildOrchestrationDispatchPrompt,
  type OrchestrationPromptAgent,
} from '../../orchestration/orchestration-prompt.js';
import { loadOrchestrationConfig, type OrchestrationProfile } from '../../orchestration/orchestration-config.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { ToolDefinition, ToolRegistry } from '../../runtime/tool-registry.js';
import type { SessionWorkspaceManager } from '../modules/session-workspaces.js';
import { isObjectRecord } from '../common/object.js';
import { asString } from '../common/strings.js';

export interface DryrunRouteDeps {
  sessionManager: SessionManager;
  runtime: RuntimeFacade;
  toolRegistry: ToolRegistry;
  sessionWorkspaces: SessionWorkspaceManager;
  primaryOrchestratorAgentId: string;
  primaryOrchestratorTarget: string;
  allowDirectAgentRoute: boolean;
}

interface DryrunToolSchema {
  name: string;
  description?: string;
  inputSchema?: unknown;
  policy: 'allow' | 'deny';
}

interface DryrunSnapshot {
  timestamp: string;
  sessionId: string;
  agentId: string;
  roleProfile: string;
  target: string;
  dryrun: true;
  input: {
    text: string;
    metadata: Record<string, unknown>;
    requestedTools: string[];
  };
  developerInstructions: string | null;
  injectedPrompt: string | null;
  injectedAgents: OrchestrationPromptAgent[];
  tools: {
    requested: DryrunToolSchema[];
    allowedByPolicy: DryrunToolSchema[];
    deniedByPolicy: DryrunToolSchema[];
  };
  contextLedger: {
    enabled: boolean;
    agentId: string;
    role: string;
    canReadAll: boolean;
    focusEnabled: boolean;
    focusMaxChars: number;
  } | null;
  environmentContext: string | null | undefined;
  turnContext: Record<string, unknown> | null;
  userInstructions: string | null | undefined;
  kernelMode: string;
}

interface DryrunRequestBody {
  target?: string;
  message?: unknown;
  sessionId?: string;
  roleProfile?: string;
}

function resolveTextFromMessage(message: unknown): string | null {
  if (typeof message === 'string') return message.trim() || null;
  if (!isObjectRecord(message)) return null;
  const candidates = ['text', 'content', 'prompt', 'message'];
  for (const key of candidates) {
    const value = message[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function resolveMetadataFromMessage(message: unknown): Record<string, unknown> {
  if (!isObjectRecord(message)) return {};
  return isObjectRecord(message.metadata) ? message.metadata : {};
}

function resolveToolsFromMessage(message: unknown): string[] {
  if (!isObjectRecord(message)) return [];
  if (!Array.isArray(message.tools)) return [];
  return message.tools
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function resolveSessionWorkspaceRoot(
  sessionWorkspaces: SessionWorkspaceManager,
  sessionId: string,
): string {
  const dirs = sessionWorkspaces.resolveSessionWorkspaceDirsForMessage(sessionId);
  return dirs.sessionWorkspaceRoot;
}

function resolveDiagnosticsDir(
  sessionWorkspaces: SessionWorkspaceManager,
  sessionId: string,
): string {
  const root = resolveSessionWorkspaceRoot(sessionWorkspaces, sessionId);
  const diagnosticsDir = join(root, 'diagnostics');
  mkdirSync(diagnosticsDir, { recursive: true });
  return diagnosticsDir;
}

function resolveToolSchema(toolName: string, tool?: ToolDefinition): DryrunToolSchema {
  return {
    name: toolName,
    description: tool?.description,
    inputSchema: tool?.inputSchema,
    policy: tool?.policy ?? 'deny',
  };
}

function resolveToolSchemas(
  toolNames: string[],
  toolRegistry: ToolRegistry,
  runtime: RuntimeFacade,
  agentId: string,
): {
  requested: DryrunToolSchema[];
  allowedByPolicy: DryrunToolSchema[];
  deniedByPolicy: DryrunToolSchema[];
} {
  const policy = runtime.getAgentToolPolicy(agentId);
  const requested: DryrunToolSchema[] = [];
  const allowedByPolicy: DryrunToolSchema[] = [];
  const deniedByPolicy: DryrunToolSchema[] = [];

  for (const toolName of toolNames) {
    const tool = toolRegistry.get(toolName);
    const schema = resolveToolSchema(toolName, tool);
    requested.push(schema);
    const denied = policy.blacklist.includes(toolName);
    const allowed = policy.whitelist.length === 0 ? false : policy.whitelist.includes(toolName);
    if (!denied && allowed) {
      allowedByPolicy.push(schema);
    } else {
      deniedByPolicy.push(schema);
    }
  }

  return { requested, allowedByPolicy, deniedByPolicy };
}

function resolveActiveOrchestrationProfile(config: { activeProfileId: string; profiles: OrchestrationProfile[] }): OrchestrationProfile | null {
  const activeId = config.activeProfileId;
  return config.profiles.find((item) => item.id === activeId) ?? null;
}

function buildOrchestrationInjection(primaryOrchestratorAgentId: string): {
  injectedPrompt: string | null;
  injectedAgents: OrchestrationPromptAgent[];
} {
  try {
    const loaded = loadOrchestrationConfig();
    const activeProfile = resolveActiveOrchestrationProfile(loaded.config);
    if (!activeProfile) {
      return { injectedPrompt: null, injectedAgents: [] };
    }
    const { prompt, agents } = buildOrchestrationDispatchPrompt(activeProfile, { selfAgentId: primaryOrchestratorAgentId });
    return { injectedPrompt: prompt ?? null, injectedAgents: agents };
  } catch (error) {
    logger.module('dryrun').error('orchestration prompt injection failed', error instanceof Error ? error : undefined);
    return { injectedPrompt: null, injectedAgents: [] };
  }
}

function resolveContextLedger(metadata: Record<string, unknown>, roleProfile: string, agentId: string): DryrunSnapshot['contextLedger'] {
  if (metadata.contextLedgerEnabled === false) return null;
  return {
    enabled: true,
    agentId: asString(metadata.contextLedgerAgentId) ?? agentId,
    role: asString(metadata.contextLedgerRole) ?? roleProfile,
    canReadAll: metadata.contextLedgerCanReadAll === true || roleProfile === 'orchestrator',
    focusEnabled: metadata.contextLedgerFocusEnabled !== false,
    focusMaxChars: typeof metadata.contextLedgerFocusMaxChars === 'number'
      ? metadata.contextLedgerFocusMaxChars
      : 20_000,
  };
}

function writeDryrunSnapshot(
  sessionWorkspaces: SessionWorkspaceManager,
  sessionId: string,
  agentId: string,
  snapshot: DryrunSnapshot,
): void {
  const diagnosticsDir = resolveDiagnosticsDir(sessionWorkspaces, sessionId);
  const filePath = join(diagnosticsDir, `${agentId}.dryrun.jsonl`);
  appendFileSync(filePath, `${JSON.stringify(snapshot)}\n`, 'utf-8');
}

function readDryrunSnapshots(filePath: string): unknown[] {
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function registerDryrunRoutes(app: Express, deps: DryrunRouteDeps): void {
  app.post('/api/v1/dryrun', (req, res) => {
    const body = req.body as DryrunRequestBody;
    if (!body.target || body.message === undefined) {
      res.status(400).json({ error: 'Missing target or message' });
      return;
    }

    const normalizedTarget = body.target.trim();
    const isPrimaryTarget = normalizedTarget === deps.primaryOrchestratorTarget
      || normalizedTarget === deps.primaryOrchestratorAgentId;
    const routeMode = req.header('x-finger-route-mode');
    const directAllowed = deps.allowDirectAgentRoute
      || process.env.NODE_ENV === 'test'
      || (typeof routeMode === 'string' && routeMode.trim().toLowerCase() === 'test');
    if (!isPrimaryTarget && !directAllowed) {
      res.status(403).json({
        error: `Direct target routing is disabled. Use primary orchestrator target: ${deps.primaryOrchestratorTarget}`,
        code: 'DIRECT_ROUTE_DISABLED',
        target: body.target,
        primaryTarget: deps.primaryOrchestratorTarget,
      });
      return;
    }

    const text = resolveTextFromMessage(body.message);
    if (!text) {
      res.status(400).json({ error: 'Missing text content in message' });
      return;
    }

    const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim().length > 0
      ? body.sessionId.trim()
      : `dryrun-${Date.now()}`;
    const currentSession = deps.sessionManager.getCurrentSession();
    const fallbackProjectPath = currentSession?.projectPath ?? process.cwd();
    deps.sessionManager.ensureSession(sessionId, fallbackProjectPath, `dryrun-${sessionId}`);

    const baseMetadata = resolveMetadataFromMessage(body.message);
    const mergedMetadata: Record<string, unknown> = {
      ...baseMetadata,
      ...(body.roleProfile ? { roleProfile: body.roleProfile } : {}),
      sessionId,
    };
    const { injectedPrompt, injectedAgents } = isPrimaryTarget
      ? buildOrchestrationInjection(deps.primaryOrchestratorAgentId)
      : { injectedPrompt: null, injectedAgents: [] };
    const metadataForDev = injectedPrompt
      ? {
          ...mergedMetadata,
          developerInstructions: (() => {
            const existing = asString(mergedMetadata.developerInstructions)
              ?? asString(mergedMetadata.developer_instructions)
              ?? '';
            return existing ? `${injectedPrompt}\n\n${existing}` : injectedPrompt;
          })(),
        }
      : mergedMetadata;
    const roleProfile = __chatCodexInternals.resolveDeveloperRoleFromMetadata(metadataForDev);
    const requestedTools = resolveToolsFromMessage(body.message);
    const policy = deps.runtime.getAgentToolPolicy(body.target);
    const policyTools = policy.whitelist.filter((tool) => !policy.blacklist.includes(tool));
    const effectiveTools = requestedTools.length > 0
      ? requestedTools
      : policyTools;
    const toolSchemas = resolveToolSchemas(effectiveTools, deps.toolRegistry, deps.runtime, body.target);
    const developerInstructions = __chatCodexInternals.resolveDeveloperInstructions(metadataForDev, undefined, roleProfile) ?? null;
    const turnContext = __chatCodexInternals.resolveTurnContext
      ? __chatCodexInternals.resolveTurnContext(metadataForDev)
      : null;
    const environmentContext = __chatCodexInternals.resolveEnvironmentContext
      ? __chatCodexInternals.resolveEnvironmentContext(metadataForDev, turnContext ?? undefined)
      : null;
    const userInstructions = __chatCodexInternals.resolveUserInstructions
      ? __chatCodexInternals.resolveUserInstructions(metadataForDev)
      : null;

    const snapshot: DryrunSnapshot = {
      timestamp: new Date().toISOString(),
      sessionId,
      agentId: body.target,
      roleProfile,
      target: body.target,
      dryrun: true,
      input: {
        text,
        metadata: metadataForDev,
        requestedTools,
      },
      developerInstructions,
      injectedPrompt,
      injectedAgents,
      tools: toolSchemas,
      contextLedger: resolveContextLedger(metadataForDev, roleProfile, body.target),
      environmentContext,
      turnContext: turnContext ?? null,
      userInstructions,
      kernelMode: asString(metadataForDev.kernelMode ?? metadataForDev.mode) ?? 'main',
    };

    writeDryrunSnapshot(deps.sessionWorkspaces, sessionId, body.target, snapshot);
    res.json(snapshot);
  });

  app.get('/api/v1/sessions/:sessionId/dryrun', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = deps.sessionManager.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const diagnosticsDir = resolveDiagnosticsDir(deps.sessionWorkspaces, sessionId);
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId.trim() : '';

    if (agentId) {
      const filePath = join(diagnosticsDir, `${agentId}.dryrun.jsonl`);
      const snapshots = readDryrunSnapshots(filePath);
      res.json({ sessionId, agentId, snapshots });
      return;
    }

    const files = await readdir(diagnosticsDir).catch(() => []);
    const entries: Record<string, unknown[]> = {};
    for (const file of files) {
      if (!file.endsWith('.dryrun.jsonl')) continue;
      const id = file.replace('.dryrun.jsonl', '');
      entries[id] = readDryrunSnapshots(join(diagnosticsDir, file));
    }
    res.json({ sessionId, snapshots: entries });
  });
}
