/**
 * Resource Pool - 资源池管理
 * 管理可部署的 Agent 资源，跟踪资源使用情况
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
// AgentConfig defined locally to avoid cross-boundary imports
interface AgentConfig {
  id: string;
  name: string;
  mode: 'auto' | 'manual';
  provider?: 'iflow' | 'codex' | 'anthropic';
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: 'default' | 'autoEdit' | 'yolo' | 'plan';
  maxTurns?: number;
  maxIterations?: number;
  maxRounds?: number;
  enableReview?: boolean;
  cwd?: string;
  resumeSession?: boolean;
}

interface AgentRuntime {
  id: string;
  name: string;
  type: 'orchestrator' | 'executor' | 'reviewer';
  status: 'idle' | 'running' | 'error' | 'paused';
  load: number;
  errorRate: number;
  requestCount: number;
  tokenUsage: number;
  currentTaskId?: string;
  config?: AgentConfig;
}

const FINGER_HOME = path.join(os.homedir(), '.finger');
const RESOURCE_POOL_FILE = path.join(FINGER_HOME, 'resource-pool.json');

export interface ResourceInstance {
  id: string;
  config: AgentConfig;
  status: 'available' | 'deployed' | 'busy' | 'error';
  currentSessionId?: string;
  currentWorkflowId?: string;
  lastDeployedAt?: string;
  lastReleasedAt?: string;
  totalDeployments: number;
}

export interface ResourcePoolState {
  resources: ResourceInstance[];
  version: number;
}

export class ResourcePool {
  private resources: Map<string, ResourceInstance> = new Map();
  private deployedResources: Map<string, Set<string>> = new Map(); // sessionId -> resourceIds

  constructor() {
    this.ensureDirs();
    this.loadPool();
  }

  private ensureDirs(): void {
    if (!fs.existsSync(FINGER_HOME)) {
      fs.mkdirSync(FINGER_HOME, { recursive: true });
    }
  }

  private loadPool(): void {
    if (!fs.existsSync(RESOURCE_POOL_FILE)) {
      this.initDefaultPool();
      return;
    }

    try {
      const content = fs.readFileSync(RESOURCE_POOL_FILE, 'utf-8');
      const state = JSON.parse(content) as ResourcePoolState;
      
      for (const resource of state.resources) {
        this.resources.set(resource.id, resource);
      }
      console.log(`[ResourcePool] Loaded ${this.resources.size} resources`);
    } catch (err) {
      console.error('[ResourcePool] Failed to load pool:', err);
      this.initDefaultPool();
    }
  }

  private savePool(): void {
    const state: ResourcePoolState = {
      resources: Array.from(this.resources.values()),
      version: Date.now(),
    };
    fs.writeFileSync(RESOURCE_POOL_FILE, JSON.stringify(state, null, 2));
  }

  private initDefaultPool(): void {
    // Default orchestrator resource
    this.resources.set('orchestrator-default', {
      id: 'orchestrator-default',
      config: {
        id: 'orchestrator-default',
        name: 'Orchestrator',
        mode: 'auto',
        provider: 'iflow',
        maxRounds: 10,
        enableReview: true,
      },
      status: 'available',
      totalDeployments: 0,
    });

    // Default executor resources (3 instances)
    for (let i = 1; i <= 3; i++) {
      this.resources.set(`executor-${i}`, {
        id: `executor-${i}`,
        config: {
          id: `executor-${i}`,
          name: `Executor ${i}`,
          mode: 'auto',
          provider: 'iflow',
        },
        status: 'available',
        totalDeployments: 0,
      });
    }

    this.savePool();
    console.log(`[ResourcePool] Initialized with ${this.resources.size} default resources`);
  }

  /**
   * Deploy a resource to a session/workflow
   */
  deployResource(
    resourceId: string,
    sessionId: string,
    workflowId: string
  ): ResourceInstance | null {
    const resource = this.resources.get(resourceId);
    if (!resource) {
      console.error(`[ResourcePool] Resource ${resourceId} not found`);
      return null;
    }

    if (resource.status !== 'available') {
      console.error(`[ResourcePool] Resource ${resourceId} is not available (status: ${resource.status})`);
      return null;
    }

    resource.status = 'deployed';
    resource.currentSessionId = sessionId;
    resource.currentWorkflowId = workflowId;
    resource.lastDeployedAt = new Date().toISOString();
    resource.totalDeployments++;

    // Track deployment by session
    if (!this.deployedResources.has(sessionId)) {
      this.deployedResources.set(sessionId, new Set());
    }
    this.deployedResources.get(sessionId)!.add(resourceId);

    this.savePool();
    console.log(`[ResourcePool] Deployed ${resourceId} to session ${sessionId}, workflow ${workflowId}`);
    
    return resource;
  }

  /**
   * Mark a resource as busy (actively working)
   */
  setResourceBusy(resourceId: string): boolean {
    const resource = this.resources.get(resourceId);
    if (!resource) return false;
    
    resource.status = 'busy';
    this.savePool();
    return true;
  }

  /**
   * Release a resource back to the pool
   */
  releaseResource(resourceId: string): ResourceInstance | null {
    const resource = this.resources.get(resourceId);
    if (!resource) return null;

    const sessionId = resource.currentSessionId;
    
    resource.status = 'available';
    resource.currentSessionId = undefined;
    resource.currentWorkflowId = undefined;
    resource.lastReleasedAt = new Date().toISOString();

    // Remove from session tracking
    if (sessionId) {
      this.deployedResources.get(sessionId)?.delete(resourceId);
    }

    this.savePool();
    console.log(`[ResourcePool] Released ${resourceId} back to pool`);
    
    return resource;
  }

  /**
   * Release all resources for a session
   */
  releaseSessionResources(sessionId: string): string[] {
    const deployed = this.deployedResources.get(sessionId);
    if (!deployed) return [];

    const released: string[] = [];
    for (const resourceId of deployed) {
      if (this.releaseResource(resourceId)) {
        released.push(resourceId);
      }
    }

    this.deployedResources.delete(sessionId);
    return released;
  }

  /**
   * Get available resources (not deployed)
   */
  getAvailableResources(): ResourceInstance[] {
    return Array.from(this.resources.values())
      .filter(r => r.status === 'available');
  }

  /**
   * Get all resources
   */
  getAllResources(): ResourceInstance[] {
    return Array.from(this.resources.values());
  }

  /**
   * Get deployed resources for a session
   */
  getSessionResources(sessionId: string): ResourceInstance[] {
    const deployed = this.deployedResources.get(sessionId);
    if (!deployed) return [];
    
    return Array.from(deployed)
      .map(id => this.resources.get(id))
      .filter((r): r is ResourceInstance => r !== undefined);
  }

  /**
   * Convert resources to AgentRuntime[] for UI
   */
  toAgentRuntimes(): AgentRuntime[] {
    return Array.from(this.resources.values()).map(resource => ({
      id: resource.id,
      name: resource.config.name || resource.id,
      type: resource.id.includes('orchestrator') ? 'orchestrator' : 'executor',
      status: resource.status === 'available' ? 'idle' : 
              resource.status === 'busy' ? 'running' : 
              resource.status === 'error' ? 'error' : 'idle',
      load: resource.status === 'busy' ? 80 : resource.status === 'deployed' ? 20 : 0,
      errorRate: resource.status === 'error' ? 100 : 0,
      requestCount: resource.totalDeployments,
      tokenUsage: 0,
      currentTaskId: resource.currentWorkflowId,
      config: resource.config,
    }));
  }

  /**
   * Add a new resource to the pool
   */
  addResource(config: AgentConfig): ResourceInstance {
    const id = config.id || `resource-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    const resource: ResourceInstance = {
      id,
      config: { ...config, id },
      status: 'available',
      totalDeployments: 0,
    };

    this.resources.set(id, resource);
    this.savePool();
    console.log(`[ResourcePool] Added resource ${id}`);
    
    return resource;
  }

  /**
   * Remove a resource from the pool
   */
  removeResource(resourceId: string): boolean {
    const resource = this.resources.get(resourceId);
    if (!resource) return false;
    
    if (resource.status !== 'available') {
      console.error(`[ResourcePool] Cannot remove ${resourceId} - currently ${resource.status}`);
      return false;
    }

    this.resources.delete(resourceId);
    this.savePool();
    console.log(`[ResourcePool] Removed resource ${resourceId}`);
    
    return true;
  }
}

// Singleton instance
export const resourcePool = new ResourcePool();
