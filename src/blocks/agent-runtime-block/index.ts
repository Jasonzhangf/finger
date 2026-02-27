import { BaseBlock, type BlockCapabilities } from '../../core/block.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import type { ModuleRegistry, OrchestrationModule } from '../../orchestration/module-registry.js';
import type { LoadedAgentConfig } from '../../runtime/agent-json-config.js';
import type { ResourcePool } from '../../orchestration/resource-pool.js';

export type AgentRoleType = 'executor' | 'reviewer' | 'orchestrator';
export type AgentCapabilityLayer = 'summary' | 'execution' | 'governance' | 'full';

export interface AgentImplementation {
  id: string;
  kind: 'iflow' | 'native';
  moduleId?: string;
  provider?: string;
  status: 'available' | 'unavailable';
}

export interface AgentDefinition {
  id: string;
  name: string;
  role: AgentRoleType;
  source: 'agent-json' | 'runtime-config' | 'module' | 'deployment';
  implementations: AgentImplementation[];
  tags: string[];
}

export interface AgentDeploymentRecord {
  id: string;
  agentId: string;
  implementationId: string;
  moduleId?: string;
  sessionId: string;
  scope: 'session' | 'global';
  instanceCount: number;
  launchMode: 'manual' | 'orchestrator';
  status: 'idle' | 'running' | 'error' | 'paused';
  createdAt: string;
}

interface AgentRuntimeViewItem {
  id: string;
  name: string;
  type: AgentRoleType;
  status: 'idle' | 'running' | 'error' | 'paused';
  source: 'agent-json' | 'runtime-config' | 'module' | 'deployment';
  instanceCount: number;
  deployedCount: number;
  availableCount: number;
  lastSessionId?: string;
}

interface AgentRuntimeViewInstance {
  id: string;
  agentId: string;
  name: string;
  type: AgentRoleType;
  status: 'idle' | 'running' | 'error' | 'paused';
  sessionId?: string;
  workflowId?: string;
  source: 'deployment';
  deploymentId: string;
  createdAt: string;
}

interface AgentCatalogCapabilities {
  summary: {
    role: string;
    source: string;
    status: 'idle' | 'running' | 'error' | 'paused';
    tags: string[];
  };
  execution?: {
    exposedTools: string[];
    dispatchTargets: string[];
    supportsDispatch: boolean;
    supportsControl: Array<'status' | 'pause' | 'resume' | 'interrupt' | 'cancel'>;
    implementations: Array<{ id: string; kind: 'iflow' | 'native'; moduleId?: string; status: 'available' | 'unavailable' }>;
  };
  governance?: {
    whitelist: string[];
    blacklist: string[];
    authorizationRequired: string[];
    provider?: string;
    sessionBindingScope?: string;
    iflowApprovalMode?: string;
    capabilityIds?: string[];
  };
}

export interface AgentCatalogEntry {
  id: string;
  name: string;
  type: AgentRoleType;
  status: 'idle' | 'running' | 'error' | 'paused';
  source: string;
  instanceCount: number;
  deployedCount: number;
  availableCount: number;
  lastSessionId?: string;
  capabilities: AgentCatalogCapabilities;
}

export interface AgentDispatchRequest {
  sourceAgentId: string;
  targetAgentId: string;
  task: unknown;
  sessionId?: string;
  workflowId?: string;
  blocking?: boolean;
  metadata?: Record<string, unknown>;
}

export interface AgentControlRequest {
  action: 'status' | 'pause' | 'resume' | 'interrupt' | 'cancel';
  targetAgentId?: string;
  sessionId?: string;
  workflowId?: string;
  providerId?: string;
  hard?: boolean;
}

export interface AgentControlResult {
  ok: boolean;
  action: AgentControlRequest['action'];
  status: 'accepted' | 'completed' | 'failed';
  sessionId?: string;
  workflowId?: string;
  targetAgentId?: string;
  result?: unknown;
  error?: string;
}

export interface AgentDeployRequest {
  sessionId?: string;
  scope?: 'session' | 'global';
  instanceCount?: number;
  launchMode?: 'manual' | 'orchestrator';
  config?: {
    id?: string;
    name?: string;
    role?: string;
    provider?: string;
    model?: string;
    permissionMode?: string;
    maxRounds?: number;
    enableReview?: boolean;
  };
  targetAgentId?: string;
  targetImplementationId?: string;
}

interface WorkflowTaskView {
  status: string;
  assignee?: string;
}

interface WorkflowLike {
  id: string;
  sessionId: string;
  tasks: Map<string, WorkflowTaskView>;
}

interface SessionManagerLike {
  pauseSession(sessionId: string): boolean;
  resumeSession(sessionId: string): boolean;
  getCurrentSession(): { id: string } | null;
}

interface WorkflowManagerLike {
  listWorkflows(): WorkflowLike[];
  pauseWorkflow(workflowId: string, hard?: boolean): boolean;
  resumeWorkflow(workflowId: string): boolean;
}

interface ChatCodexRunnerLike {
  listSessionStates(sessionId?: string, providerId?: string): unknown[];
  interruptSession(sessionId: string, providerId?: string): Array<{ interrupted?: boolean }>;
}

export interface AgentRuntimeBlockDeps {
  moduleRegistry: ModuleRegistry;
  hub: MessageHub;
  runtime: RuntimeFacade;
  toolRegistry: ToolRegistry;
  eventBus: UnifiedEventBus;
  workflowManager: WorkflowManagerLike;
  sessionManager: SessionManagerLike;
  chatCodexRunner: ChatCodexRunnerLike;
  resourcePool?: ResourcePool;
  getLoadedAgentConfigs: () => LoadedAgentConfig[];
  primaryOrchestratorAgentId?: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

function normalizeAgentType(value: unknown): AgentRoleType {
  if (typeof value !== 'string') return 'executor';
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('orchestr')) return 'orchestrator';
  if (normalized.includes('review')) return 'reviewer';
  return 'executor';
}

function normalizeAgentStatus(value: unknown): 'idle' | 'running' | 'error' | 'paused' {
  if (typeof value !== 'string') return 'idle';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'running' || normalized === 'busy' || normalized === 'deployed') return 'running';
  if (normalized === 'error' || normalized === 'failed' || normalized === 'blocked') return 'error';
  if (normalized === 'paused') return 'paused';
  return 'idle';
}

function resolveCapabilityLayer(value: unknown): AgentCapabilityLayer {
  if (typeof value !== 'string') return 'summary';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'execution' || normalized === 'governance' || normalized === 'full') {
    return normalized;
  }
  return 'summary';
}

function isIgnorableRuntimeModule(moduleId: string): boolean {
  return moduleId.includes('mock')
    || moduleId.includes('echo')
    || moduleId === 'chat-codex-gateway';
}

function moduleHasAgentRuntimeIdentity(module: OrchestrationModule): boolean {
  if (module.type === 'agent') return true;
  if (module.type !== 'output') return false;
  const metadata = isObjectRecord(module.metadata) ? module.metadata : null;
  const metadataType = typeof metadata?.type === 'string' ? metadata.type.toLowerCase() : '';
  const metadataRole = typeof metadata?.role === 'string' ? metadata.role.toLowerCase() : '';
  const provider = typeof metadata?.provider === 'string' ? metadata.provider.toLowerCase() : '';
  const bridge = typeof metadata?.bridge === 'string' ? metadata.bridge.toLowerCase() : '';
  const moduleId = module.id.toLowerCase();
  if (
    metadataType.includes('loop')
    || metadataType.includes('orchestr')
    || metadataType.includes('executor')
    || metadataType.includes('review')
    || metadataRole.includes('orchestr')
    || metadataRole.includes('executor')
    || metadataRole.includes('review')
  ) {
    return true;
  }
  if (bridge.includes('rust-kernel')) return true;
  if (provider === 'codex' && moduleId.includes('chat-codex')) return true;
  return moduleId.includes('-loop') || moduleId.includes('chat-codex');
}

export class AgentRuntimeBlock extends BaseBlock {
  readonly type = 'agent_runtime';
  readonly capabilities: BlockCapabilities = {
    functions: [
      'runtime_view',
      'catalog',
      'capabilities',
      'dispatch',
      'control',
      'deploy',
      'list_definitions',
      'list_startup_targets',
    ],
    cli: [],
    stateSchema: {
      definitions: { type: 'number', readonly: true, description: 'logical agent definition count' },
      deployments: { type: 'number', readonly: true, description: 'active deployment count' },
    },
    events: ['agent_runtime_catalog', 'agent_runtime_dispatch', 'agent_runtime_control', 'agent_runtime_status'],
  };

  private readonly deployments = new Map<string, AgentDeploymentRecord>();

  constructor(id: string, private readonly deps: AgentRuntimeBlockDeps) {
    super(id, 'agent_runtime');
  }

  async execute(command: string, args: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'runtime_view':
        return this.getRuntimeView();
      case 'catalog':
        return this.listCatalog(resolveCapabilityLayer(args.layer));
      case 'capabilities': {
        const agentId = typeof args.agentId === 'string' ? args.agentId.trim() : '';
        if (!agentId) throw new Error('agentId is required');
        return this.getAgentCapabilities(agentId, resolveCapabilityLayer(args.layer));
      }
      case 'dispatch':
        return this.dispatchTask(args as unknown as AgentDispatchRequest);
      case 'control':
        return this.controlRuntime(args as unknown as AgentControlRequest);
      case 'deploy':
        return this.deployAgent(args as unknown as AgentDeployRequest);
      case 'list_definitions':
        return Array.from(this.buildDefinitions().values());
      case 'list_startup_targets':
        return this.listStartupTargets();
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  private updateMetrics(defCount: number): void {
    this.updateState({
      data: {
        definitions: defCount,
        deployments: this.deployments.size,
      },
    });
  }

  private collectRunningAgentIds(): Set<string> {
    const running = new Set<string>();
    for (const workflow of this.deps.workflowManager.listWorkflows()) {
      for (const task of workflow.tasks.values()) {
        if (task.status !== 'in_progress') continue;
        if (typeof task.assignee !== 'string') continue;
        const assignee = task.assignee.trim();
        if (assignee.length > 0) running.add(assignee);
      }
    }
    return running;
  }

  private resolveToolAccess(agentId: string): {
    exposedTools: string[];
    whitelist: string[];
    blacklist: string[];
    authorizationRequired: string[];
  } {
    const toolPolicy = this.deps.runtime.getAgentToolPolicy(agentId);
    const allowedGlobalTools = this.deps.toolRegistry
      .list()
      .filter((tool) => tool.policy === 'allow')
      .map((tool) => tool.name);
    const deniedByPolicy = new Set(toolPolicy.blacklist);
    const exposedTools = (toolPolicy.whitelist.length > 0 ? toolPolicy.whitelist : allowedGlobalTools)
      .filter((toolName) => !deniedByPolicy.has(toolName));

    const loaded = this.deps.getLoadedAgentConfigs();
    const loadedConfig = loaded.find((item) => item.config.id === agentId);
    const authorizationRequired = normalizeStringArray(loadedConfig?.config.tools?.authorizationRequired);

    return {
      exposedTools: Array.from(new Set(exposedTools)).sort((a, b) => a.localeCompare(b)),
      whitelist: [...toolPolicy.whitelist].sort((a, b) => a.localeCompare(b)),
      blacklist: [...toolPolicy.blacklist].sort((a, b) => a.localeCompare(b)),
      authorizationRequired,
    };
  }

  private buildDefinitions(): Map<string, AgentDefinition> {
    const definitions = new Map<string, AgentDefinition>();
    const loadedConfigs = this.deps.getLoadedAgentConfigs();
    const modules = this.deps.moduleRegistry.getAllModules();

    const ensureDefinition = (id: string, patch: Partial<AgentDefinition>): AgentDefinition => {
      const normalizedId = id.trim();
      const existing = definitions.get(normalizedId);
      const next: AgentDefinition = {
        id: normalizedId,
        name: patch.name ?? existing?.name ?? normalizedId,
        role: patch.role ?? existing?.role ?? 'executor',
        source: patch.source ?? existing?.source ?? 'runtime-config',
        implementations: patch.implementations ?? existing?.implementations ?? [],
        tags: patch.tags ?? existing?.tags ?? [],
      };
      definitions.set(normalizedId, next);
      return next;
    };

    const appendImplementation = (agentId: string, impl: AgentImplementation): void => {
      const def = definitions.get(agentId);
      if (!def) return;
      if (def.implementations.some((item) => item.id === impl.id)) return;
      def.implementations.push(impl);
      def.implementations.sort((a, b) => a.id.localeCompare(b.id));
      definitions.set(agentId, def);
    };

    for (const item of loadedConfigs) {
      const config = item.config;
      const role = normalizeAgentType(config.role);
      const tags = [role, 'configured'];
      const def = ensureDefinition(config.id, {
        name: config.name ?? config.id,
        role,
        source: 'agent-json',
        tags,
      });

      if (config.provider?.type?.toLowerCase() === 'iflow') {
        appendImplementation(def.id, {
          id: 'iflow',
          kind: 'iflow',
          provider: 'iflow',
          status: 'available',
        });
      }

      if (Array.isArray(config.implementations)) {
        for (const impl of config.implementations) {
          if (!impl || impl.enabled === false) continue;
          appendImplementation(def.id, {
            id: impl.id,
            kind: impl.kind,
            ...(typeof impl.moduleId === 'string' && impl.moduleId.trim().length > 0 ? { moduleId: impl.moduleId.trim() } : {}),
            ...(typeof impl.provider === 'string' && impl.provider.trim().length > 0 ? { provider: impl.provider.trim() } : {}),
            status: 'available',
          });
        }
      }

      if (config.provider?.type && config.provider.type.toLowerCase() !== 'iflow') {
        appendImplementation(def.id, {
          id: `provider:${config.provider.type}`,
          kind: 'native',
          provider: config.provider.type,
          status: 'available',
        });
      }
    }

    for (const module of modules) {
      if (isIgnorableRuntimeModule(module.id)) continue;
      if (!moduleHasAgentRuntimeIdentity(module)) continue;

      const role = normalizeAgentType(module.metadata?.role ?? module.metadata?.type ?? module.id);
      const moduleName = typeof module.name === 'string' && module.name.trim().length > 0 ? module.name : module.id;
      const candidates = new Set<string>([module.id]);
      if (module.id.endsWith('-loop')) {
        candidates.add(module.id.replace(/-loop$/, ''));
      }

      let preferredId = module.id;
      for (const candidate of candidates) {
        if (definitions.has(candidate)) {
          preferredId = candidate;
          break;
        }
      }

      ensureDefinition(preferredId, {
        name: moduleName,
        role,
        source: definitions.has(preferredId) ? definitions.get(preferredId)!.source : 'module',
        tags: Array.from(new Set([...(definitions.get(preferredId)?.tags ?? []), role, 'runtime-module'])),
      });

      appendImplementation(preferredId, {
        id: `native:${module.id}`,
        kind: 'native',
        moduleId: module.id,
        status: 'available',
      });
    }

    for (const deployment of this.deployments.values()) {
      const existing = definitions.get(deployment.agentId);
      const role = existing?.role ?? normalizeAgentType(deployment.agentId);
      ensureDefinition(deployment.agentId, {
        name: existing?.name ?? deployment.agentId,
        role,
        source: 'deployment',
        tags: Array.from(new Set([...(existing?.tags ?? []), role, 'deployed'])),
      });
      if (deployment.implementationId && !definitions.get(deployment.agentId)?.implementations.some((item) => item.id === deployment.implementationId)) {
        appendImplementation(deployment.agentId, {
          id: deployment.implementationId,
          kind: deployment.implementationId === 'iflow' ? 'iflow' : 'native',
          ...(deployment.moduleId ? { moduleId: deployment.moduleId } : {}),
          status: deployment.moduleId ? 'available' : 'unavailable',
        });
      }
    }

    for (const [agentId, def] of definitions.entries()) {
      if (def.implementations.length === 0) {
        def.implementations.push({ id: 'native:unbound', kind: 'native', status: 'unavailable' });
      }
      definitions.set(agentId, def);
    }

    this.updateMetrics(definitions.size);
    return definitions;
  }

  private getRuntimeView(): {
    agents: AgentRuntimeViewItem[];
    instances: AgentRuntimeViewInstance[];
    configs: Array<{ id: string; name: string; role?: string; filePath: string; tools?: Record<string, unknown> }>;
    definitions: AgentDefinition[];
    startupTargets: AgentDefinition[];
  } {
    const runningAgentIds = this.collectRunningAgentIds();
    const definitions = this.buildDefinitions();

    const workflowBySessionId = new Map<string, string>();
    for (const workflow of this.deps.workflowManager.listWorkflows()) {
      if (typeof workflow.sessionId === 'string' && workflow.sessionId.trim().length > 0) {
        workflowBySessionId.set(workflow.sessionId, workflow.id);
      }
    }

    const instances: AgentRuntimeViewInstance[] = [];
    for (const deployment of this.deployments.values()) {
      const baseStatus = normalizeAgentStatus(deployment.status);
      const instanceTotal = Math.max(1, Number.isFinite(deployment.instanceCount) ? Math.floor(deployment.instanceCount) : 1);
      for (let idx = 0; idx < instanceTotal; idx += 1) {
        const id = instanceTotal === 1 ? deployment.id : `${deployment.id}#${idx + 1}`;
        const status = runningAgentIds.has(deployment.agentId) ? 'running' : baseStatus;
        const workflowId = workflowBySessionId.get(deployment.sessionId);
        instances.push({
          id,
          agentId: deployment.agentId,
          name: instanceTotal === 1 ? deployment.agentId : `${deployment.agentId}#${idx + 1}`,
          type: definitions.get(deployment.agentId)?.role ?? 'executor',
          status,
          ...(deployment.sessionId ? { sessionId: deployment.sessionId } : {}),
          ...(workflowId ? { workflowId } : {}),
          source: 'deployment',
          deploymentId: deployment.id,
          createdAt: deployment.createdAt,
        });
      }
    }

    const byAgentId = new Map<string, AgentRuntimeViewInstance[]>();
    for (const item of instances) {
      const list = byAgentId.get(item.agentId) ?? [];
      list.push(item);
      byAgentId.set(item.agentId, list);
    }

    const agents: AgentRuntimeViewItem[] = [];
    for (const def of definitions.values()) {
      const related = byAgentId.get(def.id) ?? [];
      const deployedCount = related.filter((item) => item.status === 'running' || item.status === 'paused').length;
      const latestSession = related
        .slice()
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .find((item) => typeof item.sessionId === 'string' && item.sessionId.length > 0)
        ?.sessionId;
      agents.push({
        id: def.id,
        name: def.name,
        type: def.role,
        status: related.some((item) => item.status === 'error')
          ? 'error'
          : runningAgentIds.has(def.id)
            ? 'running'
            : related.some((item) => item.status === 'paused')
              ? 'paused'
              : 'idle',
        source: def.source,
        instanceCount: related.length,
        deployedCount,
        availableCount: Math.max(0, related.length - deployedCount),
        ...(latestSession ? { lastSessionId: latestSession } : {}),
      });
    }

    const configs = this.deps.getLoadedAgentConfigs().map((item) => ({
      id: item.config.id,
      name: item.config.name ?? item.config.id,
      ...(item.config.role ? { role: item.config.role } : {}),
      filePath: item.filePath,
      ...(item.config.tools ? { tools: item.config.tools as Record<string, unknown> } : {}),
    }));

    const startupTargets = Array.from(definitions.values())
      .filter((def) => (byAgentId.get(def.id)?.length ?? 0) === 0)
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      agents: agents.sort((a, b) => a.name.localeCompare(b.name)),
      instances: instances.sort((a, b) => a.name.localeCompare(b.name)),
      configs,
      definitions: Array.from(definitions.values()).sort((a, b) => a.name.localeCompare(b.name)),
      startupTargets,
    };
  }

  private listCatalog(layer: AgentCapabilityLayer): {
    ok: true;
    layer: AgentCapabilityLayer;
    count: number;
    agents: AgentCatalogEntry[];
    startupTargets: AgentDefinition[];
  } {
    const runtimeView = this.getRuntimeView();
    const supportsControl: Array<'status' | 'pause' | 'resume' | 'interrupt' | 'cancel'> = [
      'status',
      'pause',
      'resume',
      'interrupt',
      'cancel',
    ];
    const dispatchTargets = runtimeView.instances
      .filter((item) => item.status !== 'error')
      .map((item) => item.agentId)
      .filter((item, index, arr) => arr.indexOf(item) === index)
      .sort((a, b) => a.localeCompare(b));

    const definitions = new Map(runtimeView.definitions.map((def) => [def.id, def]));

    const catalog = runtimeView.agents.map((agent) => {
      const runtimeConfig = this.deps.runtime.getAgentRuntimeConfig(agent.id);
      const loadedConfig = this.deps.getLoadedAgentConfigs().find((item) => item.config.id === agent.id);
      const toolAccess = this.resolveToolAccess(agent.id);
      const definition = definitions.get(agent.id);

      const summaryTags = Array.from(
        new Set([
          agent.type,
          ...(toolAccess.exposedTools.includes('agent.deploy') ? ['deploy'] : []),
          ...(toolAccess.exposedTools.includes('agent.dispatch') ? ['dispatch'] : []),
          ...(toolAccess.exposedTools.includes('agent.control') ? ['control'] : []),
          ...(toolAccess.exposedTools.includes('agent.list') ? ['catalog'] : []),
          ...(definition?.tags ?? []),
        ]),
      );

      const capabilities: AgentCatalogCapabilities = {
        summary: {
          role: runtimeConfig?.role ?? loadedConfig?.config.role ?? agent.type,
          source: agent.source,
          status: agent.status,
          tags: summaryTags,
        },
      };

      if (layer === 'execution' || layer === 'full') {
        capabilities.execution = {
          exposedTools: toolAccess.exposedTools,
          dispatchTargets,
          supportsDispatch: toolAccess.exposedTools.includes('agent.dispatch'),
          supportsControl,
          implementations: (definition?.implementations ?? []).map((impl) => ({
            id: impl.id,
            kind: impl.kind,
            ...(impl.moduleId ? { moduleId: impl.moduleId } : {}),
            status: impl.status,
          })),
        };
      }

      if (layer === 'governance' || layer === 'full') {
        capabilities.governance = {
          whitelist: toolAccess.whitelist,
          blacklist: toolAccess.blacklist,
          authorizationRequired: toolAccess.authorizationRequired,
          ...(typeof runtimeConfig?.provider?.type === 'string' ? { provider: runtimeConfig.provider.type } : {}),
          ...(typeof runtimeConfig?.session?.bindingScope === 'string' ? { sessionBindingScope: runtimeConfig.session.bindingScope } : {}),
          ...(typeof runtimeConfig?.governance?.iflow?.approvalMode === 'string'
            ? { iflowApprovalMode: runtimeConfig.governance.iflow.approvalMode }
            : {}),
          ...(Array.isArray(runtimeConfig?.governance?.iflow?.capabilityIds)
            ? { capabilityIds: normalizeStringArray(runtimeConfig?.governance?.iflow?.capabilityIds) }
            : {}),
        };
      }

      return {
        id: agent.id,
        name: agent.name,
        type: agent.type,
        status: agent.status,
        source: agent.source,
        instanceCount: agent.instanceCount,
        deployedCount: agent.deployedCount,
        availableCount: agent.availableCount,
        ...(agent.lastSessionId ? { lastSessionId: agent.lastSessionId } : {}),
        capabilities,
      };
    });

    void this.deps.eventBus.emit({
      type: 'agent_runtime_catalog',
      sessionId: this.deps.sessionManager.getCurrentSession()?.id ?? 'default',
      timestamp: new Date().toISOString(),
      payload: {
        layer,
        count: catalog.length,
        agentIds: catalog.map((item) => item.id),
      },
    });

    return {
      ok: true,
      layer,
      count: catalog.length,
      agents: catalog,
      startupTargets: runtimeView.startupTargets,
    };
  }

  private getAgentCapabilities(agentId: string, layer: AgentCapabilityLayer): { ok: boolean; layer: AgentCapabilityLayer; agent?: AgentCatalogEntry; error?: string } {
    const catalog = this.listCatalog(layer);
    const agent = catalog.agents.find((item) => item.id === agentId);
    if (!agent) return { ok: false, layer, error: `agent not found: ${agentId}` };
    return { ok: true, layer, agent };
  }

  private resolveDeploymentByAgentId(agentId: string): AgentDeploymentRecord | null {
    const candidates = Array.from(this.deployments.values()).filter((item) => item.agentId === agentId);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return candidates[0];
  }

  private toDispatchPayload(input: AgentDispatchRequest, dispatchId: string): Record<string, unknown> {
    const metadata = {
      ...(isObjectRecord(input.metadata) ? input.metadata : {}),
      dispatchId,
      sourceAgentId: input.sourceAgentId,
      targetAgentId: input.targetAgentId,
      orchestration: true,
    };

    if (isObjectRecord(input.task)) {
      const next: Record<string, unknown> = { ...input.task };
      if (typeof next.sessionId !== 'string' && typeof input.sessionId === 'string' && input.sessionId.trim().length > 0) {
        next.sessionId = input.sessionId;
      }
      const originalMetadata = isObjectRecord(next.metadata) ? next.metadata : {};
      next.metadata = { ...originalMetadata, ...metadata };
      return next;
    }

    return {
      text: typeof input.task === 'string' ? input.task : JSON.stringify(input.task),
      ...(typeof input.sessionId === 'string' && input.sessionId.trim().length > 0 ? { sessionId: input.sessionId } : {}),
      metadata,
    };
  }

  private emitDispatchEvent(params: {
    dispatchId: string;
    sourceAgentId: string;
    targetAgentId: string;
    status: 'queued' | 'completed' | 'failed';
    blocking: boolean;
    sessionId?: string;
    workflowId?: string;
    error?: string;
  }): void {
    void this.deps.eventBus.emit({
      type: 'agent_runtime_dispatch',
      sessionId: params.sessionId ?? this.deps.sessionManager.getCurrentSession()?.id ?? 'default',
      agentId: params.targetAgentId,
      timestamp: new Date().toISOString(),
      payload: {
        dispatchId: params.dispatchId,
        sourceAgentId: params.sourceAgentId,
        targetAgentId: params.targetAgentId,
        status: params.status,
        blocking: params.blocking,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.workflowId ? { workflowId: params.workflowId } : {}),
        ...(params.error ? { error: params.error } : {}),
      },
    });
  }

  private emitControlEvent(result: AgentControlResult): void {
    void this.deps.eventBus.emit({
      type: 'agent_runtime_control',
      sessionId: result.sessionId ?? this.deps.sessionManager.getCurrentSession()?.id ?? 'default',
      agentId: result.targetAgentId,
      timestamp: new Date().toISOString(),
      payload: {
        action: result.action,
        status: result.status,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.workflowId ? { workflowId: result.workflowId } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
    });
  }

  private emitStatusEvent(params: {
    sessionId?: string;
    workflowId?: string;
    status: 'ok' | 'error';
    error?: string;
  }): void {
    void this.deps.eventBus.emit({
      type: 'agent_runtime_status',
      sessionId: params.sessionId ?? this.deps.sessionManager.getCurrentSession()?.id ?? 'default',
      timestamp: new Date().toISOString(),
      payload: {
        scope: params.workflowId ? 'workflow' : params.sessionId ? 'session' : 'global',
        status: params.status,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.workflowId ? { workflowId: params.workflowId } : {}),
        runningAgents: Array.from(this.collectRunningAgentIds()).sort((a, b) => a.localeCompare(b)),
        ...(params.error ? { error: params.error } : {}),
      },
    });
  }

  private async dispatchTask(input: AgentDispatchRequest): Promise<{
    ok: boolean;
    dispatchId: string;
    status: 'queued' | 'completed' | 'failed';
    result?: unknown;
    error?: string;
    targetModuleId?: string;
  }> {
    const target = input.targetAgentId.trim();
    if (!target) {
      return {
        ok: false,
        dispatchId: `dispatch-${Date.now()}-invalid`,
        status: 'failed',
        error: 'targetAgentId is required',
      };
    }

    const deployment = this.resolveDeploymentByAgentId(target);
    if (!deployment) {
      return {
        ok: false,
        dispatchId: `dispatch-${Date.now()}-not-started`,
        status: 'failed',
        error: `target agent is not started in resource pool: ${target}`,
      };
    }
    const targetModuleId = deployment.moduleId ?? target;

    const module = this.deps.moduleRegistry.getModule(targetModuleId);
    if (!module) {
      return {
        ok: false,
        dispatchId: `dispatch-${Date.now()}-missing`,
        status: 'failed',
        error: `target module not found or not started: ${target}`,
      };
    }

    const blocking = input.blocking === true;
    const dispatchId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const payload = this.toDispatchPayload(input, dispatchId);

    this.emitDispatchEvent({
      dispatchId,
      sourceAgentId: input.sourceAgentId,
      targetAgentId: target,
      status: 'queued',
      blocking,
      sessionId: input.sessionId,
      workflowId: input.workflowId,
    });

    if (blocking) {
      try {
        const result = await this.deps.hub.sendToModule(targetModuleId, payload);
        this.emitDispatchEvent({
          dispatchId,
          sourceAgentId: input.sourceAgentId,
          targetAgentId: target,
          status: 'completed',
          blocking,
          sessionId: input.sessionId,
          workflowId: input.workflowId,
        });
        return { ok: true, dispatchId, status: 'completed', result, targetModuleId };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emitDispatchEvent({
          dispatchId,
          sourceAgentId: input.sourceAgentId,
          targetAgentId: target,
          status: 'failed',
          blocking,
          sessionId: input.sessionId,
          workflowId: input.workflowId,
          error: message,
        });
        return { ok: false, dispatchId, status: 'failed', error: message, targetModuleId };
      }
    }

    void this.deps.hub.sendToModule(targetModuleId, payload)
      .then(() => {
        this.emitDispatchEvent({
          dispatchId,
          sourceAgentId: input.sourceAgentId,
          targetAgentId: target,
          status: 'completed',
          blocking,
          sessionId: input.sessionId,
          workflowId: input.workflowId,
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.emitDispatchEvent({
          dispatchId,
          sourceAgentId: input.sourceAgentId,
          targetAgentId: target,
          status: 'failed',
          blocking,
          sessionId: input.sessionId,
          workflowId: input.workflowId,
          error: message,
        });
      });

    return { ok: true, dispatchId, status: 'queued', targetModuleId };
  }

  private async controlRuntime(input: AgentControlRequest): Promise<AgentControlResult> {
    const action = input.action;
    const targetAgentId = typeof input.targetAgentId === 'string' ? input.targetAgentId.trim() : undefined;
    const sessionId = typeof input.sessionId === 'string' && input.sessionId.trim().length > 0
      ? input.sessionId.trim()
      : undefined;
    const workflowId = typeof input.workflowId === 'string' && input.workflowId.trim().length > 0
      ? input.workflowId.trim()
      : undefined;

    try {
      if (action === 'status') {
        const catalog = this.listCatalog('summary');
        const result: AgentControlResult = {
          ok: true,
          action,
          status: 'completed',
          ...(targetAgentId ? { targetAgentId } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(workflowId ? { workflowId } : {}),
          result: {
            catalog,
            runtimeView: this.getRuntimeView(),
            chatCodexSessions: this.deps.chatCodexRunner.listSessionStates(sessionId, input.providerId),
          },
        };
        this.emitStatusEvent({ sessionId, workflowId, status: 'ok' });
        this.emitControlEvent(result);
        return result;
      }

      if (action === 'pause') {
        if (workflowId) {
          const paused = this.deps.workflowManager.pauseWorkflow(workflowId, input.hard === true);
          const result: AgentControlResult = paused
            ? { ok: true, action, status: 'completed', workflowId, ...(targetAgentId ? { targetAgentId } : {}), result: { workflowId, status: 'paused' } }
            : { ok: false, action, status: 'failed', workflowId, ...(targetAgentId ? { targetAgentId } : {}), error: `workflow not found: ${workflowId}` };
          this.emitControlEvent(result);
          return result;
        }
        if (!sessionId) {
          const result: AgentControlResult = { ok: false, action, status: 'failed', ...(targetAgentId ? { targetAgentId } : {}), error: 'pause requires sessionId or workflowId' };
          this.emitControlEvent(result);
          return result;
        }
        const paused = this.deps.sessionManager.pauseSession(sessionId);
        const result: AgentControlResult = paused
          ? { ok: true, action, status: 'completed', sessionId, ...(targetAgentId ? { targetAgentId } : {}), result: { sessionId, status: 'paused' } }
          : { ok: false, action, status: 'failed', sessionId, ...(targetAgentId ? { targetAgentId } : {}), error: `session not found: ${sessionId}` };
        this.emitControlEvent(result);
        return result;
      }

      if (action === 'resume') {
        if (workflowId) {
          const resumed = this.deps.workflowManager.resumeWorkflow(workflowId);
          const result: AgentControlResult = resumed
            ? { ok: true, action, status: 'completed', workflowId, ...(targetAgentId ? { targetAgentId } : {}), result: { workflowId, status: 'executing' } }
            : { ok: false, action, status: 'failed', workflowId, ...(targetAgentId ? { targetAgentId } : {}), error: `workflow not found: ${workflowId}` };
          this.emitControlEvent(result);
          return result;
        }
        if (!sessionId) {
          const result: AgentControlResult = { ok: false, action, status: 'failed', ...(targetAgentId ? { targetAgentId } : {}), error: 'resume requires sessionId or workflowId' };
          this.emitControlEvent(result);
          return result;
        }
        const resumed = this.deps.sessionManager.resumeSession(sessionId);
        const result: AgentControlResult = resumed
          ? { ok: true, action, status: 'completed', sessionId, ...(targetAgentId ? { targetAgentId } : {}), result: { sessionId, status: 'active' } }
          : { ok: false, action, status: 'failed', sessionId, ...(targetAgentId ? { targetAgentId } : {}), error: `session not found: ${sessionId}` };
        this.emitControlEvent(result);
        return result;
      }

      if (action === 'interrupt' || action === 'cancel') {
        if (!sessionId) {
          const result: AgentControlResult = {
            ok: false,
            action,
            status: 'failed',
            ...(targetAgentId ? { targetAgentId } : {}),
            error: 'interrupt/cancel requires sessionId',
          };
          this.emitControlEvent(result);
          return result;
        }
        const results = this.deps.chatCodexRunner.interruptSession(sessionId, input.providerId);
        const result: AgentControlResult = {
          ok: true,
          action,
          status: 'completed',
          sessionId,
          ...(targetAgentId ? { targetAgentId } : {}),
          result: {
            interruptedCount: results.filter((item) => item.interrupted).length,
            sessions: results,
          },
        };
        this.emitControlEvent(result);
        return result;
      }

      const failed: AgentControlResult = {
        ok: false,
        action,
        status: 'failed',
        ...(targetAgentId ? { targetAgentId } : {}),
        error: `unsupported control action: ${action}`,
      };
      this.emitControlEvent(failed);
      return failed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitStatusEvent({ sessionId, workflowId, status: 'error', error: message });
      const failed: AgentControlResult = {
        ok: false,
        action,
        status: 'failed',
        ...(sessionId ? { sessionId } : {}),
        ...(workflowId ? { workflowId } : {}),
        ...(targetAgentId ? { targetAgentId } : {}),
        error: message,
      };
      this.emitControlEvent(failed);
      return failed;
    }
  }

  private resolveDefinitionForDeploy(request: AgentDeployRequest, definitions: Map<string, AgentDefinition>): AgentDefinition | null {
    const configuredId = typeof request.config?.id === 'string' ? request.config.id.trim() : '';
    const targetAgentId = typeof request.targetAgentId === 'string' ? request.targetAgentId.trim() : '';
    const resolvedId = targetAgentId || configuredId;
    if (resolvedId && definitions.has(resolvedId)) return definitions.get(resolvedId)!;

    if (resolvedId) {
      const role = normalizeAgentType(request.config?.role ?? resolvedId);
      const draft: AgentDefinition = {
        id: resolvedId,
        name: request.config?.name?.trim() || resolvedId,
        role,
        source: 'deployment',
        implementations: [
          {
            id: request.config?.provider === 'iflow' ? 'iflow' : 'native:unbound',
            kind: request.config?.provider === 'iflow' ? 'iflow' : 'native',
            ...(request.config?.provider ? { provider: request.config.provider } : {}),
            status: 'unavailable',
          },
        ],
        tags: [role, 'deployment'],
      };
      definitions.set(resolvedId, draft);
      return draft;
    }

    return null;
  }

  private resolveDeploymentImplementation(
    definition: AgentDefinition,
    request: AgentDeployRequest,
  ): AgentImplementation {
    const preferredImplId = typeof request.targetImplementationId === 'string'
      ? request.targetImplementationId.trim()
      : '';
    if (preferredImplId) {
      const exact = definition.implementations.find((impl) => impl.id === preferredImplId);
      if (exact) return exact;
    }

    const preferredProvider = typeof request.config?.provider === 'string' ? request.config.provider.trim().toLowerCase() : '';
    if (preferredProvider === 'iflow') {
      const iflow = definition.implementations.find((impl) => impl.kind === 'iflow');
      if (iflow) return iflow;
    }

    const availableNative = definition.implementations.find((impl) => impl.kind === 'native' && impl.status === 'available');
    if (availableNative) return availableNative;

    return definition.implementations[0];
  }

  private syncResourcePool(deployment: AgentDeploymentRecord, definition: AgentDefinition): void {
    if (!this.deps.resourcePool) return;

    const existing = this.deps.resourcePool
      .getAllResources()
      .filter((item) => item.id.startsWith(`${deployment.agentId}::${deployment.implementationId}`));

    const required = Math.max(1, deployment.instanceCount);
    const type = definition.role;
    const capabilities = [{ type: 'execution', level: 7 }];

    for (let i = existing.length; i < required; i += 1) {
      const resourceId = `${deployment.agentId}::${deployment.implementationId}#${i + 1}`;
      this.deps.resourcePool.addResource({
        id: resourceId,
        name: `${definition.name} (${deployment.implementationId}) #${i + 1}`,
        type,
        capabilities,
        status: 'available',
      });
    }
  }

  private deployAgent(request: AgentDeployRequest): {
    success: boolean;
    deployment?: AgentDeploymentRecord;
    startupTargets: AgentDefinition[];
    error?: string;
  } {
    const definitions = this.buildDefinitions();
    const definition = this.resolveDefinitionForDeploy(request, definitions);
    if (!definition) {
      return { success: false, startupTargets: this.listStartupTargets(), error: 'target agent is required' };
    }

    const impl = this.resolveDeploymentImplementation(definition, request);
    const deploymentId = `deployment-${definition.id}-${impl.id.replace(/[^a-zA-Z0-9-_]/g, '_')}`;
    const previous = this.deployments.get(deploymentId);

    const deployment: AgentDeploymentRecord = {
      id: deploymentId,
      agentId: definition.id,
      implementationId: impl.id,
      ...(impl.moduleId ? { moduleId: impl.moduleId } : {}),
      sessionId: (typeof request.sessionId === 'string' && request.sessionId.trim().length > 0)
        ? request.sessionId.trim()
        : this.deps.sessionManager.getCurrentSession()?.id ?? 'default',
      scope: request.scope === 'global' ? 'global' : 'session',
      instanceCount: Number.isFinite(request.instanceCount) ? Math.max(1, Math.floor(request.instanceCount!)) : (previous?.instanceCount ?? 1),
      launchMode: request.launchMode === 'orchestrator' ? 'orchestrator' : 'manual',
      status: previous?.status ?? 'idle',
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    };

    if (request.config?.provider === 'iflow' || request.config?.provider === 'openai' || request.config?.provider === 'anthropic') {
      this.deps.runtime.setAgentRuntimeConfig(definition.id, {
        id: definition.id,
        name: request.config?.name ?? definition.name,
        role: request.config?.role ?? definition.role,
        provider: {
          type: request.config.provider,
          ...(request.config.model ? { model: request.config.model } : {}),
        },
      });
    }

    this.deployments.set(deploymentId, deployment);
    this.syncResourcePool(deployment, definition);

    this.emitStatusEvent({
      sessionId: deployment.sessionId,
      status: 'ok',
    });

    return {
      success: true,
      deployment,
      startupTargets: this.listStartupTargets(),
    };
  }

  private listStartupTargets(): AgentDefinition[] {
    const view = this.getRuntimeView();
    return view.startupTargets;
  }
}
