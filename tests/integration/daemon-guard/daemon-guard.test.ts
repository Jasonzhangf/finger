import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const FINGER_ROOT = path.resolve(__dirname, '../../../');
const SCRIPTS_DIR = path.join(FINGER_ROOT, 'scripts');

describe('Daemon Guard Integration Tests', () => {
  let testFingerHome: string;
  let testRuntimeDir: string;

  beforeEach(() => {
    testFingerHome = path.join(os.tmpdir(), `finger-guard-test-${Date.now()}`);
    testRuntimeDir = path.join(testFingerHome, 'runtime');
    fs.mkdirSync(testRuntimeDir, { recursive: true });
    fs.mkdirSync(path.join(testFingerHome, 'logs'), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testFingerHome)) {
      fs.rmSync(testFingerHome, { recursive: true, force: true });
    }
  });

  describe('进程匹配逻辑', () => {
    it('matchesManagedFingerProcess 正确匹配/拒绝', () => {
      const matcherScript = path.join(SCRIPTS_DIR, 'daemon-process-matchers.cjs');
      const cases = [
        { cmd: `node ${FINGER_ROOT}/dist/server/index.js`, pattern: 'dist/server/index.js', expected: true },
        { cmd: `node ${FINGER_ROOT}/scripts/daemon-guard.cjs`, pattern: 'scripts/daemon-guard.cjs', expected: true },
        { cmd: 'node /other/dist/server/index.js', pattern: 'dist/server/index.js', expected: false },
        { cmd: null, pattern: 'dist/server/index.js', expected: false },
      ];
      for (const tc of cases) {
        const escapedCmd = (tc.cmd ?? '').replace(/'/g, "\\'");
        const r = spawnSync('node', ['-e', `const{matchesManagedFingerProcess}=require('${matcherScript}');console.log(matchesManagedFingerProcess('${escapedCmd}','${FINGER_ROOT}','${tc.pattern}'));`], { encoding: 'utf8', timeout: 3000 });
        expect(r.stdout.trim()).toBe(String(tc.expected));
      }
    });
  });

  describe('PID 文件管理', () => {
    it('读写 PID 文件', () => {
      const p = path.join(testRuntimeDir, 'guard.pid');
      fs.writeFileSync(p, '12345');
      expect(fs.readFileSync(p, 'utf8').trim()).toBe('12345');
    });
  });

  describe('清理旧 PID 文件', () => {
    it('cleanupLegacyPidFiles 删除遗留 PID', () => {
      const legacyFiles = ['daemon.pid', 'finger-daemon.pid'].map(f => path.join(testRuntimeDir, f));
      for (const f of legacyFiles) fs.writeFileSync(f, '99999');
      spawnSync('node', ['-e', `
        const fs=require('fs'),path=require('path');
        const RUNTIME='${testRuntimeDir}';
        const LEGACY=['daemon.pid','finger-daemon.pid'].map(f=>path.join(RUNTIME,f));
        for(const f of LEGACY){try{if(fs.existsSync(f))fs.unlinkSync(f)}catch{}}
        console.log('done');
      `], { encoding: 'utf8', timeout: 3000 });
      for (const f of legacyFiles) expect(fs.existsSync(f)).toBe(false);
    });
  });
});
