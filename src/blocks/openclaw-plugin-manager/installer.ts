/**
 * OpenClaw Plugin Installer
 * Supports npm, local, and git installation
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { PluginSource, InstallPluginResult, OpenClawPluginManifest } from './types.js';
import { loadPluginManifest, parsePackageJsonExtensions, resolvePluginEntries } from './manifest.js';

export type InstallOptions = {
  pluginDir: string;
  source: PluginSource;
  force?: boolean;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
};

const defaultLogger = {
  info: (msg: string) => console.log('[PluginInstaller] INFO: ' + msg),
  warn: (msg: string) => console.warn('[PluginInstaller] WARN: ' + msg),
  error: (msg: string) => console.error('[PluginInstaller] ERROR: ' + msg),
};

/**
 * Install plugin from npm spec
 */
export async function installFromNpm(
  spec: string,
  targetDir: string,
  options: InstallOptions
): Promise<InstallPluginResult> {
  const logger = options.logger || defaultLogger;

  try {
    logger.info?.('Installing plugin from npm: ' + spec);

    const tempDir = path.join(targetDir, '.temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const packOutput = execSync('npm pack ' + spec + ' --pack-destination="' + tempDir + '"', {
      encoding: 'utf-8',
      cwd: tempDir,
    }).trim();

    const tarball = path.join(tempDir, packOutput);
    logger.info?.('Downloaded tarball: ' + tarball);

    execSync('tar -xf "' + tarball + '" -C "' + tempDir + '"', { cwd: tempDir });

    const packageDir = path.join(tempDir, 'package');
    const packageJsonPath = path.join(packageDir, 'package.json');
    const extResult = parsePackageJsonExtensions(packageJsonPath);

    if (!extResult.ok) {
      return { ok: false, error: extResult.error, code: 'missing_extensions' };
    }

    const entries = resolvePluginEntries(packageDir, extResult.extensions);
    if (entries.missing.length > 0) {
      logger.warn?.('Missing plugin entries: ' + entries.missing.join(', '));
    }

    const manifestResult = loadPluginManifest(packageDir);
    let manifest: OpenClawPluginManifest;

    if (!manifestResult.ok) {
      const pkgContent = fs.readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(pkgContent);

      manifest = {
        id: extResult.pluginId,
        name: pkg.name,
        description: pkg.description,
        version: pkg.version,
      };

      fs.writeFileSync(
        path.join(packageDir, 'openclaw.plugin.json'),
        JSON.stringify(manifest, null, 2)
      );
    } else {
      manifest = manifestResult.manifest;
    }

    const finalDir = path.join(targetDir, safeDirName(manifest.id));
    if (fs.existsSync(finalDir) && !options.force) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return {
        ok: false,
        error: 'Plugin already installed: ' + manifest.id + '. Use --force to reinstall.',
        code: 'already_installed',
      };
    }

    if (fs.existsSync(finalDir)) {
      fs.rmSync(finalDir, { recursive: true, force: true });
    }

    fs.renameSync(packageDir, finalDir);
    fs.rmSync(tempDir, { recursive: true, force: true });

    logger.info?.('Plugin installed: ' + manifest.id + ' at ' + finalDir);

    return {
      ok: true,
      pluginId: manifest.id,
      targetDir: finalDir,
      version: manifest.version,
      manifest,
    };
  } catch (err) {
    return {
      ok: false,
      error: 'npm install failed: ' + String(err),
      code: 'npm_error',
    };
  }
}

/**
 * Install plugin from local path
 */
export async function installFromLocal(
  localPath: string,
  targetDir: string,
  options: InstallOptions
): Promise<InstallPluginResult> {
  const logger = options.logger || defaultLogger;

  try {
    const resolvedPath = path.resolve(localPath);

    if (!fs.existsSync(resolvedPath)) {
      return { ok: false, error: 'Path not found: ' + resolvedPath, code: 'path_not_found' };
    }

    logger.info?.('Installing plugin from local: ' + resolvedPath);

    const manifestResult = loadPluginManifest(resolvedPath);
    let manifest: OpenClawPluginManifest;

    if (!manifestResult.ok) {
      const packageJsonPath = path.join(resolvedPath, 'package.json');
      if (!fs.existsSync(packageJsonPath)) {
        return {
          ok: false,
          error: 'No openclaw.plugin.json or package.json found',
          code: 'no_manifest',
        };
      }

      const extResult = parsePackageJsonExtensions(packageJsonPath);
      if (!extResult.ok) {
        return { ok: false, error: extResult.error, code: 'missing_extensions' };
      }

      const pkgContent = fs.readFileSync(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(pkgContent);

      manifest = {
        id: extResult.pluginId,
        name: pkg.name,
        description: pkg.description,
        version: pkg.version,
      };
    } else {
      manifest = manifestResult.manifest;
    }

    const finalDir = path.join(targetDir, safeDirName(manifest.id));

    if (fs.existsSync(finalDir) && !options.force) {
      return {
        ok: false,
        error: 'Plugin already installed: ' + manifest.id + '. Use --force to reinstall.',
        code: 'already_installed',
      };
    }

    if (fs.existsSync(finalDir)) {
      fs.rmSync(finalDir, { recursive: true, force: true });
    }

    fs.symlinkSync(resolvedPath, finalDir, 'junction');

    logger.info?.('Plugin linked: ' + manifest.id + ' -> ' + finalDir);

    return {
      ok: true,
      pluginId: manifest.id,
      targetDir: finalDir,
      version: manifest.version,
      manifest,
    };
  } catch (err) {
    return {
      ok: false,
      error: 'local install failed: ' + String(err),
      code: 'local_error',
    };
  }
}

/**
 * Install plugin from git repository
 */
export async function installFromGit(
  gitUrl: string,
  targetDir: string,
  options: InstallOptions
): Promise<InstallPluginResult> {
  const logger = options.logger || defaultLogger;

  try {
    logger.info?.('Installing plugin from git: ' + gitUrl);

    const tempDir = path.join(targetDir, '.temp-git');
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });

    execSync('git clone --depth 1 "' + gitUrl + '" .', {
      cwd: tempDir,
      stdio: 'pipe',
    });

    const manifestResult = loadPluginManifest(tempDir);
    if (!manifestResult.ok) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return { ok: false, error: manifestResult.error, code: 'manifest_error' };
    }

    const manifest = manifestResult.manifest;
    const finalDir = path.join(targetDir, safeDirName(manifest.id));
    if (fs.existsSync(finalDir) && !options.force) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return {
        ok: false,
        error: 'Plugin already installed: ' + manifest.id + '. Use --force to reinstall.',
        code: 'already_installed',
      };
    }

    if (fs.existsSync(finalDir)) {
      fs.rmSync(finalDir, { recursive: true, force: true });
    }

    fs.renameSync(tempDir, finalDir);

    logger.info?.('Plugin installed: ' + manifest.id + ' at ' + finalDir);

    return {
      ok: true,
      pluginId: manifest.id,
      targetDir: finalDir,
      version: manifest.version,
      manifest,
    };
  } catch (err) {
    return {
      ok: false,
      error: 'git install failed: ' + String(err),
      code: 'git_error',
    };
  }
}

/**
 * Main install function
 */
export async function installPlugin(options: InstallOptions): Promise<InstallPluginResult> {
  const { source, pluginDir } = options;

  if (!fs.existsSync(pluginDir)) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }

  switch (source.type) {
    case 'npm':
      return installFromNpm(source.spec, pluginDir, options);
    case 'local':
      return installFromLocal(source.path, pluginDir, options);
    case 'git':
      return installFromGit(source.url, pluginDir, options);
    default:
      return { ok: false, error: 'Unknown source type' };
  }
}

function safeDirName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]/g, '_');
}
