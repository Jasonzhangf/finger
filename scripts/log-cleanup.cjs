#!/usr/bin/env node
/**
 * Finger logs cleanup helper
 *
 * Usage:
 *   node scripts/log-cleanup.cjs
 *   node scripts/log-cleanup.cjs --all
 *   node scripts/log-cleanup.cjs --dry-run
 *   node scripts/log-cleanup.cjs --keep-days 7 --keep-finger-files 12 --keep-daemon-archives 8
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

function resolveFingerHome() {
  const override = process.env.FINGER_HOME;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return path.join(os.homedir(), '.finger');
}

function parseIntOpt(argv, key, fallback) {
  const idx = argv.indexOf(key);
  if (idx < 0 || idx + 1 >= argv.length) return fallback;
  const value = Number.parseInt(argv[idx + 1], 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function toTimestamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function safeUnlink(filePath, dryRun) {
  if (dryRun) return true;
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const dryRun = argv.includes('--dry-run');
  const keepDays = parseIntOpt(argv, '--keep-days', 7);
  const keepFingerFiles = parseIntOpt(argv, '--keep-finger-files', 12);
  const keepDaemonArchives = parseIntOpt(argv, '--keep-daemon-archives', 8);

  const fingerHome = resolveFingerHome();
  const logsDir = path.join(fingerHome, 'logs');
  const errorsamplesDir = path.join(logsDir, 'errorsamples');
  const nowMs = Date.now();
  const keepAgeMs = keepDays * 24 * 60 * 60 * 1000;
  const currentFingerLog = `finger-${new Date().toISOString().split('T')[0]}.log`;

  const summary = {
    mode: all ? 'all' : 'safe',
    dryRun,
    logsDir,
    removed: [],
    kept: [],
    errors: [],
  };

  const topFiles = listFiles(logsDir).filter((filePath) => safeStat(filePath)?.isFile());

  // 1) finger-*.log: keep newest N + keep today's file
  const fingerLogs = topFiles
    .filter((filePath) => /^finger-.*\.log$/.test(path.basename(filePath)))
    .map((filePath) => ({ filePath, stat: safeStat(filePath) }))
    .filter((item) => !!item.stat)
    .sort((a, b) => (b.stat.mtimeMs - a.stat.mtimeMs));

  for (let i = 0; i < fingerLogs.length; i += 1) {
    const { filePath, stat } = fingerLogs[i];
    const base = path.basename(filePath);
    const shouldKeepByCount = i < Math.max(1, keepFingerFiles);
    const shouldKeepByDate = base === currentFingerLog;
    const tooOld = nowMs - stat.mtimeMs > keepAgeMs;
    const shouldRemove = all
      ? !shouldKeepByDate
      : (!shouldKeepByCount || tooOld) && !shouldKeepByDate;
    if (shouldRemove) {
      if (safeUnlink(filePath, dryRun)) summary.removed.push(filePath);
      else summary.errors.push(`Failed to remove ${filePath}`);
    } else {
      summary.kept.push(filePath);
    }
  }

  // 2) daemon archive logs: daemon-*.log (exclude daemon.log)
  const daemonArchives = topFiles
    .filter((filePath) => /^daemon-.*\.log$/.test(path.basename(filePath)))
    .map((filePath) => ({ filePath, stat: safeStat(filePath) }))
    .filter((item) => !!item.stat)
    .sort((a, b) => (b.stat.mtimeMs - a.stat.mtimeMs));
  for (let i = 0; i < daemonArchives.length; i += 1) {
    const { filePath, stat } = daemonArchives[i];
    const shouldKeepByCount = i < Math.max(1, keepDaemonArchives);
    const tooOld = nowMs - stat.mtimeMs > keepAgeMs;
    const shouldRemove = all ? true : (!shouldKeepByCount || tooOld);
    if (shouldRemove) {
      if (safeUnlink(filePath, dryRun)) summary.removed.push(filePath);
      else summary.errors.push(`Failed to remove ${filePath}`);
    } else {
      summary.kept.push(filePath);
    }
  }

  // 3) Snapshot files (optional cleanup)
  const snapshotFiles = topFiles.filter((filePath) => /^snapshot-.*\.json$/.test(path.basename(filePath)));
  for (const filePath of snapshotFiles) {
    const stat = safeStat(filePath);
    if (!stat) continue;
    const tooOld = nowMs - stat.mtimeMs > keepAgeMs;
    const shouldRemove = all || tooOld;
    if (shouldRemove) {
      if (safeUnlink(filePath, dryRun)) summary.removed.push(filePath);
      else summary.errors.push(`Failed to remove ${filePath}`);
    } else {
      summary.kept.push(filePath);
    }
  }

  // 4) script auxiliary logs (*.log excluding daemon.log + current finger + remaining daemon-*/finger-*)
  const auxiliaryLogs = topFiles.filter((filePath) => {
    const base = path.basename(filePath);
    if (base === 'daemon.log') return false;
    if (base === currentFingerLog) return false;
    if (/^finger-.*\.log$/.test(base)) return false;
    if (/^daemon-.*\.log$/.test(base)) return false;
    return base.endsWith('.log');
  });
  for (const filePath of auxiliaryLogs) {
    const stat = safeStat(filePath);
    if (!stat) continue;
    const tooOld = nowMs - stat.mtimeMs > keepAgeMs;
    const shouldRemove = all || tooOld;
    if (shouldRemove) {
      if (safeUnlink(filePath, dryRun)) summary.removed.push(filePath);
      else summary.errors.push(`Failed to remove ${filePath}`);
    } else {
      summary.kept.push(filePath);
    }
  }

  // 5) errorsamples/* cleanup
  const errorSampleFiles = listFiles(errorsamplesDir).filter((filePath) => safeStat(filePath)?.isFile());
  for (const filePath of errorSampleFiles) {
    const stat = safeStat(filePath);
    if (!stat) continue;
    const tooOld = nowMs - stat.mtimeMs > keepAgeMs;
    const shouldRemove = all || tooOld;
    if (shouldRemove) {
      if (safeUnlink(filePath, dryRun)) summary.removed.push(filePath);
      else summary.errors.push(`Failed to remove ${filePath}`);
    } else {
      summary.kept.push(filePath);
    }
  }

  // 6) daemon.log (safe mode doesn't delete; all mode truncates)
  const daemonLog = path.join(logsDir, 'daemon.log');
  if (safeStat(daemonLog)?.isFile() && all) {
    try {
      if (!dryRun) {
        const archivePath = path.join(logsDir, `daemon-${toTimestamp()}.log`);
        fs.copyFileSync(daemonLog, archivePath);
        fs.truncateSync(daemonLog, 0);
      }
      summary.removed.push(`${daemonLog} (truncated${dryRun ? ',dry-run' : ''})`);
    } catch (error) {
      summary.errors.push(`Failed to truncate daemon.log: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // de-dup lists
  summary.removed = Array.from(new Set(summary.removed));
  summary.kept = Array.from(new Set(summary.kept));
  summary.errors = Array.from(new Set(summary.errors));

  console.log(JSON.stringify({
    ...summary,
    removedCount: summary.removed.length,
    keptCount: summary.kept.length,
    errorCount: summary.errors.length,
  }, null, 2));

  process.exit(summary.errors.length > 0 ? 1 : 0);
}

main();

