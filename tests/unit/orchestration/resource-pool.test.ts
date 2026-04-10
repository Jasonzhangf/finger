import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResourcePool, type ResourceType, ResourceStatus, type ResourceRequirement } from '../../../src/orchestration/resource-pool.js';

// Mock fs module
vi.mock('fs', () => {
  const fsMock = {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
  return {
    default: fsMock,
    ...fsMock,
  };
});

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

    it('should have default system resource', () => {
      const systems = pool.getResourcesByType('system');
      expect(systems.length).toBeGreaterThan(0);
    });

    it('should have default project resources', () => {
      const projects = pool.getResourcesByType('project');
      expect(projects.length).toBeGreaterThan(0);
    });
  });

  describe('checkResourceRequirements', () => {
    it('should return satisfied when requirements are met', () => {
      const requirements: ResourceRequirement[] = [{ type: 'system', count: 1 }];
      const result = pool.checkResourceRequirements(requirements);
      expect(result.satisfied).toBe(true);
    });

    it('should return unsatisfied when count exceeds available', () => {
      const requirements: ResourceRequirement[] = [{ type: 'system', count: 100 }];
      const result = pool.checkResourceRequirements(requirements);
      expect(result.satisfied).toBe(false);
    });
  });

  describe('allocateResources', () => {
    it('should allocate resources for valid requirements', () => {
      const requirements: ResourceRequirement[] = [{ type: 'project', count: 1 }];
      const result = pool.allocateResources('test-task-1', requirements);
      expect(result.success).toBe(true);
      expect(result.allocatedResources.length).toBe(1);
    });

    it('should return same allocation for already allocated task', () => {
      const requirements: ResourceRequirement[] = [{ type: 'project', count: 1 }];
      pool.allocateResources('test-task-2', requirements);
      const result = pool.allocateResources('test-task-2', requirements);
      expect(result.success).toBe(true);
      expect(result.allocatedResources.length).toBe(1);
    });
  });

  describe('releaseResources', () => {
    it('should release allocated resources', () => {
      const requirements: ResourceRequirement[] = [{ type: 'project', count: 1 }];
      pool.allocateResources('test-task-4', requirements);
      const released = pool.releaseResources('test-task-4');
      expect(released).toBe(true);
    });

    it('should mark allocation status as failed when reason is error', () => {
      const requirements: ResourceRequirement[] = [{ type: 'project', count: 1 }];
      pool.allocateResources('test-task-6', requirements);
      pool.releaseResources('test-task-6', 'error');
      const allocation = pool.getAllocation('test-task-6');
      expect(allocation).toBeDefined();
      expect(allocation?.status).toBe('failed');
    });
  });

  describe('getAllocation', () => {
    it('should return allocation for task', () => {
      const requirements: ResourceRequirement[] = [{ type: 'project', count: 1 }];
      pool.allocateResources('test-task-8', requirements);
      const allocation = pool.getAllocation('test-task-8');
      expect(allocation).toBeDefined();
      expect(allocation?.taskId).toBe('test-task-8');
    });
  });

  describe('getAllAllocations', () => {
    it('should return all allocations', () => {
      const requirements: ResourceRequirement[] = [{ type: 'project', count: 1 }];
      pool.allocateResources('test-task-9', requirements);
      const allocations = pool.getAllAllocations();
      expect(allocations.length).toBeGreaterThan(0);
    });
  });
});
