import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { UpgradePackageManager } from '../../../src/orchestration/upgrade-package-manager.js';
import type { UpgradePackage, PackageManifest } from '../../../src/orchestration/upgrade-package-manager.js';

// Mock fs and crypto
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  statSync: vi.fn(),
  createReadStream: vi.fn(),
}));

vi.mock('node:crypto', () => ({
  createHash: vi.fn(),
}));

vi.mock('../../../src/core/logger.js', () => ({
  logger: {
    module: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('UpgradePackageManager', () => {
  let manager: UpgradePackageManager;
  let mockFs: typeof fs;
  let mockCrypto: typeof crypto;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs = vi.mocked(fs);
    mockCrypto = vi.mocked(crypto);
    manager = new UpgradePackageManager('/tmp/test-cache');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==================== 获取升级包测试 ====================

  describe('fetchFromNpm()', () => {
    it('should fetch package from npm registry', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      } as Response);
      
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          version: '1.0.0',
          dist: { shasum: 'abc123', integrity: 'sha512-def456' },
          peerDependencies: { core: '>=3.0.0' },
        }),
      } as Response);

      const pkg = await manager.fetchFromNpm('test-module', '1.0.0');

      expect(pkg.moduleId).toBe('test-module');
      expect(pkg.version).toBe('1.0.0');
      expect(pkg.sourceType).toBe('npm');
      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });

    it('should throw on download failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      } as Response);

      await expect(manager.fetchFromNpm('nonexistent-module', '1.0.0')).rejects.toThrow();
    });
  });

  describe('fetchFromTarball()', () => {
    it('should load package from local tarball', async () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(Buffer.from('tarball content'));

      const hashMock = {
        update: vi.fn(),
        digest: vi.fn().mockReturnValue('sha256hash'),
      };
      mockCrypto.createHash.mockReturnValue(hashMock as any);

      // Mock stream
      const mockStream = Object.assign([], {
        on: vi.fn(),
      });
      (mockStream as any)[Symbol.asyncIterator] = async function* () {
        yield Buffer.from('data');
      };
      mockFs.createReadStream.mockReturnValue(mockStream as any);

      const pkg = await manager.fetchFromTarball('/tmp/test-module-1.0.0.tgz');

      expect(pkg.moduleId).toBe('test-module');
      expect(pkg.sourceType).toBe('tarball');
    });

    it('should throw when tarball not found', async () => {
      mockFs.existsSync.mockReturnValue(false);

      await expect(manager.fetchFromTarball('/tmp/nonexistent.tgz')).rejects.toThrow('Tarball not found');
    });
  });

  describe('fetchFromUrl()', () => {
    it('should download package from URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      } as Response);

      const hashMock = {
        update: vi.fn(),
        digest: vi.fn().mockReturnValue('sha256hash'),
      };
      mockCrypto.createHash.mockReturnValue(hashMock as any);

      const mockStream = Object.assign([], {
        on: vi.fn(),
      });
      (mockStream as any)[Symbol.asyncIterator] = async function* () {
        yield Buffer.from('data');
      };
      mockFs.createReadStream.mockReturnValue(mockStream as any);

      const pkg = await manager.fetchFromUrl('https://releases.example.com/test-module-1.0.0.tgz');

      expect(pkg.moduleId).toBe('test-module');
      expect(pkg.sourceType).toBe('url');
    });
  });

  // ==================== 校验升级包测试 ====================

  describe('verifyPackage()', () => {
    it('should pass all verifications', async () => {
      const pkg: UpgradePackage = {
        moduleId: 'test-module',
        version: '1.0.0',
        tier: 'extension',
        checksum: 'abc123',
        sourcePath: '/tmp/test.tgz',
        manifest: {
          moduleId: 'test-module',
          version: '1.0.0',
          tier: 'extension',
          checksum: 'abc123',
          files: ['dist/index.js'],
        },
        sourceType: 'tarball',
      };

      mockFs.existsSync.mockReturnValue(true);

      const hashMock = {
        update: vi.fn(),
        digest: vi.fn().mockReturnValue('abc123'),
      };
      mockCrypto.createHash.mockReturnValue(hashMock as any);

      const mockStream = Object.assign([], {
        on: vi.fn(),
      });
      (mockStream as any)[Symbol.asyncIterator] = async function* () {
        yield Buffer.from('data');
      };
      mockFs.createReadStream.mockReturnValue(mockStream as any);

      mockFs.readFileSync.mockReturnValue(JSON.stringify({ version: '3.0.0' }));

      const result = await manager.verifyPackage(pkg);

      expect(result.ok).toBe(true);
      expect(result.checksumOk).toBe(true);
      expect(result.structureOk).toBe(true);
    });

    it('should fail on checksum mismatch', async () => {
      const pkg: UpgradePackage = {
        moduleId: 'test-module',
        version: '1.0.0',
        tier: 'extension',
        checksum: 'expected-hash',
        sourcePath: '/tmp/test.tgz',
        manifest: {
          moduleId: 'test-module',
          version: '1.0.0',
          tier: 'extension',
          checksum: 'expected-hash',
          files: [],
        },
        sourceType: 'tarball',
      };

      mockFs.existsSync.mockReturnValue(true);

      const hashMock = {
        update: vi.fn(),
        digest: vi.fn().mockReturnValue('different-hash'),
      };
      mockCrypto.createHash.mockReturnValue(hashMock as any);

      const mockStream = Object.assign([], {
        on: vi.fn(),
      });
      (mockStream as any)[Symbol.asyncIterator] = async function* () {
        yield Buffer.from('data');
      };
      mockFs.createReadStream.mockReturnValue(mockStream as any);

      const result = await manager.verifyPackage(pkg);

      expect(result.checksumOk).toBe(false);
      expect(result.errors).toContain('Checksum mismatch');
    });

    it('should fail on missing manifest', async () => {
      const pkg: UpgradePackage = {
        moduleId: 'test-module',
        version: '1.0.0',
        tier: 'extension',
        checksum: 'abc123',
        sourcePath: '/tmp/test.tgz',
        manifest: null as any,
        sourceType: 'tarball',
      };

      const result = await manager.verifyPackage(pkg);

      expect(result.structureOk).toBe(false);
      expect(result.errors).toContain('Invalid package structure');
    });
  });

  describe('verifyChecksum()', () => {
    it('should return true when checksum matches', async () => {
      const pkg: UpgradePackage = {
        moduleId: 'test-module',
        version: '1.0.0',
        tier: 'extension',
        checksum: 'abc123',
        sourcePath: '/tmp/test.tgz',
        manifest: {} as any,
        sourceType: 'tarball',
      };

      const hashMock = {
        update: vi.fn(),
        digest: vi.fn().mockReturnValue('abc123'),
      };
      mockCrypto.createHash.mockReturnValue(hashMock as any);

      const mockStream = Object.assign([], {
        on: vi.fn(),
      });
      (mockStream as any)[Symbol.asyncIterator] = async function* () {
        yield Buffer.from('data');
      };
      mockFs.createReadStream.mockReturnValue(mockStream as any);

      const result = await manager.verifyChecksum(pkg);
      expect(result).toBe(true);
    });

    it('should return true when checksum has sha256 prefix', async () => {
      const pkg: UpgradePackage = {
        moduleId: 'test-module',
        version: '1.0.0',
        tier: 'extension',
        checksum: 'sha256:abc123',
        sourcePath: '/tmp/test.tgz',
        manifest: {} as any,
        sourceType: 'tarball',
      };

      const hashMock = {
        update: vi.fn(),
        digest: vi.fn().mockReturnValue('abc123'),
      };
      mockCrypto.createHash.mockReturnValue(hashMock as any);

      const mockStream = Object.assign([], {
        on: vi.fn(),
      });
      (mockStream as any)[Symbol.asyncIterator] = async function* () {
        yield Buffer.from('data');
      };
      mockFs.createReadStream.mockReturnValue(mockStream as any);

      const result = await manager.verifyChecksum(pkg);
      expect(result).toBe(true);
    });

    it('should skip when no checksum specified', async () => {
      const pkg: UpgradePackage = {
        moduleId: 'test-module',
        version: '1.0.0',
        tier: 'extension',
        checksum: '',
        sourcePath: '/tmp/test.tgz',
        manifest: {} as any,
        sourceType: 'tarball',
      };

      const result = await manager.verifyChecksum(pkg);
      expect(result).toBe(true);
    });
  });

  describe('verifyStructure()', () => {
    it('should pass when all required fields present', async () => {
      const pkg: UpgradePackage = {
        moduleId: 'test-module',
        version: '1.0.0',
        tier: 'extension',
        checksum: 'abc123',
        sourcePath: '/tmp/test.tgz',
        manifest: {
          moduleId: 'test-module',
          version: '1.0.0',
          tier: 'extension',
          checksum: 'abc123',
          files: [],
        },
        sourceType: 'tarball',
      };

      mockFs.existsSync.mockReturnValue(true);

      const result = await manager.verifyStructure(pkg);
      expect(result).toBe(true);
    });

    it('should fail when source file missing', async () => {
      const pkg: UpgradePackage = {
        moduleId: 'test-module',
        version: '1.0.0',
        tier: 'extension',
        checksum: 'abc123',
        sourcePath: '/tmp/test.tgz',
        manifest: {
          moduleId: 'test-module',
          version: '1.0.0',
          tier: 'extension',
          checksum: 'abc123',
          files: [],
        },
        sourceType: 'tarball',
      };

      mockFs.existsSync.mockReturnValue(false);

      const result = await manager.verifyStructure(pkg);
      expect(result).toBe(false);
    });
  });

  describe('verifyCompatibility()', () => {
    it('should pass when no compatibility constraints', async () => {
      const pkg: UpgradePackage = {
        moduleId: 'test-module',
        version: '1.0.0',
        tier: 'extension',
        checksum: 'abc123',
        sourcePath: '/tmp/test.tgz',
        manifest: {
          moduleId: 'test-module',
          version: '1.0.0',
          tier: 'extension',
          checksum: 'abc123',
          files: [],
        },
        sourceType: 'tarball',
      };

      const result = await manager.verifyCompatibility(pkg);
      expect(result.ok).toBe(true);
    });

    it('should fail when core version too old', async () => {
      const pkg: UpgradePackage = {
        moduleId: 'test-module',
        version: '1.0.0',
        tier: 'extension',
        checksum: 'abc123',
        sourcePath: '/tmp/test.tgz',
        manifest: {
          moduleId: 'test-module',
          version: '1.0.0',
          tier: 'extension',
          checksum: 'abc123',
          files: [],
          minCoreVersion: '5.0.0',
        },
        sourceType: 'tarball',
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ version: '3.0.0' }));

      const result = await manager.verifyCompatibility(pkg);
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('Core version');
    });
  });

  // ==================== 缓存管理测试 ====================

  describe('cachePackage()', () => {
    it('should write checksum file to cache', async () => {
      const pkg: UpgradePackage = {
        moduleId: 'test-module',
        version: '1.0.0',
        tier: 'extension',
        checksum: 'abc123',
        sourcePath: '/tmp/test.tgz',
        manifest: {} as any,
        sourceType: 'tarball',
      };

      await manager.cachePackage(pkg);

      expect(mockFs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('getCachedPackagePath()', () => {
    it('should return path when cached', () => {
      mockFs.existsSync.mockReturnValue(true);
      const path = manager.getCachedPackagePath('test-module', '1.0.0');
      expect(path).toContain('test-module');
    });

    it('should return null when not cached', () => {
      mockFs.existsSync.mockReturnValue(false);
      const path = manager.getCachedPackagePath('test-module', '1.0.0');
      expect(path).toBeNull();
    });
  });

  describe('clearModuleCache()', () => {
    it('should remove cache directory when exists', () => {
      mockFs.existsSync.mockReturnValue(true);
      manager.clearModuleCache('test-module');
      expect(mockFs.rmSync).toHaveBeenCalled();
    });

    it('should not throw when cache not exists', () => {
      mockFs.existsSync.mockReturnValue(false);
      manager.clearModuleCache('test-module');
      expect(mockFs.rmSync).not.toHaveBeenCalled();
    });
  });

  // ==================== 内部方法测试 ====================

  describe('isVersionCompatible()', () => {
    it('should return true when installed >= required', () => {
      const result = (manager as any).isVersionCompatible('3.5.0', '3.0.0');
      expect(result).toBe(true);
    });

    it('should return false when installed < required', () => {
      const result = (manager as any).isVersionCompatible('2.0.0', '3.0.0');
      expect(result).toBe(false);
    });

    it('should return true when equal', () => {
      const result = (manager as any).isVersionCompatible('3.0.0', '3.0.0');
      expect(result).toBe(true);
    });
  });
});
