import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_APP_VERSION = '0.1.0';
let cachedVersion: string | null = null;

interface VersionPackageJson {
  version?: unknown;
  fingerBuildVersion?: unknown;
}

export function getFingerAppVersion(): string {
  if (cachedVersion) return cachedVersion;

  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = resolve(currentDir, '../../package.json');
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as VersionPackageJson;

    if (typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
      cachedVersion = pkg.version.trim();
      return cachedVersion;
    }
    if (typeof pkg.fingerBuildVersion === 'string' && pkg.fingerBuildVersion.trim().length > 0) {
      cachedVersion = pkg.fingerBuildVersion.trim();
      return cachedVersion;
    }
  } catch {
    // Ignore and fallback to default version.
  }

  return DEFAULT_APP_VERSION;
}
