#!/usr/bin/env node
/**
 * Prebuild check - Ensures no untracked files are left in the working tree
 * Run before compilation to enforce clean git hygiene
 */

import { execSync } from 'child_process';
import process from 'process';

const ALLOWED_PATTERNS = [
  /^\.beads\//,
  /^scripts\/prebuild-check\.mjs$/,
];

function getUntrackedFiles() {
  const output = execSync('git status --porcelain', { encoding: 'utf-8' });
  const lines = output.trim().split('\n').filter(Boolean);
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

  // ── Backbone regression test gate (18 test files, ~190 tests) ──
  // These tests verify all core flows that must not break:
  //   1. Tool error handling: tools/execute returns HTTP 200 on errors
  //   2. Message hub: routeToOutput, meta injection, module routing
  //   3. Mailbox: system mailbox, inbox/outbox
  //   4. Agent status subscriber: session/agent registration
  //   5. Channel bridge: config loading, output
  //   6. System agent manager: bootstrap, lifecycle
  //   7. Default tools: shell.exec, exec_command, etc.
  //   8. Envelope: serialization, dispatch
  //   9. Agent runtime block
  //  10. Heartbeat: periodic check, status
  //  11. Runtime spec compliance
  //  12. Report task completion tool
  //  13. System registry tool
  //  14. AI provider config
  console.log('\n▸ Running backbone regression tests...');

  const BACKBONE_TESTS = [
    'tests/unit/server/tool-error-handling.test.ts',
    'tests/unit/orchestration/message-hub.test.ts',
    'tests/unit/server/mailbox.test.ts',
    'tests/unit/server/agent-status-subscriber.test.ts',
    'tests/unit/server/channel-bridge-loading.test.ts',
    'tests/unit/server/system-agent-manager.test.ts',
    'tests/unit/runtime/default-tools.test.ts',
    'tests/unit/bridges/envelope.test.ts',
    'tests/integration/bridges/channel-bridge-hub-integration.test.ts',
    // 'tests/unit/blocks/agent-runtime-block.test.ts', // requires port 9998, excluded to avoid EADDRINUSE
    'tests/integration/periodic-check-heartbeat.test.ts',
    'tests/integration/periodic-check-runtime.test.ts',
    'tests/integration/runtime-full-checklist.test.ts',
    'tests/unit/tools/internal/report-task-completion-tool.test.ts',
    'tests/unit/tools/internal/codex-update-plan-tool.test.ts',
    'tests/unit/tools/internal/system-registry-tool.test.ts',
    'tests/unit/server/ai-provider-config.test.ts',
    'tests/unit/server/heartbeat-scheduler-load-config.test.ts',
    // Logger: unified logging, module switch, snapshot mode
    'tests/unit/core/logger.test.ts',
  ];

  try {
    const testOutput = execSync(
      `npx vitest run ${BACKBONE_TESTS.join(' ')} --reporter=verbose 2>&1`,
      { encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 }
    );
    console.log(testOutput.trimEnd());
    console.log('✓ Backbone regression tests passed');
  } catch (err) {
    console.error('\n❌ Backbone regression tests failed - build blocked');
    console.error(err.stdout || '');
    console.error(err.stderr || '');
    process.exit(1);
  }

  process.exit(0);
}

main();
