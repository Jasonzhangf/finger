import { BaseBlock, type BlockCapabilities } from '../../core/block.js';
import type { RuntimeFacade } from '../../runtime/runtime-facade.js';
import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import type { ModuleRegistry, OrchestrationModule } from '../../orchestration/module-registry.js';
import type { LoadedAgentConfig } from '../../runtime/agent-json-config.js';
import type { ResourcePool } from '../../orchestration/resource-pool.js';

import { buildDispatchTaskText, extractTaskText, sanitizeDispatchResult, type DispatchSummaryResult } from '../../common/agent-dispatch.js';
import { resolveSystemDispatchPolicy } from '../../core/system-dispatch-policy.js';

import { logger } from '../../core/logger.js';

const log = logger.module('AgentRuntimeBlock');
const SYSTEM_AGENT_ID = 'finger-system-agent';

export type AgentRoleType = 'system' | 'project' | 'reviewer';

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

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}

export interface AgentStartupTemplate {
  id: string;
  name: string;
  role: AgentRoleType;
  defaultImplementationId: string;
  defaultModuleId: string;
  defaultInstanceCount: number;
  launchMode: 'manual' | 'orchestrator';
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

type AgentRuntimeStatus =
  | 'idle'
  | 'running'
  | 'error'
  | 'paused'
  | 'queued'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'interrupted';

type AgentQuotaSource = 'workflow' | 'project' | 'defaultQuota' | 'deployment';

interface AgentQuotaPolicyView {
  projectQuota?: number;
  workflowQuota: Record<string, number>;
}

interface AgentQuotaView {
  effective: number;
  source: AgentQuotaSource;
  workflowId?: string;
}

interface AgentLastEventView {
  type: 'dispatch' | 'control' | 'status';
  status: string;
  summary: string;
  timestamp: string;
  laneKey?: string;
  sessionId?: string;
  workflowId?: string;
  dispatchId?: string;
  sourceAgentId?: string;
  taskId?: string;
}

interface AgentDispatchLaneView {
  laneKey: string;
  agentId: string;
  projectId?: string;
  workerId?: string;
  sessionId?: string;
  runningCount: number;
  queuedCount: number;
  capacity: number;
}

interface AgentRuntimeViewItem {
  id: string;
  name: string;
  type: AgentRoleType;
  status: AgentRuntimeStatus;
  source: 'agent-json' | 'runtime-config' | 'module' | 'deployment';
  instanceCount: number;
  deployedCount: number;
  availableCount: number;
  runningCount: number;
  queuedCount: number;
  enabled: boolean;
  capabilities: string[];
  defaultQuota?: number;
  quotaPolicy: AgentQuotaPolicyView;
  quota: AgentQuotaView;
  lastEvent?: AgentLastEventView;
  lastSessionId?: string;
}

const BASE_STARTUP_TEMPLATES: AgentStartupTemplate[] = [
  {
    id: 'finger-project-agent',
    name: 'Project Agent',
    role: 'project',
    defaultImplementationId: 'native:finger-project-agent',
    defaultModuleId: 'finger-project-agent',
    defaultInstanceCount: 1,
    launchMode: 'orchestrator',
  },
  {
    id: 'finger-system-agent',
    name: 'System Agent',
    role: 'system',
    defaultImplementationId: 'native:finger-system-agent',
    defaultModuleId: 'finger-system-agent',
    defaultInstanceCount: 1,
    launchMode: 'manual',
  },
];

interface AgentRuntimeViewInstance {
  id: string;
  agentId: string;
  name: string;
  type: AgentRoleType;
  status: AgentRuntimeStatus;
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
    status: AgentRuntimeStatus;
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
  status: AgentRuntimeStatus;
  source: string;
  instanceCount: number;
  deployedCount: number;
  availableCount: number;
  runningCount: number;
  queuedCount: number;
  defaultQuota?: number;
  quota: AgentQuotaView;
  lastEvent?: AgentLastEventView;
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
  queueOnBusy?: boolean;
  maxQueueWaitMs?: number;
  assignment?: AgentAssignmentLifecycle;
  metadata?: Record<string, unknown>;
}

export interface AgentAssignmentLifecycle {
  epicId?: string;
  taskId?: string;
  bdTaskId?: string;
  assignerAgentId?: string;
  assigneeAgentId?: string;
  phase?: 'assigned' | 'queued' | 'started' | 'reviewing' | 'retry' | 'passed' | 'failed' | 'closed';
  attempt?: number;
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

export interface DispatchQueueTimeoutFallbackResult {
  delivery: 'mailbox';
  mailboxMessageId: string;
  summary?: string;
  nextAction?: string;
  timeoutMs?: number;
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
    enabled?: boolean;
    capabilities?: string[];
    defaultQuota?: number;
    quotaPolicy?: {
      projectQuota?: number;
      workflowQuota?: Record<string, number>;
    };
  };
  targetAgentId?: string;
  targetImplementationId?: string;
}

interface WorkflowTaskView {
  status: string;
  assignee?: string;
}

interface QueuedDispatchItem {
  dispatchId: string;
  laneKey: string;
  input: AgentDispatchRequest;
  targetModuleId: string;
  assignment?: AgentAssignmentLifecycle;
  resolve: (result: DispatchResult) => void;
  timeoutHandle?: NodeJS.Timeout;
}

interface DispatchLaneMeta {
  laneKey: string;
  targetAgentId: string;
  projectId?: string;
  workerId?: string;
  sessionId?: string;
}

interface DispatchResult {
  ok: boolean;
  dispatchId: string;
  status: 'queued' | 'completed' | 'failed';
  result?: DispatchSummaryResult;
  error?: string;
  targetModuleId?: string;
  queuePosition?: number;
}

function resolveTerminalAssignmentPhase(
  assignment: AgentAssignmentLifecycle | undefined,
  ok: boolean,
  result?: unknown,
): AgentAssignmentLifecycle | undefined {
  if (!assignment) return undefined;
  if (!ok) {
    return { ...assignment, phase: 'failed' };
  }
  const record = isObjectRecord(result) ? result : {};
  const reviewDecisionRaw = typeof record.reviewDecision === 'string'
    ? record.reviewDecision
    : typeof record.review_decision === 'string'
      ? record.review_decision
      : typeof record.reviewStatus === 'string'
        ? record.reviewStatus
        : typeof record.review_status === 'string'
          ? record.review_status
          : '';
  const reviewDecision = reviewDecisionRaw.trim().toLowerCase();
  if (reviewDecision === 'retry' || reviewDecision === 'rework' || reviewDecision === 'reject') {
    return { ...assignment, phase: 'retry' };
  }
  if (reviewDecision === 'pass' || reviewDecision === 'passed' || reviewDecision === 'approved') {
    return { ...assignment, phase: 'passed' };
  }
  if (reviewDecision === 'reviewing') {
    return { ...assignment, phase: 'reviewing' };
  }
  return { ...assignment, phase: 'closed' };
}

function resolveDispatchCompletionStatus(result: DispatchSummaryResult): {
  ok: boolean;
  status: 'completed' | 'failed';
  error?: string;
} {
  const normalizedStatus = typeof result.status === 'string'
    ? result.status.trim().toLowerCase()
    : '';
  const failedByStatus = (
    normalizedStatus === 'failed'
    || normalizedStatus === 'error'
    || normalizedStatus === 'timeout'
    || normalizedStatus === 'timed_out'
    || normalizedStatus === 'interrupted'
    || normalizedStatus === 'cancelled'
    || normalizedStatus === 'canceled'
    || normalizedStatus === 'aborted'
  );
  const failed = result.success === false || failedByStatus || (typeof result.error === 'string' && result.error.trim().length > 0);
  if (!failed) return { ok: true, status: 'completed' };
  const resolvedError = (result.error && result.error.trim().length > 0)
    ? result.error.trim()
    : result.summary;
  return {
    ok: false,
    status: 'failed',
    ...(resolvedError ? { error: resolvedError } : {}),
  };
}

interface WorkflowLike {
  id: string;
  sessionId: string;
  status?: string;
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

interface AgentRuntimeConfigProfile {
  enabled: boolean;
  capabilities: string[];
  defaultQuota: number | undefined;
  hasExplicitDefaultQuota: boolean;
  quotaPolicy: AgentQuotaPolicyView;
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
  onDispatchQueueTimeout?: (params: {
    dispatchId: string;
    sourceAgentId: string;
    targetAgentId: string;
    sessionId?: string;
    workflowId?: string;
    assignment?: AgentAssignmentLifecycle;
    task: unknown;
    metadata?: Record<string, unknown>;
  }) => DispatchQueueTimeoutFallbackResult | null;
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
  if (typeof value !== 'string') return 'project';
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('system')) return 'system';
  if (normalized.includes('review')) return 'reviewer';
  return 'project';
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

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function normalizeWorkflowQuota(raw: unknown): Record<string, number> {
  if (!isObjectRecord(raw)) return {};
  const normalized: Record<string, number> = {};
  for (const [workflowId, quota] of Object.entries(raw)) {
    if (workflowId.trim().length === 0) continue;
    const parsed = normalizeNonNegativeInteger(quota);
    if (parsed === undefined) continue;
    normalized[workflowId.trim()] = parsed;
  }
  return normalized;
}

function normalizeQuotaPolicy(raw: unknown): AgentQuotaPolicyView {
  if (!isObjectRecord(raw)) {
    return { workflowQuota: {} };
  }
  const projectQuota = normalizeNonNegativeInteger(raw.projectQuota);
  const workflowQuota = normalizeWorkflowQuota(raw.workflowQuota);
  return {
    ...(projectQuota !== undefined ? { projectQuota } : {}),
    workflowQuota,
  };
}

function normalizeCapabilities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(
    raw
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )).sort((a, b) => a.localeCompare(b));
}

function isIgnorableRuntimeModule(moduleId: string): boolean {
  return moduleId.includes('mock')
    || moduleId.includes('debug-agent')
    || moduleId.includes('echo')
    || moduleId === 'chat-codex'
    || moduleId === 'chat-codex-gateway'
    || moduleId === 'finger-project-agent-gateway';
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
  if (provider === 'codex' && (moduleId.includes('chat-codex') || moduleId.includes('finger-'))) return true;
  return moduleId.includes('chat-codex') || moduleId.includes('finger-');
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
      'list_startup_templates',
    ],
    cli: [],
    stateSchema: {
      definitions: { type: 'number', readonly: true, description: 'logical agent definition count' },
      deployments: { type: 'number', readonly: true, description: 'active deployment count' },
    },
    events: ['agent_runtime_catalog', 'agent_runtime_dispatch', 'agent_runtime_control', 'agent_runtime_status'],
  };

  private readonly deployments = new Map<string, AgentDeploymentRecord>();
  private readonly activeDispatchCountByLane = new Map<string, number>();
  private readonly dispatchQueueByLane = new Map<string, QueuedDispatchItem[]>();
  private readonly dispatchLaneMetaByKey = new Map<string, DispatchLaneMeta>();
  private readonly workerProjectSessionByKey = new Map<string, string>();
  private readonly sessionOwnerKeyBySession = new Map<string, string>();
  private readonly runtimeConfigByAgent = new Map<string, AgentRuntimeConfigProfile>();
  private readonly lastEventByAgent = new Map<string, AgentLastEventView>();

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
      case 'list_startup_templates':
        return this.listStartupTemplates();
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

  private collectRunnerActiveSessionIds(): Set<string> {
    const active = new Set<string>();
    const states = this.deps.chatCodexRunner.listSessionStates();
    for (const item of states) {
      if (!isObjectRecord(item)) continue;
      if (item.hasActiveTurn !== true) continue;
      const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : '';
      if (sessionId.length === 0) continue;
      active.add(sessionId);
    }
    return active;
  }

  private createDefaultRuntimeConfigProfile(): AgentRuntimeConfigProfile {
    return {
      enabled: true,
      capabilities: [],
      defaultQuota: 0,
      hasExplicitDefaultQuota: false,
      quotaPolicy: { workflowQuota: {} },
    };
  }

  private readBaseRuntimeConfigProfile(agentId: string): AgentRuntimeConfigProfile {
    const loaded = this.readRuntimeProfileFromLoadedConfig(agentId);
    return loaded ?? this.createDefaultRuntimeConfigProfile();
  }

  private readRuntimeProfileFromLoadedConfig(agentId: string): AgentRuntimeConfigProfile | null {
    const loaded = this.deps.getLoadedAgentConfigs().find((item) => item.config.id === agentId);
    if (!loaded) return null;
    const runtime = isObjectRecord(loaded.config.runtime) ? loaded.config.runtime : {};
    const metadata = isObjectRecord(loaded.config.metadata) ? loaded.config.metadata : {};

    // Check for explicit defaultQuota before normalization
    const hasExplicitDefaultQuota =
      typeof runtime.defaultQuota === 'number' ||
      typeof runtime.default_quota === 'number' ||
      typeof loaded.config.defaultQuota === 'number';
    
    const defaultQuota = hasExplicitDefaultQuota ? normalizeNonNegativeInteger(
      runtime.defaultQuota
      ?? runtime.default_quota
      ?? loaded.config.defaultQuota,
    ) : undefined;
    const quotaPolicy = normalizeQuotaPolicy(
      runtime.quotaPolicy
      ?? runtime.quota_policy
      ?? loaded.config.quotaPolicy
      ?? {
        projectQuota: runtime.projectQuota ?? runtime.project_quota,
        workflowQuota: runtime.workflowQuota ?? runtime.workflow_quota,
      },
    );
    const enabled = typeof loaded.config.enabled === 'boolean'
      ? loaded.config.enabled
      : runtime.enabled !== false;
    const capabilities = normalizeCapabilities(runtime.capabilities ?? metadata.capabilities);

    return {
      enabled,
      capabilities,
      defaultQuota,
      hasExplicitDefaultQuota,
      quotaPolicy,
    };
  }

  private mergeRuntimeConfigProfiles(
    base: AgentRuntimeConfigProfile,
    override?: Partial<AgentRuntimeConfigProfile>,
  ): AgentRuntimeConfigProfile {
    if (!override) return base;
    const mergedCapabilities = override.capabilities
      ? normalizeCapabilities(override.capabilities)
      : base.capabilities;
    const mergedDefaultQuota = normalizeNonNegativeInteger(override.defaultQuota) ?? base.defaultQuota;
    const mergedQuotaPolicy = override.quotaPolicy
      ? {
          projectQuota: normalizeNonNegativeInteger(override.quotaPolicy.projectQuota)
            ?? base.quotaPolicy.projectQuota,
          workflowQuota: {
            ...base.quotaPolicy.workflowQuota,
            ...normalizeWorkflowQuota(override.quotaPolicy.workflowQuota),
          },
        }
      : base.quotaPolicy;

    return {
      enabled: typeof override.enabled === 'boolean' ? override.enabled : base.enabled,
      capabilities: mergedCapabilities,
      defaultQuota: mergedDefaultQuota,
      hasExplicitDefaultQuota: override.hasExplicitDefaultQuota ?? base.hasExplicitDefaultQuota,
      quotaPolicy: {
        ...(mergedQuotaPolicy.projectQuota !== undefined ? { projectQuota: mergedQuotaPolicy.projectQuota } : {}),
        workflowQuota: mergedQuotaPolicy.workflowQuota,
      },
    };
  }

  private resolveRuntimeConfigProfile(agentId: string): AgentRuntimeConfigProfile {
    const base = this.readBaseRuntimeConfigProfile(agentId);
    const override = this.runtimeConfigByAgent.get(agentId);
    if (!override) return base;
    const merged = this.mergeRuntimeConfigProfiles(base, override);
    return {
      ...merged,
      // Top-level agent.json enabled is the single source of truth.
      enabled: base.enabled,
    };
  }

  private patchRuntimeConfigProfile(agentId: string, patch: Partial<AgentRuntimeConfigProfile>): AgentRuntimeConfigProfile {
    const currentOverride = this.runtimeConfigByAgent.get(agentId);
    const mergedOverride = this.mergeRuntimeConfigProfiles(
      currentOverride ?? this.createDefaultRuntimeConfigProfile(),
      patch,
    );
    this.runtimeConfigByAgent.set(agentId, mergedOverride);
    return this.resolveRuntimeConfigProfile(agentId);
  }

  private undeployAgent(agentId: string): void {
    const deploymentIds = Array.from(this.deployments.values())
      .filter((item) => item.agentId === agentId)
      .map((item) => item.id);

    for (const deploymentId of deploymentIds) {
      this.deployments.delete(deploymentId);
    }

    const laneKeys = Array.from(this.dispatchLaneMetaByKey.entries())
      .filter(([, meta]) => meta.targetAgentId === agentId)
      .map(([laneKey]) => laneKey);
    for (const laneKey of laneKeys) {
      this.dispatchQueueByLane.delete(laneKey);
      this.activeDispatchCountByLane.delete(laneKey);
      this.dispatchLaneMetaByKey.delete(laneKey);
    }
    this.runtimeConfigByAgent.delete(agentId);

    if (!this.deps.resourcePool) return;

    const releasablePool = this.deps.resourcePool as typeof this.deps.resourcePool & {
      releaseResource?: (resourceId: string) => boolean;
      removeResource?: (resourceId: string) => boolean;
    };

    const resourceIds = this.deps.resourcePool
      .getAllResources()
      .filter((item) => item.id.startsWith(`${agentId}::`))
      .map((item) => item.id);

    for (const resourceId of resourceIds) {
      releasablePool.releaseResource?.(resourceId);
      releasablePool.removeResource?.(resourceId);
    }
  }

  private resolveAgentQuota(
    agentId: string,
    workflowId: string | undefined,
    deployment: AgentDeploymentRecord | undefined,
  ): AgentQuotaView {
    const profile = this.resolveRuntimeConfigProfile(agentId);
    const workflowQuota = profile.quotaPolicy.workflowQuota;
    if (workflowId && workflowQuota[workflowId] !== undefined) {
      return { effective: workflowQuota[workflowId], source: 'workflow', workflowId };
    }
    if (profile.quotaPolicy.projectQuota !== undefined) {
      return { effective: profile.quotaPolicy.projectQuota, source: 'project' };
    }
    if (profile.hasExplicitDefaultQuota && Number.isFinite(profile.defaultQuota)) {
      return { effective: Math.max(0, Math.floor(profile.defaultQuota ?? 0)), source: 'defaultQuota' };
    }
    const fallbackDeploymentQuota = deployment ? Math.max(0, Math.floor(deployment.instanceCount)) : 0;
    return { effective: fallbackDeploymentQuota, source: 'deployment' };
  }

  private rememberLastEvent(agentId: string | undefined, event: AgentLastEventView): void {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) return;
    this.lastEventByAgent.set(agentId.trim(), event);
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
    const availableModuleIds = new Set(modules.map((module) => module.id));

    const ensureDefinition = (id: string, patch: Partial<AgentDefinition>): AgentDefinition => {
      const normalizedId = id.trim();
      const existing = definitions.get(normalizedId);
      const next: AgentDefinition = {
        id: normalizedId,
        name: patch.name ?? existing?.name ?? normalizedId,
        role: patch.role ?? existing?.role ?? 'project',
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
        name: definitions.get(preferredId)?.name ?? moduleName,
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

    for (const template of BASE_STARTUP_TEMPLATES) {
      const existing = definitions.get(template.id);
      ensureDefinition(template.id, {
        name: existing?.name ?? template.name,
        role: existing?.role ?? template.role,
        source: existing?.source ?? 'runtime-config',
        tags: Array.from(new Set([...(existing?.tags ?? []), template.role, 'startup-template'])),
      });
      appendImplementation(template.id, {
        id: template.defaultImplementationId,
        kind: 'native',
        moduleId: template.defaultModuleId,
        status: availableModuleIds.has(template.defaultModuleId) ? 'available' : 'unavailable',
      });
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
    lanes: AgentDispatchLaneView[];
    configs: Array<{
      id: string;
      name: string;
      role?: string;
      filePath: string;
      tools?: Record<string, unknown>;
      enabled?: boolean;
      capabilities?: string[];
      defaultQuota?: number;
      quotaPolicy?: AgentQuotaPolicyView;
    }>;
    definitions: AgentDefinition[];
    startupTargets: AgentDefinition[];
    startupTemplates: AgentStartupTemplate[];
  } {
    const runningAgentIds = this.collectRunningAgentIds();
    const runnerActiveSessionIds = this.collectRunnerActiveSessionIds();
    const definitions = this.buildDefinitions();

    const workflowBySessionId = new Map<string, string>();
    const workflowStatusBySessionId = new Map<string, string>();
    for (const workflow of this.deps.workflowManager.listWorkflows()) {
      if (typeof workflow.sessionId === 'string' && workflow.sessionId.trim().length > 0) {
        workflowBySessionId.set(workflow.sessionId, workflow.id);
        if (typeof workflow.status === 'string' && workflow.status.trim().length > 0) {
          workflowStatusBySessionId.set(workflow.sessionId, workflow.status.trim());
        }
      }
    }

    const instances: AgentRuntimeViewInstance[] = [];
    const runnerActiveCountByAgent = new Map<string, number>();
    for (const deployment of this.deployments.values()) {
      const baseStatus = normalizeAgentStatus(deployment.status);
      const instanceTotal = Math.max(1, Number.isFinite(deployment.instanceCount) ? Math.floor(deployment.instanceCount) : 1);
      const runningCount = this.getActiveDispatchCount(deployment.agentId);
      const queuedCount = this.getQueuedDispatchCount(deployment.agentId);
      const lastEvent = this.lastEventByAgent.get(deployment.agentId);
      const sessionId = typeof deployment.sessionId === 'string' ? deployment.sessionId : '';
      const hasRunnerActiveTurn = sessionId.length > 0 && runnerActiveSessionIds.has(sessionId);
      const workflowStatus = sessionId.length > 0 ? workflowStatusBySessionId.get(sessionId) : undefined;
      const workflowActive = workflowStatus === 'planning' || workflowStatus === 'executing';
      const workflowPaused = workflowStatus === 'paused';
      if (hasRunnerActiveTurn) {
        runnerActiveCountByAgent.set(deployment.agentId, (runnerActiveCountByAgent.get(deployment.agentId) ?? 0) + 1);
      }
      for (let idx = 0; idx < instanceTotal; idx += 1) {
        const id = instanceTotal === 1 ? deployment.id : `${deployment.id}#${idx + 1}`;
        let status: AgentRuntimeStatus = (runningAgentIds.has(deployment.agentId) || (hasRunnerActiveTurn && idx === 0))
          ? 'running'
          : baseStatus;
        if (runningCount > 0 && idx < runningCount) {
          status = 'running';
        } else if (queuedCount > 0 && idx < queuedCount) {
          status = 'queued';
        } else if (lastEvent?.status === 'waiting_input') {
          status = 'waiting_input';
        } else if (lastEvent?.status === 'completed' || lastEvent?.status === 'passed' || lastEvent?.status === 'closed') {
          status = 'completed';
        } else if (lastEvent?.status === 'failed' || lastEvent?.status === 'error') {
          status = 'failed';
        } else if (lastEvent?.status === 'interrupted' || lastEvent?.status === 'cancel') {
          status = 'interrupted';
        }
        const isTerminalProblem = status === 'failed' || status === 'error' || status === 'interrupted';
        if (!isTerminalProblem) {
          if (workflowPaused) {
            status = 'paused';
          } else if (workflowActive) {
            status = 'running';
          }
        }
        const workflowId = workflowBySessionId.get(deployment.sessionId);
        instances.push({
          id,
          agentId: deployment.agentId,
          name: instanceTotal === 1
            ? (definitions.get(deployment.agentId)?.name ?? deployment.agentId)
            : `${definitions.get(deployment.agentId)?.name ?? deployment.agentId}#${idx + 1}`,
          type: definitions.get(deployment.agentId)?.role ?? 'project',
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
      const profile = this.resolveRuntimeConfigProfile(def.id);
      const queuedCount = this.getQueuedDispatchCount(def.id);
      const runningCount = Math.max(
        this.getActiveDispatchCount(def.id),
        related.filter((item) => item.status === 'running' || item.status === 'waiting_input').length,
        runnerActiveCountByAgent.get(def.id) ?? 0,
      );
      const deployedCount = related.filter((item) => (
        item.status === 'running'
        || item.status === 'waiting_input'
        || item.status === 'paused'
        || item.status === 'queued'
      )).length;
      const latestSession = related
        .slice()
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .find((item) => typeof item.sessionId === 'string' && item.sessionId.length > 0)
        ?.sessionId;
      const hasActiveWorkflowForAgent = related.some((item) => {
        if (typeof item.sessionId !== 'string' || item.sessionId.length === 0) return false;
        const status = workflowStatusBySessionId.get(item.sessionId);
        return status === 'planning' || status === 'executing';
      });
      const hasPausedWorkflowForAgent = related.some((item) => {
        if (typeof item.sessionId !== 'string' || item.sessionId.length === 0) return false;
        return workflowStatusBySessionId.get(item.sessionId) === 'paused';
      });
      const latestWorkflowId = related
        .slice()
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .find((item) => typeof item.workflowId === 'string' && item.workflowId.length > 0)
        ?.workflowId;
      const deployment = this.resolveDeploymentByAgentId(def.id) ?? undefined;
      const quota = this.resolveAgentQuota(def.id, latestWorkflowId, deployment);
      const lastEvent = this.lastEventByAgent.get(def.id);

      let status: AgentRuntimeStatus = 'idle';
      if (related.some((item) => item.status === 'error' || item.status === 'failed')) {
        status = 'error';
      } else if ((def.role === 'project' || def.role === 'system') && hasPausedWorkflowForAgent) {
        status = 'paused';
      } else if ((def.role === 'project' || def.role === 'system') && hasActiveWorkflowForAgent) {
        status = 'running';
      } else if (runningCount > 0 || runningAgentIds.has(def.id)) {
        status = 'running';
      } else if (queuedCount > 0) {
        status = 'queued';
      } else if (related.some((item) => item.status === 'paused')) {
        status = 'paused';
      } else if (lastEvent?.status === 'waiting_input') {
        status = 'waiting_input';
      } else if (lastEvent?.status === 'completed' || lastEvent?.status === 'passed' || lastEvent?.status === 'closed') {
        status = 'completed';
      } else if (lastEvent?.status === 'interrupted' || lastEvent?.status === 'cancel') {
        status = 'interrupted';
      }

      agents.push({
        id: def.id,
        name: def.name,
        type: def.role,
        status,
        source: def.source,
        instanceCount: related.length,
        deployedCount,
        availableCount: Math.max(0, related.length - Math.max(0, runningCount) - Math.max(0, queuedCount)),
        runningCount,
        queuedCount,
        enabled: profile.enabled,
        capabilities: profile.capabilities,
        defaultQuota: profile.defaultQuota,
        quotaPolicy: profile.quotaPolicy,
        quota,
        ...(lastEvent ? { lastEvent } : {}),
        ...(latestSession ? { lastSessionId: latestSession } : {}),
      });
    }

    const configs = this.deps.getLoadedAgentConfigs().map((item) => {
      const profile = this.resolveRuntimeConfigProfile(item.config.id);
      return {
        id: item.config.id,
        name: item.config.name ?? item.config.id,
        ...(item.config.role ? { role: item.config.role } : {}),
        filePath: item.filePath,
        ...(item.config.tools ? { tools: item.config.tools as Record<string, unknown> } : {}),
        enabled: profile.enabled,
        capabilities: profile.capabilities,
        defaultQuota: profile.defaultQuota,
        quotaPolicy: profile.quotaPolicy,
      };
    });

    const startupTargets = Array.from(definitions.values())
      .filter((def) => (byAgentId.get(def.id)?.length ?? 0) === 0)
      .sort((a, b) => a.name.localeCompare(b.name));
    const lanes = this.listDispatchLanes();

    return {
      agents: agents.sort((a, b) => a.name.localeCompare(b.name)),
      instances: instances.sort((a, b) => a.name.localeCompare(b.name)),
      lanes,
      configs,
      definitions: Array.from(definitions.values()).sort((a, b) => a.name.localeCompare(b.name)),
      startupTargets,
      startupTemplates: this.listStartupTemplates(),
    };
  }

  private listCatalog(layer: AgentCapabilityLayer): {
    ok: true;
    layer: AgentCapabilityLayer;
    count: number;
    agents: AgentCatalogEntry[];
    startupTargets: AgentDefinition[];
    startupTemplates: AgentStartupTemplate[];
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
      .filter((item) => item.status !== 'error' && item.status !== 'failed' && item.status !== 'interrupted')
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
        runningCount: agent.runningCount,
        queuedCount: agent.queuedCount,
        defaultQuota: agent.defaultQuota,
        quota: agent.quota,
        ...(agent.lastEvent ? { lastEvent: agent.lastEvent } : {}),
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
      startupTemplates: runtimeView.startupTemplates,
    };
  }

  private getAgentCapabilities(agentId: string, layer: AgentCapabilityLayer): { ok: boolean; layer: AgentCapabilityLayer; agent?: AgentCatalogEntry; error?: string } {
    const catalog = this.listCatalog(layer);
    const agent = catalog.agents.find((item) => item.id === agentId);
    if (!agent) return { ok: false, layer, error: `agent not found: ${agentId}` };
    return { ok: true, layer, agent };
  }

  private resolveDeploymentByAgentId(agentId: string): AgentDeploymentRecord | null {
    log.debug('[AgentRuntimeBlock] Resolving deployment', {
      agentId,
      deploymentsSize: this.deployments.size,
    });
    const candidates = Array.from(this.deployments.values()).filter((item) => item.agentId === agentId);
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return candidates[0];
  }

  private resolveDispatchCapacity(agentId: string): number {
    const deployment = this.resolveDeploymentByAgentId(agentId);
    if (!deployment) return 0;
    const count = Number.isFinite(deployment.instanceCount) ? Math.floor(deployment.instanceCount) : 1;
    return Math.max(1, count);
  }

  private getQueueForLane(laneKey: string): QueuedDispatchItem[] {
    return this.dispatchQueueByLane.get(laneKey) ?? [];
  }

  private getActiveDispatchCountForLane(laneKey: string): number {
    const current = this.activeDispatchCountByLane.get(laneKey);
    if (!Number.isFinite(current)) return 0;
    return Math.max(0, Math.floor(current as number));
  }

  private getActiveDispatchCount(agentId: string): number {
    let total = 0;
    for (const [laneKey, current] of this.activeDispatchCountByLane.entries()) {
      if (!Number.isFinite(current) || current <= 0) continue;
      const meta = this.dispatchLaneMetaByKey.get(laneKey);
      if (!meta || meta.targetAgentId !== agentId) continue;
      total += Math.max(0, Math.floor(current));
    }
    return total;
  }

  private getQueuedDispatchCount(agentId: string): number {
    let total = 0;
    for (const [laneKey, queue] of this.dispatchQueueByLane.entries()) {
      const meta = this.dispatchLaneMetaByKey.get(laneKey);
      if (!meta || meta.targetAgentId !== agentId) continue;
      total += queue.length;
    }
    return total;
  }

  private increaseActiveDispatch(lane: DispatchLaneMeta): void {
    this.dispatchLaneMetaByKey.set(lane.laneKey, lane);
    const next = this.getActiveDispatchCountForLane(lane.laneKey) + 1;
    this.activeDispatchCountByLane.set(lane.laneKey, next);
  }

  private decreaseActiveDispatch(laneKey: string): void {
    const next = this.getActiveDispatchCountForLane(laneKey) - 1;
    if (next <= 0) {
      this.activeDispatchCountByLane.delete(laneKey);
      this.cleanupLaneIfIdle(laneKey);
    } else {
      this.activeDispatchCountByLane.set(laneKey, next);
    }
  }

  private cleanupLaneIfIdle(laneKey: string): void {
    const active = this.getActiveDispatchCountForLane(laneKey);
    const queued = this.getQueueForLane(laneKey).length;
    if (active > 0 || queued > 0) return;
    this.dispatchLaneMetaByKey.delete(laneKey);
    this.dispatchQueueByLane.delete(laneKey);
  }

  private resolveDispatchLane(input: AgentDispatchRequest): DispatchLaneMeta {
    const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
    const taskRecord = isObjectRecord(input.task) ? input.task : {};
    const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
    const assignment = isObjectRecord(input.assignment) ? input.assignment : {};

    const projectId = firstNonEmptyString(
      typeof metadata.projectId === 'string' ? metadata.projectId : '',
      typeof taskRecord.projectId === 'string' ? taskRecord.projectId : '',
      typeof assignment.projectId === 'string' ? assignment.projectId : '',
      typeof taskMetadata.projectId === 'string' ? taskMetadata.projectId : '',
    )?.trim();
    const workerId = firstNonEmptyString(
      typeof metadata.workerId === 'string' ? metadata.workerId : '',
      typeof metadata.assigneeWorkerId === 'string' ? metadata.assigneeWorkerId : '',
      typeof taskRecord.workerId === 'string' ? taskRecord.workerId : '',
      typeof taskRecord.assigneeWorkerId === 'string' ? taskRecord.assigneeWorkerId : '',
      typeof assignment.assigneeAgentId === 'string' ? assignment.assigneeAgentId : '',
      typeof taskMetadata.workerId === 'string' ? taskMetadata.workerId : '',
      typeof taskMetadata.assigneeWorkerId === 'string' ? taskMetadata.assigneeWorkerId : '',
    )?.trim();
    const sessionId = firstNonEmptyString(
      typeof input.sessionId === 'string' ? input.sessionId : '',
      typeof taskRecord.sessionId === 'string' ? taskRecord.sessionId : '',
      typeof metadata.sessionId === 'string' ? metadata.sessionId : '',
      typeof taskMetadata.sessionId === 'string' ? taskMetadata.sessionId : '',
    )?.trim();

    const explicitLane = firstNonEmptyString(
      typeof metadata.laneKey === 'string' ? metadata.laneKey : '',
      typeof taskMetadata.laneKey === 'string' ? taskMetadata.laneKey : '',
    )?.trim();

    if (explicitLane) {
      return {
        laneKey: explicitLane,
        targetAgentId: input.targetAgentId,
        ...(projectId ? { projectId } : {}),
        ...(workerId ? { workerId } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
    }

    if (projectId || workerId) {
      const resolvedProjectId = projectId || 'project-unknown';
      const resolvedWorkerId = workerId || input.targetAgentId;
      const resolvedSessionId = sessionId || 'session-default';
      return {
        laneKey: `${resolvedProjectId}:${resolvedWorkerId}:${resolvedSessionId}`,
        targetAgentId: input.targetAgentId,
        projectId: resolvedProjectId,
        workerId: resolvedWorkerId,
        sessionId: resolvedSessionId,
      };
    }

    return {
      laneKey: `agent:${input.targetAgentId}`,
      targetAgentId: input.targetAgentId,
      ...(sessionId ? { sessionId } : {}),
    };
  }

  private validateAndRememberWorkerProjectSessionBinding(
    lane: DispatchLaneMeta,
  ): { ok: true } | { ok: false; error: string } {
    const projectId = typeof lane.projectId === 'string' ? lane.projectId.trim() : '';
    const workerId = typeof lane.workerId === 'string' ? lane.workerId.trim() : '';
    const sessionId = typeof lane.sessionId === 'string' ? lane.sessionId.trim() : '';
    if (!projectId || !workerId || !sessionId) return { ok: true };

    const bindingKey = `${projectId}::${workerId}`;
    const existingSession = this.workerProjectSessionByKey.get(bindingKey);
    if (existingSession && existingSession !== sessionId) {
      return {
        ok: false,
        error: `session_binding_mismatch: (${projectId}, ${workerId}) already bound to ${existingSession}, rejected ${sessionId}`,
      };
    }

    const existingOwnerKey = this.sessionOwnerKeyBySession.get(sessionId);
    if (existingOwnerKey && existingOwnerKey !== bindingKey) {
      return {
        ok: false,
        error: `session_binding_scope_violation: session ${sessionId} already owned by ${existingOwnerKey}, rejected ${bindingKey}`,
      };
    }

    this.workerProjectSessionByKey.set(bindingKey, sessionId);
    this.sessionOwnerKeyBySession.set(sessionId, bindingKey);
    return { ok: true };
  }

  private listDispatchLanes(): AgentDispatchLaneView[] {
    const laneKeys = new Set<string>([
      ...this.dispatchLaneMetaByKey.keys(),
      ...this.activeDispatchCountByLane.keys(),
      ...this.dispatchQueueByLane.keys(),
    ]);
    const lanes: AgentDispatchLaneView[] = [];
    for (const laneKey of laneKeys) {
      const meta = this.dispatchLaneMetaByKey.get(laneKey);
      if (!meta) continue;
      const runningCount = this.getActiveDispatchCountForLane(laneKey);
      const queuedCount = this.getQueueForLane(laneKey).length;
      const capacity = this.resolveDispatchCapacity(meta.targetAgentId);
      lanes.push({
        laneKey,
        agentId: meta.targetAgentId,
        runningCount,
        queuedCount,
        capacity,
        ...(meta.projectId ? { projectId: meta.projectId } : {}),
        ...(meta.workerId ? { workerId: meta.workerId } : {}),
        ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
      });
    }
    lanes.sort((a, b) => a.laneKey.localeCompare(b.laneKey));
    return lanes;
  }

  private normalizeAssignment(input: AgentDispatchRequest): AgentAssignmentLifecycle | undefined {
    const assignment = isObjectRecord(input.assignment) ? input.assignment : {};
    const taskRecord = isObjectRecord(input.task) ? input.task : {};
    const taskIdFromTask = typeof taskRecord.taskId === 'string' ? taskRecord.taskId.trim() : '';
    const taskIdFromTaskLower = typeof taskRecord.task_id === 'string' ? taskRecord.task_id.trim() : '';
    const taskId = typeof assignment.taskId === 'string' && assignment.taskId.trim().length > 0
      ? assignment.taskId.trim()
      : taskIdFromTask
        || taskIdFromTaskLower
        || undefined;
    const epicId = typeof assignment.epicId === 'string' && assignment.epicId.trim().length > 0
      ? assignment.epicId.trim()
      : typeof input.workflowId === 'string' && input.workflowId.trim().length > 0
        ? input.workflowId.trim()
        : undefined;
    const bdTaskId = typeof assignment.bdTaskId === 'string' && assignment.bdTaskId.trim().length > 0
      ? assignment.bdTaskId.trim()
      : undefined;
    const assignerAgentId = typeof assignment.assignerAgentId === 'string' && assignment.assignerAgentId.trim().length > 0
      ? assignment.assignerAgentId.trim()
      : input.sourceAgentId;
    const assigneeAgentId = typeof assignment.assigneeAgentId === 'string' && assignment.assigneeAgentId.trim().length > 0
      ? assignment.assigneeAgentId.trim()
      : input.targetAgentId;
    const phase = typeof assignment.phase === 'string' && assignment.phase.trim().length > 0
      ? assignment.phase as AgentAssignmentLifecycle['phase']
      : 'assigned';
    const attemptRaw = typeof assignment.attempt === 'number' && Number.isFinite(assignment.attempt)
      ? assignment.attempt
      : 1;
    const attempt = Math.max(1, Math.floor(attemptRaw));

    return {
      ...(epicId ? { epicId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(bdTaskId ? { bdTaskId } : {}),
      assignerAgentId,
      assigneeAgentId,
      phase,
      attempt,
    };
  }

  private withAssignmentPhase(
    assignment: AgentAssignmentLifecycle | undefined,
    phase: NonNullable<AgentAssignmentLifecycle['phase']>,
  ): AgentAssignmentLifecycle | undefined {
    if (!assignment) return undefined;
    return {
      ...assignment,
      phase,
    };
  }

  private toDispatchPayload(input: AgentDispatchRequest, dispatchId: string): Record<string, unknown> {
    const assignment = this.normalizeAssignment(input);
    const targetRole = this.buildDefinitions().get(input.targetAgentId)?.role ?? normalizeAgentType(input.targetAgentId);
    
    // Check if this is a system role dispatch (should skip dispatch contract)
    const isSystemRole = input.metadata?.role === 'system';
    
    const metadata = {
      ...(isObjectRecord(input.metadata) ? input.metadata : {}),
      dispatchId,
      sourceAgentId: input.sourceAgentId,
      targetAgentId: input.targetAgentId,
      responsesStructuredOutput: !isSystemRole,
      responsesOutputSchemaPreset: isSystemRole ? 'none' : (targetRole === 'reviewer' ? 'reviewer' : 'orchestrator'),
      ...(assignment ? { assignment } : {}),
      orchestration: true,
    };

    // For system role, use the prompt directly without dispatch contract
    const dispatchText = isSystemRole
      ? extractTaskText(input.task)
      : buildDispatchTaskText(input.task, targetRole);

    if (isObjectRecord(input.task)) {
      const next: Record<string, unknown> = { ...input.task };
      next.text = dispatchText;
      if (typeof next.sessionId !== 'string' && typeof input.sessionId === 'string' && input.sessionId.trim().length > 0) {
        next.sessionId = input.sessionId;
      }
      const originalMetadata = isObjectRecord(next.metadata) ? next.metadata : {};
      next.metadata = { ...originalMetadata, ...metadata };
      return next;
    }

    return {
      text: dispatchText,
      ...(typeof input.sessionId === 'string' && input.sessionId.trim().length > 0 ? { sessionId: input.sessionId } : {}),
      metadata,
    };
  }

  private summarizeDispatchResult(result: unknown): DispatchSummaryResult {
    return sanitizeDispatchResult(result);
  }

  private emitDispatchEvent(params: {
    dispatchId: string;
    laneKey?: string;
    sourceAgentId: string;
    targetAgentId: string;
    status: 'queued' | 'completed' | 'failed';
    blocking: boolean;
    sessionId?: string;
    workflowId?: string;
    queuePosition?: number;
    assignment?: AgentAssignmentLifecycle;
    result?: unknown;
    error?: string;
  }): void {
    const timestamp = new Date().toISOString();
    const resolvedSessionId = typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
      ? params.sessionId.trim()
      : undefined;
    const resolvedRootSessionId = (() => {
      if (!resolvedSessionId) return undefined;
      const getSession = (this.deps.sessionManager as unknown as { getSession?: (sessionId: string) => unknown }).getSession;
      if (typeof getSession !== 'function') return undefined;
      const session = getSession.call(this.deps.sessionManager, resolvedSessionId) as { context?: unknown } | null;
      if (!session || typeof session.context !== 'object' || session.context === null) return undefined;
      const context = session.context as Record<string, unknown>;
      const rootSessionId = typeof context.rootSessionId === 'string'
        ? context.rootSessionId.trim()
        : '';
      if (rootSessionId.length > 0) return rootSessionId;
      const parentSessionId = typeof context.parentSessionId === 'string'
        ? context.parentSessionId.trim()
        : '';
      return parentSessionId.length > 0 ? parentSessionId : undefined;
    })();
    const queueSuffix = typeof params.queuePosition === 'number' ? ` (queue #${params.queuePosition})` : '';
    const summary = params.status === 'failed'
      ? `Dispatch failed${params.error ? `: ${params.error}` : ''}`
      : params.status === 'completed'
        ? 'Dispatch completed'
        : `Dispatch queued${queueSuffix}`;
    this.rememberLastEvent(params.targetAgentId, {
      type: 'dispatch',
      status: params.status,
      summary,
      timestamp,
      ...(params.laneKey ? { laneKey: params.laneKey } : {}),
      sourceAgentId: params.sourceAgentId,
      ...(typeof params.assignment?.taskId === 'string' && params.assignment.taskId.trim().length > 0
        ? { taskId: params.assignment.taskId.trim() }
        : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.workflowId ? { workflowId: params.workflowId } : {}),
      dispatchId: params.dispatchId,
    });
    void this.deps.eventBus.emit({
      type: 'agent_runtime_dispatch',
      sessionId: resolvedSessionId ?? this.deps.sessionManager.getCurrentSession()?.id ?? 'default',
      agentId: params.targetAgentId,
      timestamp,
      payload: {
        dispatchId: params.dispatchId,
        ...(params.laneKey ? { laneKey: params.laneKey } : {}),
        sourceAgentId: params.sourceAgentId,
        targetAgentId: params.targetAgentId,
        status: params.status,
        blocking: params.blocking,
        ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
        ...(resolvedRootSessionId && resolvedRootSessionId !== resolvedSessionId
          ? { rootSessionId: resolvedRootSessionId }
          : {}),
        ...(params.workflowId ? { workflowId: params.workflowId } : {}),
        ...(typeof params.queuePosition === 'number' ? { queuePosition: params.queuePosition } : {}),
        ...(params.assignment ? { assignment: params.assignment } : {}),
        ...(params.result !== undefined ? { result: params.result } : {}),
        ...(params.error ? { error: params.error } : {}),
      },
    });
  }

  private emitControlEvent(result: AgentControlResult): void {
    const timestamp = new Date().toISOString();
    const normalizedStatus = (result.action === 'interrupt' || result.action === 'cancel') && result.ok
      ? 'interrupted'
      : result.status;
    const summary = result.ok
      ? `Control ${result.action} ${result.status}`
      : `Control ${result.action} failed${result.error ? `: ${result.error}` : ''}`;
    this.rememberLastEvent(result.targetAgentId, {
      type: 'control',
      status: normalizedStatus,
      summary,
      timestamp,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.workflowId ? { workflowId: result.workflowId } : {}),
    });
    void this.deps.eventBus.emit({
      type: 'agent_runtime_control',
      sessionId: result.sessionId ?? this.deps.sessionManager.getCurrentSession()?.id ?? 'default',
      agentId: result.targetAgentId,
      timestamp,
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
    const timestamp = new Date().toISOString();
    const runningAgents = Array.from(this.collectRunningAgentIds()).sort((a, b) => a.localeCompare(b));
    for (const agentId of runningAgents) {
      this.rememberLastEvent(agentId, {
        type: 'status',
        status: params.status,
        summary: params.status === 'ok' ? 'Runtime status ok' : `Runtime status error${params.error ? `: ${params.error}` : ''}`,
        timestamp,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.workflowId ? { workflowId: params.workflowId } : {}),
      });
    }
    void this.deps.eventBus.emit({
      type: 'agent_runtime_status',
      sessionId: params.sessionId ?? this.deps.sessionManager.getCurrentSession()?.id ?? 'default',
      timestamp,
      payload: {
        scope: params.workflowId ? 'workflow' : params.sessionId ? 'session' : 'global',
        status: params.status,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        ...(params.workflowId ? { workflowId: params.workflowId } : {}),
        runningAgents,
        ...(params.error ? { error: params.error } : {}),
      },
    });
  }

  private removeQueuedDispatch(laneKey: string, dispatchId: string): QueuedDispatchItem | null {
    const queue = this.dispatchQueueByLane.get(laneKey);
    if (!queue || queue.length === 0) return null;
    const idx = queue.findIndex((item) => item.dispatchId === dispatchId);
    if (idx < 0) return null;
    const [removed] = queue.splice(idx, 1);
    if (queue.length === 0) {
      this.dispatchQueueByLane.delete(laneKey);
      this.cleanupLaneIfIdle(laneKey);
    } else {
      this.dispatchQueueByLane.set(laneKey, queue);
    }
    return removed;
  }

  private enqueueDispatch(lane: DispatchLaneMeta, item: QueuedDispatchItem): number {
    this.dispatchLaneMetaByKey.set(lane.laneKey, lane);
    const queue = this.dispatchQueueByLane.get(lane.laneKey) ?? [];
    queue.push(item);
    this.dispatchQueueByLane.set(lane.laneKey, queue);
    return queue.length;
  }

  private async executeDispatch(
    input: AgentDispatchRequest,
    dispatchId: string,
    targetModuleId: string,
    lane: DispatchLaneMeta,
    assignment?: AgentAssignmentLifecycle,
  ): Promise<DispatchResult> {
    const blocking = input.blocking === true;
    const payload = this.toDispatchPayload({
      ...input,
      ...(assignment ? { assignment } : {}),
    }, dispatchId);
    this.increaseActiveDispatch(lane);

    log.info('[AgentRuntimeBlock] Execute dispatch start', {
      dispatchId,
      targetModuleId,
      targetAgentId: input.targetAgentId,
      blocking,
      sessionId: input.sessionId,
    });

    if (!blocking) {
      log.info('[AgentRuntimeBlock] Sending to module (non-blocking)', { dispatchId, targetModuleId });
      void this.deps.hub.sendToModule(targetModuleId, payload)
        .then((result) => {
          const summarized = this.summarizeDispatchResult(result);
          const completion = resolveDispatchCompletionStatus(summarized);
          log.info('[AgentRuntimeBlock] Module result (non-blocking)', {
            dispatchId,
            targetModuleId,
            status: completion.status,
            ...(completion.error ? { error: completion.error } : {}),
          });
          this.emitDispatchEvent({
            dispatchId,
            laneKey: lane.laneKey,
            sourceAgentId: input.sourceAgentId,
            targetAgentId: input.targetAgentId,
            status: completion.status,
            blocking,
            sessionId: input.sessionId,
            workflowId: input.workflowId,
            assignment: resolveTerminalAssignmentPhase(assignment, completion.ok, result),
            result: summarized,
            ...(completion.error ? { error: completion.error } : {}),
          });
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          log.error('[AgentRuntimeBlock] Module error (non-blocking)', undefined, { dispatchId, targetModuleId, error: message });
          this.emitDispatchEvent({
            dispatchId,
            laneKey: lane.laneKey,
            sourceAgentId: input.sourceAgentId,
            targetAgentId: input.targetAgentId,
            status: 'failed',
            blocking,
            sessionId: input.sessionId,
            workflowId: input.workflowId,
            assignment: this.withAssignmentPhase(assignment, 'failed'),
            error: message,
          });
        })
        .finally(() => {
          this.decreaseActiveDispatch(lane.laneKey);
          this.drainDispatchQueue(lane);
        });
      return { ok: true, dispatchId, status: 'queued', targetModuleId };
    }

    try {
      log.info('[AgentRuntimeBlock] Sending to module (blocking)', { dispatchId, targetModuleId });
      const result = await this.deps.hub.sendToModule(targetModuleId, payload);
      const summarized = this.summarizeDispatchResult(result);
      const completion = resolveDispatchCompletionStatus(summarized);
      log.info('[AgentRuntimeBlock] Module result (blocking)', {
        dispatchId,
        targetModuleId,
        status: completion.status,
        ...(completion.error ? { error: completion.error } : {}),
      });
      this.emitDispatchEvent({
        dispatchId,
        laneKey: lane.laneKey,
        sourceAgentId: input.sourceAgentId,
        targetAgentId: input.targetAgentId,
        status: completion.status,
        blocking,
        sessionId: input.sessionId,
        workflowId: input.workflowId,
        assignment: resolveTerminalAssignmentPhase(assignment, completion.ok, result),
        result: summarized,
        ...(completion.error ? { error: completion.error } : {}),
      });
      return {
        ok: completion.ok,
        dispatchId,
        status: completion.status,
        result: summarized,
        ...(completion.error ? { error: completion.error } : {}),
        targetModuleId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('[AgentRuntimeBlock] Module error (blocking)', undefined, { dispatchId, targetModuleId, error: message });
      this.emitDispatchEvent({
        dispatchId,
        laneKey: lane.laneKey,
        sourceAgentId: input.sourceAgentId,
        targetAgentId: input.targetAgentId,
        status: 'failed',
        blocking,
        sessionId: input.sessionId,
        workflowId: input.workflowId,
        assignment: this.withAssignmentPhase(assignment, 'failed'),
        error: message,
      });
      return { ok: false, dispatchId, status: 'failed', error: message, targetModuleId };
    } finally {
      this.decreaseActiveDispatch(lane.laneKey);
      this.drainDispatchQueue(lane);
    }
  }

  private drainDispatchQueue(lane: DispatchLaneMeta): void {
    const queue = this.dispatchQueueByLane.get(lane.laneKey);
    if (!queue || queue.length === 0) return;
    const capacity = this.resolveDispatchCapacity(lane.targetAgentId);
    if (capacity <= 0) return;

    while (this.getActiveDispatchCountForLane(lane.laneKey) < capacity) {
      const next = queue.shift();
      if (!next) break;
      if (next.timeoutHandle) {
        clearTimeout(next.timeoutHandle);
        next.timeoutHandle = undefined;
      }
      if (queue.length === 0) {
        this.dispatchQueueByLane.delete(lane.laneKey);
        this.cleanupLaneIfIdle(lane.laneKey);
      } else {
        this.dispatchQueueByLane.set(lane.laneKey, queue);
      }

      this.emitDispatchEvent({
        dispatchId: next.dispatchId,
        laneKey: lane.laneKey,
        sourceAgentId: next.input.sourceAgentId,
        targetAgentId: next.input.targetAgentId,
        status: 'queued',
        blocking: next.input.blocking === true,
        sessionId: next.input.sessionId,
        workflowId: next.input.workflowId,
        assignment: this.withAssignmentPhase(next.assignment, 'started'),
      });

      void this.executeDispatch(
        next.input,
        next.dispatchId,
        next.targetModuleId,
        lane,
        this.withAssignmentPhase(next.assignment, 'started'),
      ).then((result) => {
        next.resolve(result);
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        next.resolve({
          ok: false,
          dispatchId: next.dispatchId,
          status: 'failed',
          targetModuleId: next.targetModuleId,
          error: message,
        });
      });
    }
  }

  private isSystemDirectInjectDispatch(input: AgentDispatchRequest): boolean {
    const policy = resolveSystemDispatchPolicy();
    const sourceAgentId = (input.sourceAgentId || '').trim().toLowerCase();
    if (policy.directInjectSourceAgentIds.has(sourceAgentId)) {
      return true;
    }

    const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
    for (const [rawKey, rawValue] of Object.entries(metadata)) {
      if (rawValue !== true) continue;
      const normalizedKey = rawKey.trim().toLowerCase();
      if (policy.directInjectMetadataFlags.has(normalizedKey)) {
        return true;
      }
    }

    const metadataSourceRaw = metadata.source;
    if (typeof metadataSourceRaw === 'string') {
      const metadataSource = metadataSourceRaw.trim().toLowerCase();
      if (policy.directInjectMetadataSources.has(metadataSource)) return true;
    }

    const deliveryModeRaw = metadata.deliveryMode;
    if (typeof deliveryModeRaw === 'string') {
      const deliveryMode = deliveryModeRaw.trim().toLowerCase();
      if (policy.directInjectDeliveryModes.has(deliveryMode)) return true;
    }

    return false;
  }

  private shouldRouteSystemDispatchToMailbox(input: AgentDispatchRequest): boolean {
    const targetAgentId = (input.targetAgentId || '').trim();
    if (targetAgentId !== SYSTEM_AGENT_ID) return false;
    const sourceAgentId = (input.sourceAgentId || '').trim();
    // Self-dispatch should follow the same in-flight queue merge semantics as normal user input
    // (chat-codex pending_input_queued), not mailbox fallback.
    if (sourceAgentId === targetAgentId) return false;
    const policy = resolveSystemDispatchPolicy();
    if (!policy.routeSystemDispatchToMailboxByDefault) return false;
    return !this.isSystemDirectInjectDispatch(input);
  }

  private buildMailboxFallbackDispatchResult(params: {
    dispatchId: string;
    input: AgentDispatchRequest;
    targetAgentId: string;
    targetModuleId: string;
    assignment: AgentAssignmentLifecycle | undefined;
    blocking: boolean;
  }): DispatchResult | null {
    const fallback = this.deps.onDispatchQueueTimeout?.({
      dispatchId: params.dispatchId,
      sourceAgentId: params.input.sourceAgentId,
      targetAgentId: params.targetAgentId,
      sessionId: params.input.sessionId,
      workflowId: params.input.workflowId,
      assignment: params.assignment,
      task: params.input.task,
      metadata: params.input.metadata,
    });
    if (!fallback) return null;

    const fallbackResult: DispatchSummaryResult = {
      success: true,
      status: 'queued_mailbox',
      summary: fallback.summary ?? `Target agent busy; task moved to mailbox for ${params.targetAgentId}`,
      messageId: fallback.mailboxMessageId,
      delivery: fallback.delivery,
      recoveryAction: 'mailbox',
      timeoutMs: typeof fallback.timeoutMs === 'number'
        ? Math.max(0, Math.floor(fallback.timeoutMs))
        : params.input.maxQueueWaitMs,
      ...(fallback.nextAction ? { nextAction: fallback.nextAction } : {}),
    };
    this.emitDispatchEvent({
      dispatchId: params.dispatchId,
      sourceAgentId: params.input.sourceAgentId,
      targetAgentId: params.targetAgentId,
      status: 'queued',
      blocking: params.blocking,
      sessionId: params.input.sessionId,
      workflowId: params.input.workflowId,
      assignment: this.withAssignmentPhase(params.assignment, 'queued'),
      result: fallbackResult,
    });
    return {
      ok: true,
      dispatchId: params.dispatchId,
      status: 'queued',
      targetModuleId: params.targetModuleId,
      result: fallbackResult,
    };
  }

  private async dispatchTask(input: AgentDispatchRequest): Promise<DispatchResult> {
    log.info('[AgentRuntimeBlock] Dispatching task', {
      sourceAgentId: input.sourceAgentId,
      targetAgentId: input.targetAgentId,
      sessionId: input.sessionId,
      taskType: typeof input.task
    });

    const targetAgentId = input.targetAgentId;
    if (!targetAgentId || typeof targetAgentId !== 'string') {
      log.info(`[AgentRuntimeBlock] Dispatch failed: invalid targetAgentId=${JSON.stringify(input)}`);
      return {
        ok: false,
        dispatchId: `dispatch-${Date.now()}-invalid-target`,
        status: 'failed',
        error: 'targetAgentId is required',
      };
    }
    const target = targetAgentId.trim();
    if (!target) {
      return {
        ok: false,
        dispatchId: `dispatch-${Date.now()}-invalid`,
        status: 'failed',
        error: 'targetAgentId is required',
      };
    }
    const source = typeof input.sourceAgentId === 'string' ? input.sourceAgentId.trim() : '';
    if (source.length > 0 && source === target) {
      const dispatchId = `dispatch-${Date.now()}-self-forbidden`;
      log.warn('[AgentRuntimeBlock] Self-dispatch forbidden', {
        sourceAgentId: source,
        targetAgentId: target,
        sessionId: input.sessionId,
      });
      return {
        ok: false,
        dispatchId,
        status: 'failed',
        error: `self-dispatch forbidden: source and target are both ${target}`,
      };
    }

    log.debug('[AgentRuntimeBlock] Checking deployment', {
      targetAgentId: target,
    });
    const deployment = this.resolveDeploymentByAgentId(target);
    if (!deployment) {
      log.warn('[AgentRuntimeBlock] Deployment not found', {
        targetAgentId: target,
      });
      return {
        ok: false,
        dispatchId: `dispatch-${Date.now()}-not-started`,
        status: 'failed',
        error: `target agent is not started in resource pool: ${target}`,
      };
    }

    const runtimeProfile = this.resolveRuntimeConfigProfile(target);
    if (runtimeProfile.enabled === false) {
      return {
        ok: false,
        dispatchId: `dispatch-${Date.now()}-disabled`,
        status: 'failed',
        error: `target agent is disabled by orchestration config: ${target}`,
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

    const normalizedInput: AgentDispatchRequest = {
      ...input,
      sourceAgentId: input.sourceAgentId.trim(),
      targetAgentId: target,
      queueOnBusy: input.queueOnBusy !== false,
      ...(Number.isFinite(input.maxQueueWaitMs)
        ? (() => {
            const parsed = Math.floor(input.maxQueueWaitMs as number);
            if (parsed <= 0) {
              // <= 0 means "disable queue timeout" for this dispatch.
              return { maxQueueWaitMs: 0 };
            }
            return { maxQueueWaitMs: Math.max(1_000, parsed) };
          })()
        : { maxQueueWaitMs: 300_000 }),
    };
    const blocking = input.blocking === true;
    const dispatchId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const assignment = this.normalizeAssignment(normalizedInput);
    const lane = this.resolveDispatchLane(normalizedInput);
    const sessionBindingCheck = this.validateAndRememberWorkerProjectSessionBinding(lane);
    if (!sessionBindingCheck.ok) {
      log.warn('[AgentRuntimeBlock] Rejected dispatch by worker-project session binding rule', {
        dispatchId,
        laneKey: lane.laneKey,
        targetAgentId: target,
        error: sessionBindingCheck.error,
      });
      return {
        ok: false,
        dispatchId,
        status: 'failed',
        targetModuleId,
        error: sessionBindingCheck.error,
      };
    }
    const activeCount = this.getActiveDispatchCountForLane(lane.laneKey);
    const capacity = this.resolveDispatchCapacity(target);

    if (this.shouldRouteSystemDispatchToMailbox(normalizedInput)) {
      const mailboxFallback = this.buildMailboxFallbackDispatchResult({
        dispatchId,
        input: normalizedInput,
        targetAgentId: target,
        targetModuleId,
        assignment,
        blocking,
      });
      if (mailboxFallback) {
        log.info('[AgentRuntimeBlock] Routed system dispatch to mailbox by source policy', {
          dispatchId,
          laneKey: lane.laneKey,
          sourceAgentId: normalizedInput.sourceAgentId,
          targetAgentId: target,
        });
        return mailboxFallback;
      }
    }

    if (blocking && normalizedInput.sourceAgentId === target && activeCount >= capacity) {
      return {
        ok: false,
        dispatchId,
        status: 'failed',
        targetModuleId,
        error: `dispatch deadlock risk: source=${target} target=${target} capacity=${capacity}`,
      };
    }

    if (activeCount >= capacity) {
      if (normalizedInput.queueOnBusy === false) {
        return {
          ok: false,
          dispatchId,
          status: 'failed',
          targetModuleId,
          error: `target agent busy: ${target}`,
        };
      }

      const pendingResult = new Promise<DispatchResult>((resolve) => {
        const queued: QueuedDispatchItem = {
          dispatchId,
          laneKey: lane.laneKey,
          input: normalizedInput,
          targetModuleId,
          assignment,
          resolve,
        };
        const isSelfDispatch = normalizedInput.sourceAgentId === target;
        // Self-dispatch should always wait for next runnable slot (same semantic as
        // in-flight pending user input merge), never timeout into mailbox.
        if (!isSelfDispatch && (normalizedInput.maxQueueWaitMs ?? 0) > 0) {
          queued.timeoutHandle = setTimeout(() => {
            const removed = this.removeQueuedDispatch(lane.laneKey, dispatchId);
            if (!removed) return;
            const fallbackResult = this.buildMailboxFallbackDispatchResult({
              dispatchId,
              input: normalizedInput,
              targetAgentId: target,
              targetModuleId,
              assignment,
              blocking,
            });
            if (fallbackResult) {
              resolve(fallbackResult);
              return;
            }
            this.emitDispatchEvent({
              dispatchId,
              laneKey: lane.laneKey,
              sourceAgentId: normalizedInput.sourceAgentId,
              targetAgentId: target,
              status: 'failed',
              blocking,
              sessionId: normalizedInput.sessionId,
              workflowId: normalizedInput.workflowId,
              assignment: this.withAssignmentPhase(assignment, 'failed'),
              error: 'dispatch queue timeout',
            });
            resolve({
              ok: false,
              dispatchId,
              status: 'failed',
              targetModuleId,
              error: 'dispatch queue timeout',
            });
          }, normalizedInput.maxQueueWaitMs);
        }
        this.enqueueDispatch(lane, queued);
      });

      const queuePosition = this.getQueueForLane(lane.laneKey).length || 1;
      this.emitDispatchEvent({
        dispatchId,
        laneKey: lane.laneKey,
        sourceAgentId: normalizedInput.sourceAgentId,
        targetAgentId: target,
        status: 'queued',
        blocking,
        sessionId: normalizedInput.sessionId,
        workflowId: normalizedInput.workflowId,
        queuePosition,
        assignment: this.withAssignmentPhase(assignment, 'queued'),
      });

      if (blocking) {
        return pendingResult;
      }

      return {
        ok: true,
        dispatchId,
        status: 'queued',
        targetModuleId,
        queuePosition,
      };
    }

    this.emitDispatchEvent({
      dispatchId,
      laneKey: lane.laneKey,
      sourceAgentId: normalizedInput.sourceAgentId,
      targetAgentId: target,
      status: 'queued',
      blocking,
      sessionId: normalizedInput.sessionId,
      workflowId: normalizedInput.workflowId,
      assignment: this.withAssignmentPhase(assignment, 'started'),
    });
    return this.executeDispatch(
      normalizedInput,
      dispatchId,
      targetModuleId,
      lane,
      this.withAssignmentPhase(assignment, 'started'),
    );
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
        type: type === 'reviewer' ? 'reviewer' : 'orchestrator',
        capabilities,
        status: 'available',
      });
    }
  }

  private deployAgent(request: AgentDeployRequest): {
    success: boolean;
    deployment?: AgentDeploymentRecord;
    startupTargets: AgentDefinition[];
    startupTemplates: AgentStartupTemplate[];
    error?: string;
  } {
    const definitions = this.buildDefinitions();
    const definition = this.resolveDefinitionForDeploy(request, definitions);
    if (!definition) {
      return {
        success: false,
        startupTargets: this.listStartupTargets(),
        startupTemplates: this.listStartupTemplates(),
        error: 'target agent is required',
      };
    }

    const impl = this.resolveDeploymentImplementation(definition, request);
    const deploymentId = `deployment-${definition.id}-${impl.id.replace(/[^a-zA-Z0-9-_]/g, '_')}`;
    const previous = this.deployments.get(deploymentId);

    if (request.config?.enabled === false) {
      this.undeployAgent(definition.id);
      this.emitStatusEvent({
        sessionId: typeof request.sessionId === 'string' && request.sessionId.trim().length > 0
          ? request.sessionId.trim()
          : this.deps.sessionManager.getCurrentSession()?.id ?? 'default',
        status: 'ok',
      });
      return {
        success: true,
        startupTargets: this.listStartupTargets(),
        startupTemplates: this.listStartupTemplates(),
      };
    }

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

    const runtimeDefaultQuotaPatch = normalizeNonNegativeInteger(request.config?.defaultQuota);
    const hasRuntimeDefaultQuotaPatch = runtimeDefaultQuotaPatch !== undefined;
    const hasRuntimeCapabilitiesPatch = Array.isArray(request.config?.capabilities);
    const hasRuntimeQuotaPolicyPatch = request.config?.quotaPolicy !== undefined;
    const runtimeProfile = (hasRuntimeDefaultQuotaPatch || hasRuntimeCapabilitiesPatch || hasRuntimeQuotaPolicyPatch)
      ? this.patchRuntimeConfigProfile(definition.id, {
          ...(hasRuntimeDefaultQuotaPatch ? { defaultQuota: runtimeDefaultQuotaPatch } : {}),
          ...(hasRuntimeCapabilitiesPatch ? { capabilities: normalizeCapabilities(request.config?.capabilities) } : {}),
          ...(hasRuntimeQuotaPolicyPatch ? { quotaPolicy: normalizeQuotaPolicy(request.config?.quotaPolicy) } : {}),
        })
      : this.resolveRuntimeConfigProfile(definition.id);

    if (
      request.config?.provider === 'iflow'
      || request.config?.provider === 'openai'
      || request.config?.provider === 'anthropic'
      || hasRuntimeDefaultQuotaPatch
      || hasRuntimeCapabilitiesPatch
      || hasRuntimeQuotaPolicyPatch
    ) {
      this.deps.runtime.setAgentRuntimeConfig(definition.id, {
        id: definition.id,
        name: request.config?.name ?? definition.name,
        role: request.config?.role ?? definition.role,
        ...(request.config?.provider
          ? {
              provider: {
                type: request.config.provider,
                ...(request.config.model ? { model: request.config.model } : {}),
              },
            }
          : {}),
        runtime: {
          enabled: runtimeProfile.enabled,
          capabilities: runtimeProfile.capabilities,
          defaultQuota: runtimeProfile.defaultQuota,
          quotaPolicy: runtimeProfile.quotaPolicy,
        },
      });
    }

    this.deployments.set(deploymentId, deployment);

    log.info('[AgentRuntimeBlock] Deployment stored in map', {
      deploymentId,
      agentId: deployment.agentId,
      sessionId: deployment.sessionId,
      status: deployment.status,
    });
    this.syncResourcePool(deployment, definition);

    log.info('[AgentRuntimeBlock] Deployment synced to resource pool', {
      deploymentId,
      agentId: deployment.agentId,
      implementationId: deployment.implementationId,
    });

    this.emitStatusEvent({
      sessionId: deployment.sessionId,
      status: 'ok',
    });

    return {
      success: true,
      deployment,
      startupTargets: this.listStartupTargets(),
      startupTemplates: this.listStartupTemplates(),
    };
  }

  private listStartupTargets(): AgentDefinition[] {
    const view = this.getRuntimeView();
    return view.startupTargets;
  }

  private listStartupTemplates(): AgentStartupTemplate[] {
    const templates = BASE_STARTUP_TEMPLATES.map((item) => ({ ...item }));
    const existingIds = new Set(templates.map((item) => item.id));
    const modules = this.deps.moduleRegistry.getAllModules();

    for (const module of modules) {
      if (module.type !== 'output') continue;
      const moduleId = typeof module.id === 'string' ? module.id.trim() : '';
      if (!moduleId || existingIds.has(moduleId)) continue;
      const inferredRole = normalizeAgentType(module.metadata?.role ?? module.metadata?.type ?? moduleId);
      if (
        inferredRole !== 'project'
        && inferredRole !== 'system'
        && inferredRole !== 'reviewer'
      ) continue;
      if (
        !moduleId.includes('project')
        && !moduleId.includes('orchestr')
        && !moduleId.includes('system')
        && !moduleId.includes('review')
      ) continue;
      templates.push({
        id: moduleId,
        name: module.name ?? moduleId,
        role: inferredRole,
        defaultImplementationId: `native:${moduleId}`,
        defaultModuleId: moduleId,
        defaultInstanceCount: 1,
        launchMode: inferredRole === 'project' ? 'orchestrator' : 'manual',
      });
      existingIds.add(moduleId);
    }

    return templates.sort((a, b) => a.name.localeCompare(b.name));
  }
}
