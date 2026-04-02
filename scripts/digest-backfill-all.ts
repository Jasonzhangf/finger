import { promises as fs } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { executeContextLedgerMemory } from '../src/runtime/context-ledger-memory.js';

interface TargetLedger {
  rootDir: string;
  sessionId: string;
  agentId: string;
  mode: string;
  ledgerPath: string;
}

function resolveDefaultRoots(): string[] {
  const fingerHome = process.env.FINGER_HOME?.trim() || join(homedir(), '.finger');
  return [fingerHome];
}

function parseArgs(argv: string[]): {
  roots: string[];
  action: 'digest_backfill' | 'digest_incremental';
  limit?: number;
} {
  const roots: string[] = [];
  let action: 'digest_backfill' | 'digest_incremental' = 'digest_backfill';
  let limit: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root' && typeof argv[index + 1] === 'string') {
      roots.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === '--action' && typeof argv[index + 1] === 'string') {
      const next = argv[index + 1].trim();
      if (next === 'digest_backfill' || next === 'digest_incremental') {
        action = next;
      }
      index += 1;
      continue;
    }
    if (arg === '--limit' && typeof argv[index + 1] === 'string') {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
      index += 1;
    }
  }

  return {
    roots: roots.length > 0 ? roots : resolveDefaultRoots(),
    action,
    limit,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function discoverLedgers(root: string): Promise<string[]> {
  const ledgers: string[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > 8) return;
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }> = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isFile() && entry.name === 'context-ledger.jsonl') {
        ledgers.push(fullPath);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return ledgers;
}

function resolveTargetLedger(ledgerPath: string): TargetLedger | null {
  const modeDir = dirname(ledgerPath);
  const agentDir = dirname(modeDir);
  const sessionDir = dirname(agentDir);
  const rootDir = dirname(sessionDir);

  const mode = basename(modeDir).trim();
  const agentId = basename(agentDir).trim();
  const sessionId = basename(sessionDir).trim();

  if (!mode || !agentId || !sessionId || !rootDir) return null;
  return { rootDir, sessionId, agentId, mode, ledgerPath };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const targets: TargetLedger[] = [];

  for (const root of args.roots) {
    const normalizedRoot = root.trim();
    if (!normalizedRoot) continue;
    if (!(await pathExists(normalizedRoot))) continue;
    const ledgers = await discoverLedgers(normalizedRoot);
    for (const ledgerPath of ledgers) {
      const target = resolveTargetLedger(ledgerPath);
      if (target) targets.push(target);
    }
  }

  const uniqueTargets = Array.from(
    new Map(targets.map((target) => [`${target.rootDir}::${target.sessionId}::${target.agentId}::${target.mode}`, target])).values(),
  );

  const limitedTargets = typeof args.limit === 'number'
    ? uniqueTargets.slice(0, args.limit)
    : uniqueTargets;

  let okCount = 0;
  let failCount = 0;
  let totalDigestCount = 0;

  for (const target of limitedTargets) {
    try {
      const result = await executeContextLedgerMemory({
        action: args.action,
        _runtime_context: {
          root_dir: target.rootDir,
          session_id: target.sessionId,
          agent_id: target.agentId,
          mode: target.mode,
        },
      });

      const taskDigestCount = typeof (result as Record<string, unknown>).task_digest_count === 'number'
        ? Math.max(0, Math.floor((result as Record<string, unknown>).task_digest_count as number))
        : 0;
      totalDigestCount += taskDigestCount;
      okCount += 1;
      // eslint-disable-next-line no-console
      console.log(`[OK] ${target.sessionId}/${target.agentId}/${target.mode} | action=${result.action} | task_digest_count=${taskDigestCount}`);
    } catch (error) {
      failCount += 1;
      // eslint-disable-next-line no-console
      console.log(`[FAIL] ${target.sessionId}/${target.agentId}/${target.mode} | ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\nBackfill summary: targets=${limitedTargets.length}, ok=${okCount}, fail=${failCount}, total_task_digests=${totalDigestCount}, action=${args.action}`);
}

void main();
