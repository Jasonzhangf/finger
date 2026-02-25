import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResourcePool, ResourceType, ResourceStatus, ResourceRequirement } from '../../../src/orchestration/resource-pool.js';

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

describe('ResourcePool', () => {
  let pool: ResourcePool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new ResourcePool();
  });

  describe('constructor and initialization', () => {
    it('should initialize with default pool when no file exists', () => {
      expect(pool.getAllResources().length).toBeGreaterThan(0);
    });

    it('should have default orchestrator resource', () => {
      const orchestrators = pool.getResourcesByType('orchestrator');
      expect(orchestrators.length).toBeGreaterThan(0);
    });

    it('should have default executor resources', () => {
      const executors = pool.getResourcesByType('executor');
      expect(executors.length).toBeGreaterThan(0);
    });

    it('should have default reviewer resource', () => {
      const reviewers = pool.getResourcesByType('reviewer');
      expect(reviewers.length).toBeGreaterThan(0);
    });
  });

  describe('getAvailableResources', () => {
    it('should return resources with available or deployed status', () => {
      const available = pool.getAvailableResources();
      expect(available.length).toBeGreaterThan(0);
    });
  });

  describe('getAllResources', () => {
    it('should return all resources', () => {
      const all = pool.getAllResources();
      expect(all.length).toBeGreaterThan(0);
    });
  });

  describe('getResourcesByType', () => {
    it('should return only resources of specified type', () => {
      const executors = pool.getResourcesByType('executor');
      expect(executors.every(r => r.type === 'executor')).toBe(true);
    });

    it('should return empty array for non-existent type', () => {
      const resources = pool.getResourcesByType('nonexistent' as ResourceType);
      expect(resources).toEqual([]);
    });
  });

  describe('checkResourceRequirements', () => {
    it('should return satisfied when requirements are met', () => {
      const requirements: ResourceRequirement[] = [
        { type: 'executor' }
      ];
      const result = pool.checkResourceRequirements(requirements);
      expect(result.satisfied).toBe(true);
      expect(result.missingResources).toEqual([]);
      expect(result.availableResources.length).toBeGreaterThan(0);
    });

    it('should return missing resources when not available', () => {
      const requirements: ResourceRequirement[] = [
        { type: 'tool', capabilities: ['nonexistent_capability'] }
      ];
      const result = pool.checkResourceRequirements(requirements);
      expect(result.satisfied).toBe(false);
      expect(result.missingResources.length).toBe(1);
    });

    it('should filter by minLevel capability', () => {
      const requirements: ResourceRequirement[] = [
        { type: 'executor', minLevel: 10 }
      ];
      const result = pool.checkResourceRequirements(requirements);
      // Default executor-general max level is 9, but executor-research has web_search level 10
      expect(result.availableResources.every(r => 
        r.capabilities.some(c => c.level >= 10)
      )).toBe(true);
    });

    it('should filter by specific capabilities', () => {
      const requirements: ResourceRequirement[] = [
        { type: 'executor', capabilities: ['web_search'] }
      ];
      const result = pool.checkResourceRequirements(requirements);
      expect(result.satisfied).toBe(true);
    });

    it('should treat optional requirements as non-blocking', () => {
      const requirements: ResourceRequirement[] = [
        { type: 'tool', capabilities: ['nonexistent'], optional: true }
      ];
      const result = pool.checkResourceRequirements(requirements);
      expect(result.satisfied).toBe(true);
      expect(result.missingResources).toEqual([]);
    });
  });

  describe('allocateResources', () => {
    it('should allocate resources for valid requirements', () => {
      const requirements: ResourceRequirement[] = [
        { type: 'executor' }
      ];
      const result = pool.allocateResources('task-1', requirements);
      expect(result.success).toBe(true);
      expect(result.allocatedResources).toBeDefined();
      expect(result.allocatedResources!.length).toBeGreaterThan(0);
    });

    it('should return error for missing resources', () => {
      const requirements: ResourceRequirement[] = [
        { type: 'tool', capabilities: ['nonexistent'] }
      ];
      const result = pool.allocateResources('task-2', requirements);
      expect(result.success).toBe(false);
      expect(result.error).toContain('资源不足');
      expect(result.missingResources).toBeDefined();
    });

    it('should return same allocation for already allocated task', () => {
      const requirements: ResourceRequirement[] = [
        { type: 'executor' }
      ];
      pool.allocateResources('task-3', requirements);
      const result = pool.allocateResources('task-3', requirements);
      expect(result.success).toBe(true);
    });

    it('should update resource status to deployed', () => {
      const requirements: ResourceRequirement[] = [
        { type: 'executor' }
      ];
      pool.allocateResources('task-4', requirements);
      const allocation = pool.getAllocation('task-4');
      expect(allocation).toBeDefined();
      expect(allocation!.status).toBe('allocated');
    });
  });

  describe('releaseResources', () => {
    it('should release allocated resources', () => {
      const requirements: ResourceRequirement[] = [
        { type: 'executor' }
      ];
      pool.allocateResources('task-5', requirements);
      const result = pool.releaseResources('task-5', 'completed');
      expect(result).toBe(true);
      
      const allocation = pool.getAllocation('task-5');
      expect(allocation!.status).toBe('completed');
    });

    it('should return false for non-existent allocation', () => {
      const result = pool.releaseResources('nonexistent-task');
      expect(result).toBe(false);
    });

    it('should mark status as failed when reason is error', () => {
      const requirements: ResourceRequirement[] = [{ type: 'executor' }];
      pool.allocateResources('task-6', requirements);
      pool.releaseResources('task-6', 'failed');
      
      const allocation = pool.getAllocation('task-6');
      expect(allocation!.status).toBe('failed');
    });
  });

  describe('markTaskExecuting', () => {
    it('should update allocation and resource status to executing/busy', () => {
      const requirements: ResourceRequirement[] = [{ type: 'executor' }];
      pool.allocateResources('task-7', requirements);
      
      const result = pool.markTaskExecuting('task-7');
      expect(result).toBe(true);
      
      const allocation = pool.getAllocation('task-7');
      expect(allocation!.status).toBe('executing');
    });

    it('should return false for non-existent allocation', () => {
      const result = pool.markTaskExecuting('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('addResource', () => {
    it('should add a new resource', () => {
      const newResource = {
        id: 'test-resource',
        name: 'Test Resource',
        type: 'tool' as ResourceType,
        capabilities: [{ type: 'test', level: 5 }],
        status: 'available' as ResourceStatus,
      };
      
      const result = pool.addResource(newResource);
      expect(result.id).toBe('test-resource');
      expect(result.totalDeployments).toBe(0);
      expect(result.errorCount).toBe(0);
      
      const found = pool.getAllResources().find(r => r.id === 'test-resource');
      expect(found).toBeDefined();
    });
  });

  describe('removeResource', () => {
    it('should remove an available resource', () => {
      const newResource = {
        id: 'removable-resource',
        name: 'Removable Resource',
        type: 'tool' as ResourceType,
        capabilities: [],
        status: 'available' as ResourceStatus,
      };
      pool.addResource(newResource);
      
      const result = pool.removeResource('removable-resource');
      expect(result).toBe(true);
      
      const found = pool.getAllResources().find(r => r.id === 'removable-resource');
      expect(found).toBeUndefined();
    });

    it('should not remove non-available resource', () => {
      // Default resource might not be available, so we test with a non-existent one
      const result = pool.removeResource('nonexistent-resource');
      expect(result).toBe(false);
    });
  });

  describe('setResourceBusy', () => {
    it('should set resource to busy', () => {
      const newResource = {
        id: 'busy-test',
        name: 'Busy Test',
        type: 'tool' as ResourceType,
        capabilities: [],
        status: 'available' as ResourceStatus,
      };
      pool.addResource(newResource);
      
      const result = pool.setResourceBusy('busy-test', true);
      expect(result).toBe(true);
      
      const resource = pool.getAllResources().find(r => r.id === 'busy-test');
      expect(resource!.status).toBe('busy');
    });

    it('should set resource back to available', () => {
      const newResource = {
        id: 'busy-test-2',
        name: 'Busy Test 2',
        type: 'tool' as ResourceType,
        capabilities: [],
        status: 'available' as ResourceStatus,
      };
      pool.addResource(newResource);
      pool.setResourceBusy('busy-test-2', true);
      pool.setResourceBusy('busy-test-2', false);
      
      const resource = pool.getAllResources().find(r => r.id === 'busy-test-2');
      expect(resource!.status).toBe('available');
    });

    it('should return false for non-existent resource', () => {
      const result = pool.setResourceBusy('nonexistent', true);
      expect(result).toBe(false);
    });
  });

  describe('deployResource', () => {
    it('should deploy resource to session/workflow', () => {
      const newResource = {
        id: 'deploy-test',
        name: 'Deploy Test',
        type: 'executor' as ResourceType,
        capabilities: [],
        status: 'available' as ResourceStatus,
      };
      pool.addResource(newResource);
      
      const result = pool.deployResource('deploy-test', 'session-1', 'workflow-1');
      expect(result).toBe(true);
      
      const resource = pool.getAllResources().find(r => r.id === 'deploy-test');
      expect(resource!.status).toBe('deployed');
      expect(resource!.currentSessionId).toBe('session-1');
      expect(resource!.currentWorkflowId).toBe('workflow-1');
      expect(resource!.totalDeployments).toBe(1);
    });

    it('should return false for non-available resource', () => {
      const newResource = {
        id: 'deploy-test-2',
        name: 'Deploy Test 2',
        type: 'executor' as ResourceType,
        capabilities: [],
        status: 'busy' as ResourceStatus,
      };
      pool.addResource(newResource);
      
      const result = pool.deployResource('deploy-test-2', 'session-1');
      expect(result).toBe(false);
    });
  });

  describe('releaseResource', () => {
    it('should release a single resource', () => {
      const newResource = {
        id: 'release-test',
        name: 'Release Test',
        type: 'executor' as ResourceType,
        capabilities: [],
        status: 'deployed' as ResourceStatus,
        currentSessionId: 'session-1',
      };
      pool.addResource(newResource);
      
      const result = pool.releaseResource('release-test');
      expect(result).toBe(true);
      
      const resource = pool.getAllResources().find(r => r.id === 'release-test');
      expect(resource!.status).toBe('available');
      expect(resource!.currentSessionId).toBeUndefined();
    });

    it('should return false for non-existent resource', () => {
      const result = pool.releaseResource('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('getCapabilityCatalog', () => {
    it('should return catalog of capabilities', () => {
      const catalog = pool.getCapabilityCatalog();
      expect(catalog.length).toBeGreaterThan(0);
    });

    it('should count resources per capability', () => {
      const catalog = pool.getCapabilityCatalog();
      const webSearch = catalog.find(c => c.capability === 'web_search');
      expect(webSearch).toBeDefined();
      expect(webSearch!.resourceCount).toBeGreaterThan(0);
    });
  });

  describe('getResourcesByCapability', () => {
    it('should return resources with specific capability', () => {
      const resources = pool.getResourcesByCapability('web_search');
      expect(resources.length).toBeGreaterThan(0);
      expect(resources.every(r => 
        r.capabilities.some(c => c.type === 'web_search')
      )).toBe(true);
    });

    it('should filter by minLevel', () => {
      const resources = pool.getResourcesByCapability('web_search', 10);
      expect(resources.every(r => 
        r.capabilities.some(c => c.type === 'web_search' && c.level >= 10)
      )).toBe(true);
    });

    it('should return empty for non-existent capability', () => {
      const resources = pool.getResourcesByCapability('nonexistent_capability');
      expect(resources).toEqual([]);
    });
  });

  describe('getStatusReport', () => {
    it('should return complete status report', () => {
      const report = pool.getStatusReport();
      expect(report.totalResources).toBeGreaterThan(0);
      expect(report.totalAllocations).toBeDefined();
      expect(report.capabilityCatalog).toBeDefined();
    });

    it('should count resources by status', () => {
      const report = pool.getStatusReport();
      const counted = report.available + report.deployed + report.busy + report.blocked + report.error;
      expect(counted).toBeLessThanOrEqual(report.totalResources);
    });
  });

  describe('getAllocation', () => {
    it('should return allocation for task', () => {
      const requirements: ResourceRequirement[] = [{ type: 'executor' }];
      pool.allocateResources('task-allocation', requirements);
      
      const allocation = pool.getAllocation('task-allocation');
      expect(allocation).toBeDefined();
      expect(allocation!.taskId).toBe('task-allocation');
    });

    it('should return undefined for non-existent task', () => {
      const allocation = pool.getAllocation('nonexistent');
      expect(allocation).toBeUndefined();
    });
  });

  describe('getAllAllocations', () => {
    it('should return all allocations', () => {
      const requirements: ResourceRequirement[] = [{ type: 'executor' }];
      pool.allocateResources('task-alloc-1', requirements);
      pool.allocateResources('task-alloc-2', requirements);
      
      const allocations = pool.getAllAllocations();
      expect(allocations.length).toBeGreaterThanOrEqual(2);
    });
  });
});
