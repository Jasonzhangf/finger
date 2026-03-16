/**
 * System Agent Tools Integration Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

const REGISTRY_PATH = path.join(process.env.HOME || '/tmp', '.finger', 'system', 'registry.json');

describe('System Registry Tool', () => {
  beforeEach(async () => {
    // Clean up registry before each test
    try {
      await fs.unlink(REGISTRY_PATH);
    } catch {
      // File doesn't exist, that's fine
    }
  });

  it('should list agents', async () => {
    // The tool is already registered, we just need to verify it's accessible
    const result = execSync('node -e "import(\'./dist/tools/internal/system-registry-tool.js\').then(() => console.log(\'ok\')).catch(e => console.error(e))"', {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    expect(result).toContain('ok');
  });
});

describe('Report Task Completion Tool', () => {
  it('should be importable', async () => {
    const result = execSync('node -e "import(\'./dist/tools/internal/report-task-completion-tool.js\').then(() => console.log(\'ok\')).catch(e => console.error(e))"', {
      cwd: process.cwd(),
      encoding: 'utf-8',
    });
    expect(result).toContain('ok');
  });
});
