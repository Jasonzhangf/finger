/**
 * Resource Pool - 资源池管理
 * 支持资源类别、属性匹配、临时占用和释放
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

export type ResourceType = 'executor' | 'orchestrator' | 'reviewer' | 'tool' | 'api' | 'database';
export type ResourceStatus = 'available' | 'deployed' | 'busy' | 'blocked' | 'error' | 'released';

export interface ResourceCapability {
  type: string;
  level: number; // 1-10
  metadata?: Record<string, unknown>;
}

export interface ResourceInstance {
  id: string;
  name: string;
  type: ResourceType;
  capabilities: ResourceCapability[];
  status: ResourceStatus;
  currentSessionId?: string;
  currentWorkflowId?: string;
  currentTaskId?: string;
  deployedAt?: string;
  totalDeployments: number;
  errorCount: number;
  lastErrorAt?: string;
  lastErrorReason?: string;
}

export interface ResourceRequirement {
  type: ResourceType;
  minLevel?: number;
  capabilities?: string[];
  optional?: boolean; // 是否可选资源
}

export interface TaskResourceAllocation {
  taskId: string;
  allocatedResources: string[]; // resource IDs
  status: 'pending' | 'allocated' | 'executing' | 'completed' | 'blocked' | 'failed';
  blockedReason?: string;
  allocatedAt?: string;
  releasedAt?: string;
}

export interface ResourcePoolState {
  resources: ResourceInstance[];
  allocations: TaskResourceAllocation[];
  version: number;
}

const FINGER_HOME = path.join(os.homedir(), '.finger');
const RESOURCE_POOL_FILE = path.join(FINGER_HOME, 'resource-pool.json');

export class ResourcePool {
  private resources: Map<string, ResourceInstance> = new Map();
  private allocations: Map<string, TaskResourceAllocation> = new Map(); // taskId -> allocation

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
      for (const allocation of state.allocations || []) {
        this.allocations.set(allocation.taskId, allocation);
      }
      console.log(`[ResourcePool] Loaded ${this.resources.size} resources, ${this.allocations.size} allocations`);
    } catch (err) {
      console.error('[ResourcePool] Failed to load pool:', err);
      this.initDefaultPool();
    }
  }

  private savePool(): void {
    const state: ResourcePoolState = {
      resources: Array.from(this.resources.values()),
      allocations: Array.from(this.allocations.values()),
      version: Date.now(),
    };
    fs.writeFileSync(RESOURCE_POOL_FILE, JSON.stringify(state, null, 2));
  }

  private initDefaultPool(): void {
    // Default orchestrator
    this.resources.set('orchestrator-default', {
      id: 'orchestrator-default',
      name: 'Default Orchestrator',
      type: 'orchestrator',
      capabilities: [{ type: 'planning', level: 8 }, { type: 'coordination', level: 9 }],
      status: 'available',
      totalDeployments: 0,
      errorCount: 0,
    });

    // Default executors with different capabilities
    this.resources.set('executor-general', {
      id: 'executor-general',
      name: 'General Executor',
      type: 'executor',
      capabilities: [
        { type: 'web_search', level: 8 },
        { type: 'file_ops', level: 9 },
        { type: 'shell_exec', level: 7 },
      ],
      status: 'available',
      totalDeployments: 0,
      errorCount: 0,
    });

    this.resources.set('executor-research', {
      id: 'executor-research',
      name: 'Research Executor',
      type: 'executor',
      capabilities: [
        { type: 'web_search', level: 10 },
        { type: 'data_analysis', level: 8 },
        { type: 'report_generation', level: 9 },
      ],
      status: 'available',
      totalDeployments: 0,
      errorCount: 0,
    });

    this.resources.set('executor-coding', {
      id: 'executor-coding',
      name: 'Coding Executor',
      type: 'executor',
      capabilities: [
        { type: 'code_generation', level: 9 },
        { type: 'file_ops', level: 10 },
        { type: 'shell_exec', level: 8 },
      ],
      status: 'available',
      totalDeployments: 0,
      errorCount: 0,
    });

    // Default reviewer
    this.resources.set('reviewer-default', {
      id: 'reviewer-default',
      name: 'Default Reviewer',
      type: 'reviewer',
      capabilities: [{ type: 'code_review', level: 8 }, { type: 'quality_check', level: 9 }],
      status: 'available',
      totalDeployments: 0,
      errorCount: 0,
    });

    this.savePool();
    console.log(`[ResourcePool] Initialized with ${this.resources.size} default resources`);
  }

  /**
   * Check if resources meet task requirements
   */
  checkResourceRequirements(requirements: ResourceRequirement[]): {
    satisfied: boolean;
    missingResources: ResourceRequirement[];
    availableResources: ResourceInstance[];
  } {
    const missingResources: ResourceRequirement[] = [];
    const availableResources: ResourceInstance[] = [];

    for (const req of requirements) {
      const matchingResources = this.getAvailableResources().filter(r => {
        if (r.type !== req.type) return false;
        if (req.minLevel && r.capabilities.some(c => c.level < req.minLevel)) return false;
        if (req.capabilities) {
          const hasAllCaps = req.capabilities.every(cap => 
            r.capabilities.some(c => c.type === cap)
          );
          if (!hasAllCaps) return false;
        }
        return true;
      });

      if (matchingResources.length === 0) {
        if (!req.optional) {
          missingResources.push(req);
        }
      } else {
        availableResources.push(...matchingResources);
      }
    }

    return {
      satisfied: missingResources.length === 0,
      missingResources,
      availableResources,
    };
  }

  /**
   * Allocate resources for a task
   */
  allocateResources(
    taskId: string,
    requirements: ResourceRequirement[]
  ): {
    success: boolean;
    allocatedResources?: string[];
    error?: string;
    missingResources?: ResourceRequirement[];
  } {
    // Check if already allocated
    const existing = this.allocations.get(taskId);
    if (existing && existing.status === 'allocated') {
      return { success: true, allocatedResources: existing.allocatedResources };
    }

    const check = this.checkResourceRequirements(requirements);
    
    if (!check.satisfied) {
      return {
        success: false,
        error: `资源不足：缺少 ${check.missingResources.map(r => r.type).join(', ')}`,
        missingResources: check.missingResources,
      };
    }

    // Allocate unique resources (one per requirement type)
    const allocatedIds = new Set<string>();
    for (const req of requirements) {
      const available = check.availableResources.filter(
        r => r.type === req.type && !allocatedIds.has(r.id)
      );
      if (available.length > 0) {
        allocatedIds.add(available[0].id);
      }
    }

    // Update resource status
    for (const resourceId of allocatedIds) {
      const resource = this.resources.get(resourceId);
      if (resource) {
        resource.status = 'deployed';
        resource.currentTaskId = taskId;
      }
    }

    // Create allocation record
    const allocation: TaskResourceAllocation = {
      taskId,
      allocatedResources: Array.from(allocatedIds),
      status: 'allocated',
      allocatedAt: new Date().toISOString(),
    };
    this.allocations.set(taskId, allocation);

    this.savePool();
    console.log(`[ResourcePool] Allocated ${allocatedIds.size} resources for task ${taskId}`);
    
    return { success: true, allocatedResources: Array.from(allocatedIds) };
  }

  /**
   * Release resources for a task
   */
  releaseResources(taskId: string, reason?: string): boolean {
    const allocation = this.allocations.get(taskId);
    if (!allocation) return false;

    // Update resource status
    for (const resourceId of allocation.allocatedResources) {
      const resource = this.resources.get(resourceId);
      if (resource) {
        resource.status = 'available';
        resource.currentTaskId = undefined;
        if (reason === 'error') {
          resource.errorCount++;
          resource.lastErrorAt = new Date().toISOString();
          resource.lastErrorReason = reason;
        }
      }
    }

    // Update allocation record
    allocation.status = reason === 'completed' ? 'completed' : 'released';
    allocation.releasedAt = new Date().toISOString();
    if (reason === 'blocked') {
      allocation.status = 'blocked';
      allocation.blockedReason = reason;
    }

    this.savePool();
    console.log(`[ResourcePool] Released resources for task ${taskId}`);
    
    return true;
  }

  /**
   * Mark task as executing (resources are in use)
   */
  markTaskExecuting(taskId: string): boolean {
    const allocation = this.allocations.get(taskId);
    if (!allocation) return false;

    allocation.status = 'executing';
    
    for (const resourceId of allocation.allocatedResources) {
      const resource = this.resources.get(resourceId);
      if (resource) {
        resource.status = 'busy';
      }
    }

    this.savePool();
    return true;
  }

  /**
   * Get available resources (not deployed or busy)
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
   * Get resources by type
   */
  getResourcesByType(type: ResourceType): ResourceInstance[] {
    return this.getAllResources().filter(r => r.type === type);
  }

  /**
   * Get allocation for a task
   */
  getAllocation(taskId: string): TaskResourceAllocation | undefined {
    return this.allocations.get(taskId);
  }

  /**
   * Get all allocations
   */
  getAllAllocations(): TaskResourceAllocation[] {
    return Array.from(this.allocations.values());
  }

  /**
   * Add a new resource
   */
  addResource(resource: Omit<ResourceInstance, 'totalDeployments' | 'errorCount'>): ResourceInstance {
    const newResource: ResourceInstance = {
      ...resource,
      totalDeployments: 0,
      errorCount: 0,
    };
    this.resources.set(resource.id, newResource);
    this.savePool();
    console.log(`[ResourcePool] Added resource ${resource.id}`);
    return newResource;
  }

  /**
   * Remove a resource
   */
  removeResource(resourceId: string): boolean {
    const resource = this.resources.get(resourceId);
    if (!resource || resource.status !== 'available') return false;

    this.resources.delete(resourceId);
    this.savePool();
    console.log(`[ResourcePool] Removed resource ${resourceId}`);
    return true;
  }

  /**
   * Get capability catalog - list of all available capabilities across resources
   * This is used by orchestrator to understand what capabilities are available
   */
  getCapabilityCatalog(): Array<{
    capability: string;
    resourceCount: number;
    availableCount: number;
    resources: Array<{ id: string; name: string; level: number; status: ResourceStatus }>;
  }> {
    const capabilityMap = new Map<string, Array<{ id: string; name: string; level: number; status: ResourceStatus }>>();
    
    for (const resource of this.resources.values()) {
      if (resource.status === 'error') continue; // Skip error resources
      
      for (const cap of resource.capabilities) {
        if (!capabilityMap.has(cap.type)) {
          capabilityMap.set(cap.type, []);
        }
        capabilityMap.get(cap.type)!.push({
          id: resource.id,
          name: resource.name,
          level: cap.level,
          status: resource.status,
        });
      }
    }
    
    return Array.from(capabilityMap.entries()).map(([capability, resources]) => ({
      capability,
      resourceCount: resources.length,
      availableCount: resources.filter(r => r.status === 'available' || r.status === 'deployed').length,
      resources,
    })).sort((a, b) => b.resourceCount - a.resourceCount);
  }

  /**
   * Get resources by capability
   */
  getResourcesByCapability(capability: string, minLevel: number = 1): ResourceInstance[] {
    return this.getAvailableResources().filter(r =>
      r.capabilities.some(c => c.type === capability && c.level >= minLevel)
    );
  }

  /**
   * Get pool status report
   */
  getStatusReport(): {
    totalResources: number;
    available: number;
    deployed: number;
    busy: number;
    blocked: number;
    error: number;
    totalAllocations: number;
    pendingAllocations: number;
    blockedAllocations: number;
    capabilityCatalog?: Array<{ capability: string; resourceCount: number; availableCount: number }>;
  } {
    const resources = this.getAllResources();
    const capabilityCatalog = this.getCapabilityCatalog().map(c => ({
      capability: c.capability,
      resourceCount: c.resourceCount,
      availableCount: c.availableCount,
    }));
    
    return {
      totalResources: resources.length,
      available: resources.filter(r => r.status === 'available').length,
      deployed: resources.filter(r => r.status === 'deployed').length,
      busy: resources.filter(r => r.status === 'busy').length,
      blocked: resources.filter(r => r.status === 'blocked').length,
      error: resources.filter(r => r.status === 'error').length,
      totalAllocations: this.allocations.size,
      pendingAllocations: Array.from(this.allocations.values()).filter(a => a.status === 'pending').length,
      blockedAllocations: Array.from(this.allocations.values()).filter(a => a.status === 'blocked').length,
      capabilityCatalog,
    };
  }
}

// Singleton instance
export const resourcePool = new ResourcePool();
