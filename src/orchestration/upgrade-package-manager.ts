/**
 * UpgradePackageManager - 升级包管理器
 *
 * 职责：
 * 1. 从不同来源获取升级包（npm / tarball / URL）
 * 2. 校验升级包完整性（checksum / 结构 / 兼容性）
 * 3. 管理本地缓存
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, createReadStream } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { homedir } from 'node:os';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { logger } from '../core/logger.js';
import { moduleLayers, type ModuleTier } from './module-layers.js';

const log = logger.module('UpgradePackageManager');

export type PackageSource = 'npm' | 'tarball' | 'url';

export interface PackageManifest {
  moduleId: string;
  version: string;
  tier: ModuleTier;
  checksum: string;
  peerDependencies?: Record<string, string>;
  minCoreVersion?: string;
  files: string[];
}

export interface UpgradePackage {
  moduleId: string;
  version: string;
  tier: ModuleTier;
  checksum: string;
  sourcePath: string;
  manifest: PackageManifest;
  sourceType: PackageSource;
}

export interface PackageVerificationResult {
  ok: boolean;
  checksumOk: boolean;
  structureOk: boolean;
  compatibilityOk: boolean;
  errors: string[];
}

export class UpgradePackageManager {
  private readonly cacheBaseDir: string;

  constructor(cacheBaseDir?: string) {
    const root = cacheBaseDir || resolve(homedir(), '.finger', 'runtime', 'upgrade-cache');
    this.cacheBaseDir = root;
    mkdirSync(root, { recursive: true });
  }

  // ==================== 获取升级包 ====================

  /**
   * 从 npm registry 拉取指定版本
   */
  async fetchFromNpm(moduleId: string, version: string = 'latest'): Promise<UpgradePackage> {
    log.info('Fetching package from npm', { moduleId, version });

    const registryUrl = 'https://registry.npmjs.org';
    const tarballUrl = `${registryUrl}/${moduleId}/-/${moduleId}-${version}.tgz`;
    const manifestUrl = `${registryUrl}/${moduleId}/${version}`;

    // Download tarball
    const cacheDir = this.getModuleCacheDir(moduleId);
    const tarballPath = resolve(cacheDir, `${version}.tgz`);

    await this.downloadFile(tarballUrl, tarballPath);

    // Fetch manifest from npm (for metadata)
    const manifest = await this.fetchNpmManifest(manifestUrl, moduleId, version, tarballPath);

    return {
      moduleId,
      version,
      tier: manifest.tier,
      checksum: manifest.checksum,
      sourcePath: tarballPath,
      manifest,
      sourceType: 'npm',
    };
  }

  /**
   * 从本地 tarball 加载
   */
  async fetchFromTarball(tarballPath: string): Promise<UpgradePackage> {
    log.info('Loading package from local tarball', { tarballPath });

    if (!existsSync(tarballPath)) {
      throw new Error(`Tarball not found: ${tarballPath}`);
    }

    const resolvedPath = resolve(tarballPath);
    const manifest = await this.extractManifestFromTarball(resolvedPath);
    const moduleId = manifest.moduleId;
    const version = manifest.version;

    // Copy to cache
    const cacheDir = this.getModuleCacheDir(moduleId);
    const cachedPath = resolve(cacheDir, `${version}.tgz`);
    
    if (resolvedPath !== cachedPath) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cachedPath, readFileSync(resolvedPath));
    }

    return {
      moduleId,
      version,
      tier: manifest.tier,
      checksum: manifest.checksum,
      sourcePath: cachedPath,
      manifest,
      sourceType: 'tarball',
    };
  }

  /**
   * 从 URL 下载
   */
  async fetchFromUrl(url: string): Promise<UpgradePackage> {
    log.info('Downloading package from URL', { url });

    const cacheDir = this.getModuleCacheDir(this.extractModuleIdFromUrl(url));
    const filename = basename(url);
    const tarballPath = resolve(cacheDir, filename);

    await this.downloadFile(url, tarballPath);

    const manifest = await this.extractManifestFromTarball(tarballPath);
    const moduleId = manifest.moduleId;
    const version = manifest.version;

    return {
      moduleId,
      version,
      tier: manifest.tier,
      checksum: manifest.checksum,
      sourcePath: tarballPath,
      manifest,
      sourceType: 'url',
    };
  }

  // ==================== 校验升级包 ====================

  /**
   * 校验升级包完整性
   */
  async verifyPackage(pkg: UpgradePackage): Promise<PackageVerificationResult> {
    const errors: string[] = [];

    // 1. Structure verification first (cheapest, catches null manifest)
    const structureOk = await this.verifyStructure(pkg);
    if (!structureOk) {
      errors.push('Invalid package structure');
    }

    // 2. Checksum verification (only if structure OK)
    const checksumOk = structureOk ? await this.verifyChecksum(pkg) : false;
    if (!checksumOk) {
      errors.push('Checksum mismatch');
    }

    // 3. Compatibility verification
    const compatibilityResult = await this.verifyCompatibility(pkg);
    const compatibilityOk = compatibilityResult.ok;
    if (!compatibilityOk) {
      errors.push(compatibilityResult.reason || 'Incompatible dependencies');
    }

    return {
      ok: checksumOk && structureOk && compatibilityOk,
      checksumOk,
      structureOk,
      compatibilityOk,
      errors,
    };
  }

  /**
   * SHA256 checksum 校验
   */
  async verifyChecksum(pkg: UpgradePackage): Promise<boolean> {
    if (!pkg.checksum) {
      log.warn('No checksum specified, skipping verification', { moduleId: pkg.moduleId });
      return true; // Skip if no checksum specified
    }

    const hash = await this.computeFileHash(pkg.sourcePath);
    const expected = pkg.checksum.startsWith('sha256:') ? pkg.checksum.slice(7) : pkg.checksum;
    const actual = hash;

    log.info('Checksum verification', {
      moduleId: pkg.moduleId,
      expected: expected.slice(0, 16) + '...',
      actual: actual.slice(0, 16) + '...',
    });

    return expected === actual;
  }

  /**
   * 包结构校验
   */
  async verifyStructure(pkg: UpgradePackage): Promise<boolean> {
    // Check manifest exists
    if (!pkg.manifest) {
      log.error('Missing manifest', undefined, { moduleId: pkg.moduleId });
      return false;
    }

    // Required fields
    const required = ['moduleId', 'version', 'tier', 'checksum', 'files'];
    for (const field of required) {
      if (!(field in pkg.manifest)) {
        log.error('Missing required manifest field', undefined, { field, moduleId: pkg.moduleId });
        return false;
      }
    }

    // Check files exist in tarball (for now, just check tarball exists)
    if (!existsSync(pkg.sourcePath)) {
      log.error('Source file not found', undefined, { path: pkg.sourcePath });
      return false;
    }

    return true;
  }

  /**
   * 依赖兼容性校验
   */
  async verifyCompatibility(pkg: UpgradePackage): Promise<{ ok: boolean; reason?: string }> {
    const manifest = pkg.manifest;
    if (!manifest) return { ok: false, reason: 'No manifest' };

    // Check minCoreVersion
    if (manifest.minCoreVersion) {
      const coreVersion = await this.getCurrentCoreVersion();
      if (!this.isVersionCompatible(coreVersion, manifest.minCoreVersion)) {
        return {
          ok: false,
          reason: `Core version ${coreVersion} < required ${manifest.minCoreVersion}`,
        };
      }
    }

    // Check peerDependencies
    if (manifest.peerDependencies) {
      for (const [dep, versionRange] of Object.entries(manifest.peerDependencies)) {
        const installedVersion = await this.getInstalledVersion(dep);
        if (installedVersion && !this.isVersionCompatible(installedVersion, versionRange)) {
          return {
            ok: false,
            reason: `Dependency ${dep} ${installedVersion} not compatible with ${versionRange}`,
          };
        }
      }
    }

    return { ok: true };
  }

  // ==================== 缓存管理 ====================

  /**
   * 缓存升级包（已自动缓存在 fetch 时完成）
   */
  async cachePackage(pkg: UpgradePackage): Promise<void> {
    const cacheDir = this.getModuleCacheDir(pkg.moduleId);
    mkdirSync(cacheDir, { recursive: true });

    const checksumPath = resolve(cacheDir, `${pkg.version}.sha256`);
    writeFileSync(checksumPath, pkg.checksum, 'utf-8');

    log.info('Package cached', { moduleId: pkg.moduleId, version: pkg.version });
  }

  /**
   * 获取缓存的包路径
   */
  getCachedPackagePath(moduleId: string, version: string): string | null {
    const cacheDir = this.getModuleCacheDir(moduleId);
    const tarballPath = resolve(cacheDir, `${version}.tgz`);
    if (existsSync(tarballPath)) {
      return tarballPath;
    }
    return null;
  }

  /**
   * 清理指定模块的缓存
   */
  clearModuleCache(moduleId: string): void {
    const cacheDir = this.getModuleCacheDir(moduleId);
    if (existsSync(cacheDir)) {
      rmSync(cacheDir, { recursive: true, force: true });
      log.info('Module cache cleared', { moduleId });
    }
  }

  // ==================== 内部方法 ====================

  private getModuleCacheDir(moduleId: string): string {
    return resolve(this.cacheBaseDir, moduleId);
  }

  private async downloadFile(url: string, destPath: string): Promise<void> {
    mkdirSync(resolve(destPath, '..'), { recursive: true });
    
    // Use fetch for downloading
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    writeFileSync(destPath, buffer);

    log.info('File downloaded', { url, size: buffer.length });
  }

  private async fetchNpmManifest(url: string, moduleId: string, version: string, tarballPath: string): Promise<PackageManifest> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        log.warn('Failed to fetch npm manifest, using defaults', { url });
      } else {
        const data = await response.json();
        return this.buildManifestFromNpmResponse(data, moduleId, version, tarballPath);
      }
    } catch (error) {
      log.warn('Failed to fetch npm manifest, using defaults', { error });
    }

    // Fallback: generate minimal manifest
    return this.generateMinimalManifest(moduleId, version, tarballPath);
  }

  private async extractManifestFromTarball(tarballPath: string): Promise<PackageManifest> {
    // For now, read package.json from tarball (simplified)
    // In production, would use tar package to extract manifest.json
    const checksum = await this.computeFileHash(tarballPath);
    
    // Try to read manifest.json from tarball
    // Simplified: generate from package.json if exists
    return this.generateMinimalManifest(
      this.extractModuleIdFromPath(tarballPath),
      '0.0.0',
      tarballPath,
      checksum
    );
  }

  private buildManifestFromNpmResponse(data: any, moduleId: string, version: string, tarballPath: string): PackageManifest {
    const checksum = data.dist?.shasum || '';
    return {
      moduleId,
      version: data.version || version,
      tier: 'extension',
      checksum: data.dist?.integrity?.replace('sha512-', '') || checksum,
      peerDependencies: data.peerDependencies,
      minCoreVersion: data.finger?.minCoreVersion,
      files: [],
    };
  }

  private generateMinimalManifest(moduleId: string, version: string, tarballPath: string, checksum?: string): PackageManifest {
    return {
      moduleId,
      version,
      tier: 'extension',
      checksum: checksum || '',
      files: [],
    };
  }

  private extractModuleIdFromUrl(url: string): string {
    // Extract from URL path
    const parts = url.split('/');
    const filename = parts[parts.length - 1];
    return filename.replace(/-\d+\.\d+\.\d+\.tgz$/, '').replace(/\.tgz$/, '');
  }

  private extractModuleIdFromPath(path: string): string {
    const name = basename(path);
    return name.replace(/-\d+\.\d+\.\d+\.tgz$/, '').replace(/\.tgz$/, '');
  }

  private async computeFileHash(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    
    return hash.digest('hex');
  }

  private async getCurrentCoreVersion(): Promise<string> {
    // Read from package.json or runtime state
    try {
      const pkgPath = resolve(process.cwd(), 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        return pkg.version || '0.0.0';
      }
    } catch (error) {
      log.warn('Failed to read core version', { error });
    }
    return '0.0.0';
  }

  private async getInstalledVersion(moduleId: string): Promise<string | null> {
    // Read from module slots or registry
    // For now, return null (will be implemented with module registry)
    return null;
  }

  private isVersionCompatible(installed: string, required: string): boolean {
    // Simple version comparison (>=)
    // In production, use semver package
    const parse = (v: string) => v.split('.').map(Number);
    const a = parse(installed);
    const b = parse(required);
    
    for (let i = 0; i < 3; i++) {
      if (a[i] > b[i]) return true;
      if (a[i] < b[i]) return false;
    }
    return true;
  }
}
