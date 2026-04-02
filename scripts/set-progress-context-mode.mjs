#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const arg = (process.argv[2] || '').trim().toLowerCase();
const mode = arg === 'dev' ? 'dev' : 'release';
const configPath = process.env.FINGER_PROGRESS_MONITOR_CONFIG_PATH
  ? path.resolve(process.env.FINGER_PROGRESS_MONITOR_CONFIG_PATH)
  : path.join(os.homedir(), '.finger', 'config', 'progress-monitor.json');

async function main() {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  let existing = {};
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    existing = JSON.parse(raw);
  } catch {
    existing = {};
  }
  const next = {
    ...(typeof existing === 'object' && existing !== null ? existing : {}),
    contextBreakdownMode: mode,
  };
  await fs.writeFile(configPath, JSON.stringify(next, null, 2), 'utf-8');
  process.stdout.write(`[set-progress-context-mode] contextBreakdownMode=${mode} -> ${configPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`[set-progress-context-mode] failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

