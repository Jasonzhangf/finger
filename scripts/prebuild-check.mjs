#!/usr/bin/env node
/**
 * Prebuild check - Ensures no untracked files are left in the working tree
 * Run before compilation to enforce clean git hygiene
 */

import { execSync } from 'child_process';
import process from 'process';

const ALLOWED_PATTERNS = [
  // These files/directories are allowed to be untracked
  /^\.beads\//,
  /^scripts\/prebuild-check\.mjs$/, // self
];

function getUntrackedFiles() {
  const output = execSync('git status --porcelain', { encoding: 'utf-8' });
  const lines = output.trim().split('\n').filter(Boolean);

  // Filter only untracked files (??)
  return lines
    .filter(line => line.startsWith('??'))
    .map(line => line.substring(3).trim());
}

function isAllowed(filepath) {
  return ALLOWED_PATTERNS.some(pattern => pattern.test(filepath));
}

const MAX_FILE_LINES = 500;

function countLines(filePath) {
  try {
    const content = execSync(`cat '${filePath}'`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

function getTrackedSourceFiles() {
  const output = execSync('git ls-files', { encoding: 'utf-8' });
  const files = output.trim().split('\n').filter(Boolean);
  return files.filter((f) => (
    (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.mjs'))
    && f.startsWith('src/server/')
  ));
}

function checkFileLineLimits() {
  const files = getTrackedSourceFiles();
  const violations = [];
  for (const file of files) {
    const lines = countLines(file);
    if (lines > MAX_FILE_LINES) {
      violations.push({ file, lines });
    }
  }
  return violations;
}

function main() {
  const untracked = getUntrackedFiles();
  const blocked = untracked.filter(f => !isAllowed(f));

  const lineLimitViolations = checkFileLineLimits();

  if (lineLimitViolations.length > 0) {
    console.error('\n❌ Prebuild check failed: File line limit exceeded (max 500 lines)\n');
    console.error('The following files exceed the line limit and must be refactored:\n');
    for (const { file, lines } of lineLimitViolations) {
      console.error(`  - ${file} (${lines} lines, +${lines - MAX_FILE_LINES} over limit)`);
    }
    console.error('\nPlease split these files into smaller modules following the project architecture guidelines.');
    process.exit(1);
  }

  if (blocked.length > 0) {
    console.error('\n❌ Prebuild check failed: Untracked files detected\n');
    console.error('The following files must be either:');
    console.error('  - Added to git (git add <file>)');
    console.error('  - Added to .gitignore');
    console.error('  - Deleted\n');
    console.error('Blocked files:');
    blocked.forEach(f => console.error(`  - ${f}`));
    console.error('\nRun: git status');
    process.exit(1);
  }

  console.log('✓ Prebuild check passed: no untracked files blocking build');
  process.exit(0);
}

main();
