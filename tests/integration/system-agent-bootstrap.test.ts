import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, unlinkSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { FINGER_PATHS } from '../../src/core/finger-paths.js';
import { SYSTEM_AGENT_CONFIG } from '../../src/agents/finger-system-agent/index.js';

const BOOTSTRAP_PATH = join(FINGER_PATHS.home, 'system', 'BOOTSTRAP.md');
const BACKUP_PATH = join(FINGER_PATHS.home, 'system', 'BOOTSTRAP.md.backup');

describe('System Agent Bootstrap Integration', () => {
  let originalBootstrap: string | null = null;

  beforeAll(() => {
    // Ensure system directory exists
    mkdirSync(join(FINGER_PATHS.home, 'system'), { recursive: true });
    // Backup original bootstrap file
    if (existsSync(BOOTSTRAP_PATH)) {
      originalBootstrap = readFileSync(BOOTSTRAP_PATH, 'utf-8');
      writeFileSync(BACKUP_PATH, originalBootstrap, 'utf-8');
    }

    // Write test bootstrap
    const testBootstrap = `# Test Bootstrap
你已经启动，请进行开机检查：
1) 读取测试 HEARTBEAT.md
2) 检查测试 MEMORY.md
3) 汇总状态并询问用户`;
    writeFileSync(BOOTSTRAP_PATH, testBootstrap, 'utf-8');
  });

  afterAll(() => {
    // Restore original bootstrap
    if (originalBootstrap !== null) {
      writeFileSync(BOOTSTRAP_PATH, originalBootstrap, 'utf-8');
    }
    if (existsSync(BACKUP_PATH)) {
      unlinkSync(BACKUP_PATH);
    }
  });

  it('bootstrap file exists and contains required content', () => {
    expect(existsSync(BOOTSTRAP_PATH)).toBe(true);
    const content = readFileSync(BOOTSTRAP_PATH, 'utf-8');
    expect(content).toContain('开机检查');
    expect(content).toContain('HEARTBEAT.md');
  });

  it('system agent config has correct paths', () => {
    expect(SYSTEM_AGENT_CONFIG.id).toBe('finger-system-agent');
    expect(SYSTEM_AGENT_CONFIG.projectPath).toContain('/system');
    expect(SYSTEM_AGENT_CONFIG.sessionPath).toContain('/system/sessions');
  });

  it('bootstrap content is non-empty', () => {
    const content = readFileSync(BOOTSTRAP_PATH, 'utf-8');
    expect(content.trim().length).toBeGreaterThan(0);
  });

  // Note: Full integration test requires running daemon
  // This test validates static configuration only
});
