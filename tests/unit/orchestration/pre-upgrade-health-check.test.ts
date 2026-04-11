import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PreUpgradeHealthCheck, type HealthCheckResult } from '../../../src/orchestration/pre-upgrade-health-check.js';
import * as moduleLayers from '../../../src/orchestration/module-layers.js';
import * as childProcess from 'node:child_process';

// Mock logger
vi.mock('../../../src/core/logger.js', () => ({
  logger: {
    module: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

// Mock child_process
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PreUpgradeHealthCheck', () => {
  let checker: PreUpgradeHealthCheck;

  beforeEach(() => {
    vi.clearAllMocks();
    checker = new PreUpgradeHealthCheck({
      daemonUrl: 'http://127.0.0.1:9999',
      minDiskSpaceMB: 100,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== checkDaemon() ====================

  describe('checkDaemon()', () => {
    it('should return ok when daemon is healthy', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'healthy' }),
      } as Response);

      const result = await checker.checkDaemon();
      expect(result.ok).toBe(true);
      expect(result.status).toBe('healthy');
    });

    it('should return unhealthy when daemon reports unhealthy', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'degraded', detail: 'High memory' }),
      } as Response);

      const result = await checker.checkDaemon();
      expect(result.ok).toBe(false);
      expect(result.status).toBe('degraded');
    });

    it('should return unreachable when fetch fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const result = await checker.checkDaemon();
      expect(result.ok).toBe(false);
      expect(result.status).toBe('unreachable');
    });

    it('should return unhealthy on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
      } as Response);

      const result = await checker.checkDaemon();
      expect(result.ok).toBe(false);
      expect(result.status).toBe('unhealthy');
    });
  });

  // ==================== checkProvider() ====================

  describe('checkProvider()', () => {
    it('should return ok when provider is connected', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connected: true }),
      } as Response);

      const result = await checker.checkProvider();
      expect(result.ok).toBe(true);
      expect(result.latency).toBeDefined();
    });

    it('should return ok when status is connected', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'connected' }),
      } as Response);

      const result = await checker.checkProvider();
      expect(result.ok).toBe(true);
    });

    it('should return error when provider not connected', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ connected: false, detail: 'Invalid API key' }),
      } as Response);

      const result = await checker.checkProvider();
      expect(result.ok).toBe(false);
      expect(result.detail).toContain('Invalid API key');
    });

    it('should return error on fetch failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Timeout'));

      const result = await checker.checkProvider();
      expect(result.ok).toBe(false);
    });
  });

  // ==================== checkDiskSpace() ====================

  describe('checkDiskSpace()', () => {
    it('should return ok when enough disk space', async () => {
      vi.mocked(childProcess.execSync).mockReturnValue('Filesystem    1M-blocks   Used Available Use% Mounted\n/dev/disk1      1000000 500000    500000  50% /\n' as any);

      const result = await checker.checkDiskSpace();
      expect(result.ok).toBe(true);
      expect(result.availableMB).toBe(500000);
    });

    it('should return error when insufficient disk space', async () => {
      vi.mocked(childProcess.execSync).mockReturnValue('Filesystem    1M-blocks   Used Available Use% Mounted\n/dev/disk1      1000000 999950        50  99% /\n' as any);

      const result = await checker.checkDiskSpace();
      expect(result.ok).toBe(false);
      expect(result.availableMB).toBe(50);
    });

    it('should return error on exec failure', async () => {
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        throw new Error('Command failed');
      }) as any;

      const result = await checker.checkDiskSpace();
      expect(result.ok).toBe(false);
    });
  });

  // ==================== checkSessions() ====================

  describe('checkSessions()', () => {
    it('should return ok when orphan count is low', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ orphanCount: 2 }),
      } as Response);

      const result = await checker.checkSessions();
      expect(result.ok).toBe(true);
      expect(result.orphanCount).toBe(2);
    });

    it('should return error when too many orphan sessions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ orphanCount: 25 }),
      } as Response);

      const result = await checker.checkSessions();
      expect(result.ok).toBe(false);
    });

    it('should return ok on fetch failure (skipped)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Daemon unreachable'));

      const result = await checker.checkSessions();
      expect(result.ok).toBe(true);
      expect(result.detail).toContain('skipped');
    });
  });

  // ==================== checkDependencies() ====================

  describe('checkDependencies()', () => {
    it('should return ok when no dependencies', async () => {
      vi.spyOn(moduleLayers, 'moduleLayers', 'get').mockReturnValue({
        getDependencies: () => [],
      } as () => never);

      const result = await checker.checkDependencies('standalone-module');
      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('should return ok when all dependencies healthy', async () => {
      vi.spyOn(moduleLayers, 'moduleLayers', 'get').mockReturnValue({
        getDependencies: () => ['dep-a', 'dep-b'],
      } as () => never);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: 'healthy' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: 'active' }),
        } as Response);

      const result = await checker.checkDependencies('test-module');
      expect(result.ok).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('should return error when dependency unhealthy', async () => {
      vi.spyOn(moduleLayers, 'moduleLayers', 'get').mockReturnValue({
        getDependencies: () => ['dep-a', 'dep-b'],
      } as () => never);

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: 'crashed' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: 'healthy' }),
        } as Response);

      const result = await checker.checkDependencies('test-module');
      expect(result.ok).toBe(false);
      expect(result.missing).toContain('dep-a');
    });
  });

  // ==================== runFullCheck() ====================

  describe('runFullCheck()', () => {
    it('should return ok when all checks pass', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'healthy', connected: true, orphanCount: 0 }),
      } as Response);

      vi.mocked(childProcess.execSync).mockReturnValue(
        'Filesystem    1M-blocks   Used Available Use% Mounted\n/dev/disk1      1000000 500000    500000  50% /\n',
      );

      vi.spyOn(moduleLayers, 'moduleLayers', 'get').mockReturnValue({
        getDependencies: () => [],
      } as () => never);

      const result = await checker.runFullCheck('test-module');
      expect(result.ok).toBe(true);
      expect(result.summary).toContain('passed');
      expect(result.checks.daemon.ok).toBe(true);
      expect(result.checks.provider.ok).toBe(true);
      expect(result.checks.diskSpace.ok).toBe(true);
      expect(result.checks.sessions.ok).toBe(true);
      expect(result.checks.dependencies.ok).toBe(true);
    });

    it('should return error when any check fails', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      vi.mocked(childProcess.execSync).mockReturnValue(
        'Filesystem    1M-blocks   Used Available Use% Mounted\n/dev/disk1      1000000 999950        50  99% /\n',
      );

      vi.spyOn(moduleLayers, 'moduleLayers', 'get').mockReturnValue({
        getDependencies: () => ['dep-a'],
      } as () => never);

      const result = await checker.runFullCheck('test-module');
      expect(result.ok).toBe(false);
      expect(result.summary).toContain('failed');
    });
  });
});
