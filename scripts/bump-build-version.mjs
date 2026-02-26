import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageJsonPath = resolve(process.cwd(), 'package.json');
const raw = readFileSync(packageJsonPath, 'utf8');
const pkg = JSON.parse(raw);

if (typeof pkg.version !== 'string' || pkg.version.trim().length === 0) {
  throw new Error('package.json version is missing');
}

const semverMatch = pkg.version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
if (!semverMatch) {
  throw new Error(`unsupported package.json version format: ${pkg.version}`);
}

const major = semverMatch[1];
const minor = semverMatch[2];
const currentBuild = typeof pkg.fingerBuildVersion === 'string' ? pkg.fingerBuildVersion.trim() : '';
const buildMatch = currentBuild.match(/^(\d+)\.(\d+)\.(\d{4,})$/);

let nextBuildCounter = 1;
if (buildMatch && buildMatch[1] === major && buildMatch[2] === minor) {
  nextBuildCounter = Number.parseInt(buildMatch[3], 10) + 1;
}

pkg.fingerBuildVersion = `${major}.${minor}.${String(nextBuildCounter).padStart(4, '0')}`;

writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log(`[build] fingerBuildVersion -> ${pkg.fingerBuildVersion}`);
