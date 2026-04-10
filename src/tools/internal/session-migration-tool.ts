/**
 * Session Migration Tool - 一次性迁移工具
 * 
 * 用途：扫描所有 session 目录，规范化路径，重建缺失/损坏的 ledger 数据
 * 执行后可移除所有 compat/fallback 代码
 * 
 * 执行方式：node --import tsx src/tools/internal/session-migration-tool.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { FINGER_PATHS } from '../../core/finger-paths.js';

const SESSIONS_DIR = FINGER_PATHS.sessions.dir;
const SYSTEM_SESSIONS_DIR = path.join(FINGER_PATHS.home, 'system', 'sessions');

// ───────────────────────────────────────────────────────────────
// Phase 1: 目录规范化
// ───────────────────────────────────────────────────────────────

interface SessionDirectoryInfo {
  originalPath: string;
  normalizedProjectKey: string;
  sessionId: string;
  isTemporary: boolean;
  isSystem: boolean;
  needsMigration: boolean;
  mainJsonPath?: string;
  ledgerPaths: string[];
}

function scanSessionDirectories(): SessionDirectoryInfo[] {
  const results: SessionDirectoryInfo[] = [];
  
  if (!fs.existsSync(SESSIONS_DIR)) {
    console.log('[Migration] Sessions directory does not exist:', SESSIONS_DIR);
    return results;
  }
  
  const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    const dirName = entry.name;
    const fullPath = path.join(SESSIONS_DIR, dirName);
    
    // Skip temporary directories
    const isTemporary = dirName.startsWith('_tmp_') || dirName.startsWith('_private_tmp_');
    if (isTemporary) {
      results.push({
        originalPath: fullPath,
        normalizedProjectKey: '',
        sessionId: dirName,
        isTemporary: true,
        isSystem: false,
        needsMigration: false,
        ledgerPaths: [],
      });
      continue;
    }
    
    // System session
    const isSystem = dirName.startsWith('hb-session-finger-system-agent') || dirName.startsWith('system-');
    
    // Normalize project key
    const normalizedProjectKey = normalizeProjectKey(dirName);
    
    // Find main.json
    const mainJsonPath = findMainJson(fullPath);
    
    // Find ledger files
    const ledgerPaths = findLedgerFiles(fullPath);
    
    // Check if needs migration
    const needsMigration = !isSystem && (
      dirName !== normalizedProjectKey ||
      ledgerPaths.length === 0 ||
      !mainJsonPath
    );
    
    results.push({
      originalPath: fullPath,
      normalizedProjectKey,
      sessionId: dirName,
      isTemporary,
      isSystem,
      needsMigration,
      mainJsonPath,
      ledgerPaths,
    });
  }
  
  return results;
}

function normalizeProjectKey(dirName: string): string {
  // hb-session-finger-project-agent-xxx -> xxx
  if (dirName.startsWith('hb-session-finger-project-agent-')) {
    return dirName.replace('hb-session-finger-project-agent-', '');
  }
  
  // _Volumes_extension_code_finger -> finger
  // _Users_fanzhang_xxx -> xxx
  if (dirName.startsWith('_')) {
    // Try to extract project name from path-like structure
    const parts = dirName.split('_').filter(p => p.length > 0);
    
    // If ends with something that looks like a project name
    if (parts.length >= 2) {
      // Common patterns
      if (parts.includes('finger')) return 'finger';
      if (parts.includes('webauto')) return 'webauto';
      
      // Use last meaningful segment
      const last = parts[parts.length - 1];
      if (last && !last.includes('json') && !last.includes('session')) {
        return last;
      }
      
      // Use combined key
      return parts.slice(-2).join('-');
    }
  }
  
  return dirName;
}

function findMainJson(dirPath: string): string | undefined {
  // Look for main.json in root or nested structure
  const direct = path.join(dirPath, 'main.json');
  if (fs.existsSync(direct)) return direct;
  
  // Look in nested session directories
  try {
    const subdirs = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const sub of subdirs) {
      if (!sub.isDirectory()) continue;
      
      const nested = path.join(dirPath, sub.name, 'main.json');
      if (fs.existsSync(nested)) return nested;
      
      // One more level
      const subsub = fs.readdirSync(path.join(dirPath, sub.name), { withFileTypes: true });
      for (const ss of subsub) {
        if (!ss.isDirectory()) continue;
        const deepNested = path.join(dirPath, sub.name, ss.name, 'main.json');
        if (fs.existsSync(deepNested)) return deepNested;
      }
    }
  } catch {}
  
  return undefined;
}

function findLedgerFiles(dirPath: string): string[] {
  const results: string[] = [];
  
  function scan(dir: string) {
    if (!fs.existsSync(dir)) return;
    
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(dir, e.name);
        
        if (e.isDirectory()) {
          scan(p);
        } else if (e.name === 'context-ledger.jsonl' || e.name === 'ledger.jsonl') {
          results.push(p);
        }
      }
    } catch {}
  }
  
  scan(dirPath);
  return results;
}

// ───────────────────────────────────────────────────────────────
// Phase 2: 数据统一
// ───────────────────────────────────────────────────────────────

interface SessionDataStatus {
  sessionPath: string;
  mainJsonValid: boolean;
  ledgerValid: boolean;
  compactValid: boolean;
  digestsValid: boolean;
  memoryOwnerSet: boolean;
  issues: string[];
  fixes: string[];
}

function analyzeSessionData(sessionDir: SessionDirectoryInfo): SessionDataStatus {
  const status: SessionDataStatus = {
    sessionPath: sessionDir.originalPath,
    mainJsonValid: false,
    ledgerValid: false,
    compactValid: false,
    digestsValid: false,
    memoryOwnerSet: false,
    issues: [],
    fixes: [],
  };
  
  // Check main.json
  if (sessionDir.mainJsonPath) {
    try {
      const content = fs.readFileSync(sessionDir.mainJsonPath, 'utf-8');
      const session = JSON.parse(content);
      
      status.mainJsonValid = true;
      
      // Check memoryOwner
      const ctx = session.context || {};
      status.memoryOwnerSet = typeof ctx.memoryOwnerWorkerId === 'string' && ctx.memoryOwnerWorkerId.length > 0;
      
      if (!status.memoryOwnerSet) {
        status.issues.push('Missing memoryOwnerWorkerId in context');
      }
      
      // Check ledgerPath in pointers
      const pointers = session.ledgerPointers || {};
      if (!pointers.ledgerPath || pointers.ledgerPath.length === 0) {
        status.issues.push('Missing ledgerPath in ledgerPointers');
      }
      
    } catch (err) {
      status.issues.push('main.json parse error: ' + (err instanceof Error ? err.message : String(err)));
    }
  } else {
    status.issues.push('main.json not found');
  }
  
  // Check ledger files
  if (sessionDir.ledgerPaths.length > 0) {
    for (const ledgerPath of sessionDir.ledgerPaths) {
      try {
        const content = fs.readFileSync(ledgerPath, 'utf-8');
        const lines = content.trim().split('\n');
        
        if (lines.length === 0) {
          status.issues.push('Empty ledger: ' + ledgerPath);
        } else {
          // Validate first line
          JSON.parse(lines[0]);
          status.ledgerValid = true;
        }
      } catch (err) {
        status.issues.push('Ledger parse error: ' + ledgerPath);
      }
    }
  } else {
    status.issues.push('No ledger files found');
  }
  
  // Check compact-memory.jsonl
  const compactPath = findCompactMemory(sessionDir.originalPath);
  if (compactPath) {
    try {
      const content = fs.readFileSync(compactPath, 'utf-8');
      const lines = content.trim().split('\n');
      
      if (lines.length > 0) {
        // Validate format - should have compactDigest: true
        const first = JSON.parse(lines[0]);
        const payload = first.payload || {};
        
        if (payload.compactDigest === true || (payload.metadata && payload.metadata.compactDigest === true)) {
          status.compactValid = true;
        } else {
          status.issues.push('compact-memory.jsonl missing compactDigest marker');
        }
      }
    } catch (err) {
      status.issues.push('compact-memory parse error');
    }
  }
  
  // Check task-digests.jsonl
  const digestsPath = findTaskDigests(sessionDir.originalPath);
  if (digestsPath) {
    try {
      const content = fs.readFileSync(digestsPath, 'utf-8');
      const lines = content.trim().split('\n');
      
      if (lines.length > 0) {
        JSON.parse(lines[0]);
        status.digestsValid = true;
      }
    } catch (err) {
      status.issues.push('task-digests parse error');
    }
  }
  
  return status;
}

function findCompactMemory(dirPath: string): string | undefined {
  function scan(dir: string): string | undefined {
    if (!fs.existsSync(dir)) return undefined;
    
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(dir, e.name);
        
        if (e.isDirectory()) {
          const found = scan(p);
          if (found) return found;
        } else if (e.name === 'compact-memory.jsonl') {
          return p;
        }
      }
    } catch {}
    return undefined;
  }
  
  return scan(dirPath);
}

function findTaskDigests(dirPath: string): string | undefined {
  function scan(dir: string): string | undefined {
    if (!fs.existsSync(dir)) return undefined;
    
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(dir, e.name);
        
        if (e.isDirectory()) {
          const found = scan(p);
          if (found) return found;
        } else if (e.name === 'task-digests.jsonl') {
          return p;
        }
      }
    } catch {}
    return undefined;
  }
  
  return scan(dirPath);
}

// ───────────────────────────────────────────────────────────────
// Phase 3: 清理
// ───────────────────────────────────────────────────────────���───

interface CleanupPlan {
  temporaryDirs: string[];
  emptyDirs: string[];
  expiredSessions: string[];
  duplicateSessions: Map<string, string[]>;
}

function planCleanup(sessionDirs: SessionDirectoryInfo[], ttlDays = 30): CleanupPlan {
  const plan: CleanupPlan = {
    temporaryDirs: [],
    emptyDirs: [],
    expiredSessions: [],
    duplicateSessions: new Map(),
  };
  
  const cutoffMs = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const projectKeyMap = new Map<string, string[]>();
  
  for (const dir of sessionDirs) {
    // Temporary directories to delete
    if (dir.isTemporary) {
      plan.temporaryDirs.push(dir.originalPath);
      continue;
    }
    
    // Empty directories
    try {
      const contents = fs.readdirSync(dir.originalPath);
      if (contents.length === 0) {
        plan.emptyDirs.push(dir.originalPath);
        continue;
      }
    } catch {
      plan.emptyDirs.push(dir.originalPath);
      continue;
    }
    
    // Expired sessions
    if (dir.mainJsonPath) {
      try {
        const content = fs.readFileSync(dir.mainJsonPath, 'utf-8');
        const session = JSON.parse(content);
        
        const lastAccess = session.lastAccessedAt || session.updatedAt || session.createdAt;
        if (lastAccess) {
          const lastMs = new Date(lastAccess).getTime();
          if (lastMs < cutoffMs && !dir.isSystem) {
            plan.expiredSessions.push(dir.originalPath);
          }
        }
      } catch {
        // Invalid session, mark for cleanup
        plan.expiredSessions.push(dir.originalPath);
      }
    }
    
    // Track duplicates by project key
    if (dir.normalizedProjectKey && !dir.isSystem) {
      const existing = projectKeyMap.get(dir.normalizedProjectKey) || [];
      existing.push(dir.originalPath);
      projectKeyMap.set(dir.normalizedProjectKey, existing);
    }
  }
  
  // Find duplicates (same project key, multiple sessions)
  const entries = Array.from(projectKeyMap.entries());
  for (const entry of entries) {
    if (entry[1].length > 1) {
      plan.duplicateSessions.set(entry[0], entry[1]);
    }
  }
  
  return plan;
}

// ───────────────────────────────────────────────────────────────
// Phase 4: 数据修复
// ───────────────────────────────────────────────────────────────

interface FixAction {
  type: 'fix_ledger_pointer' | 'fix_memory_owner' | 'create_project_main' | 'cleanup_invalid_json';
  path: string;
  details: string;
  applied: boolean;
  error?: string;
}

function fixSessionData(sessionDir: SessionDirectoryInfo, options?: { dryRun?: boolean }): FixAction[] {
  const actions: FixAction[] = [];
  
  if (sessionDir.isTemporary || sessionDir.isSystem) return actions;
  
  // Fix 1: Create project-level main.json if missing but has session subdirs
  if (!sessionDir.mainJsonPath) {
    try {
      const subdirs = fs.readdirSync(sessionDir.originalPath, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('session-'));
      
      if (subdirs.length > 0) {
        let latestSession: string | undefined;
        let latestTime = 0;
        
        for (const sub of subdirs) {
          const subMain = path.join(sessionDir.originalPath, sub.name, 'main.json');
          if (fs.existsSync(subMain)) {
            try {
              const c = fs.readFileSync(subMain, 'utf-8');
              const session = JSON.parse(c);
              const time = session.createdAt ? new Date(session.createdAt).getTime() : 0;
              if (time > latestTime) {
                latestTime = time;
                latestSession = subMain;
              }
            } catch {}
          }
        }
        
        if (latestSession) {
          const projectMainPath = path.join(sessionDir.originalPath, 'main.json');
          
          actions.push({
            type: 'create_project_main',
            path: projectMainPath,
            details: 'Create project main.json',
            applied: false,
          });
          
          if (!options?.dryRun) {
            try {
              const projectSession = {
                id: sessionDir.sessionId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                status: 'active',
                messages: [],
                context: {
                  memoryOwnerWorkerId: 'finger-system-agent',
                  ownerAgentId: 'finger-system-agent',
                  memoryOwnershipVersion: 1,
                  memoryAccessPolicy: 'owner_only',
                },
                ledgerPointers: { ledgerPath: [], compactPath: [], indices: {} },
              };
              fs.writeFileSync(projectMainPath, JSON.stringify(projectSession, null, 2));
              actions[actions.length - 1].applied = true;
            } catch (err) {
              actions[actions.length - 1].error = err instanceof Error ? err.message : String(err);
            }
          }
        }
      }
    } catch {}
  }
  
  // Fix 2: Repair existing main.json
  if (sessionDir.mainJsonPath) {
    try {
      const content = fs.readFileSync(sessionDir.mainJsonPath, 'utf-8');
      const session = JSON.parse(content);
      let modified = false;
      
      const ctx = session.context || {};
      if (!ctx.memoryOwnerWorkerId) {
        ctx.memoryOwnerWorkerId = 'finger-system-agent';
        ctx.ownerAgentId = 'finger-system-agent';
        ctx.memoryOwnershipVersion = 1;
        ctx.memoryAccessPolicy = 'owner_only';
        session.context = ctx;
        modified = true;
        actions.push({ type: 'fix_memory_owner', path: sessionDir.mainJsonPath, details: 'Added memoryOwnerWorkerId', applied: false });
      }
      
      const ptrs = session.ledgerPointers || {};
      if (!ptrs.ledgerPath || ptrs.ledgerPath.length === 0) {
        const ledgerFiles = sessionDir.ledgerPaths;
        if (ledgerFiles.length > 0) {
          ptrs.ledgerPath = ledgerFiles;
          ptrs.compactPath = ledgerFiles.map(p => p.replace('context-ledger.jsonl', 'compact-memory.jsonl'));
          ptrs.indices = {};
          session.ledgerPointers = ptrs;
          modified = true;
          actions.push({ type: 'fix_ledger_pointer', path: sessionDir.mainJsonPath, details: 'Added ledgerPath pointers', applied: false });
        }
      }
      
      if (modified && !options?.dryRun) {
        try {
          fs.writeFileSync(sessionDir.mainJsonPath, JSON.stringify(session, null, 2));
          for (const a of actions) if (a.path === sessionDir.mainJsonPath) a.applied = true;
        } catch (err) {
          for (const a of actions) if (a.path === sessionDir.mainJsonPath) a.error = err instanceof Error ? err.message : String(err);
        }
      }
    } catch (err) {
      actions.push({ type: 'cleanup_invalid_json', path: sessionDir.mainJsonPath, details: 'Invalid JSON', applied: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  
  return actions;
}


// ───────────────────────────────────────────────────────────────
// 执行迁移
// ───────────────────────────────────────────────────────────────

interface MigrationReport {
  scanned: number;
  temporaryDeleted: number;
  emptyDeleted: number;
  expiredDeleted: number;
  duplicatesFound: number;
  dataIssues: number;
  fixesApplied: number;
  errors: string[];
  details: string[];
}

export async function runMigration(options?: { dryRun?: boolean; cleanup?: boolean }): Promise<MigrationReport> {
  const report: MigrationReport = {
    scanned: 0,
    temporaryDeleted: 0,
    emptyDeleted: 0,
    expiredDeleted: 0,
    duplicatesFound: 0,
    dataIssues: 0,
    fixesApplied: 0,
    errors: [],
    details: [],
  };
  
  console.log('[Migration] Starting session migration scan...');
  console.log('[Migration] Sessions directory:', SESSIONS_DIR);
  
  // Phase 1: Scan
  const sessionDirs = scanSessionDirectories();
  report.scanned = sessionDirs.length;
  console.log('[Migration] Found ' + sessionDirs.length + ' session directories');
  
  // Phase 2: Analyze data
  for (const dir of sessionDirs) {
    if (dir.isTemporary) continue;
    
    const status = analyzeSessionData(dir);
    
    if (status.issues.length > 0) {
      report.dataIssues++;
      report.details.push('[' + dir.sessionId + '] Issues: ' + status.issues.join(', '));
    }
    
    // Phase 2.5: Apply fixes
    const fixes = fixSessionData(dir, options);
    for (const fix of fixes) {
      if (fix.applied) {
        report.fixesApplied++;
        report.details.push('[Fix] ' + fix.type + ': ' + fix.details + ' on ' + fix.path);
      } else if (fix.error) {
        report.errors.push('Fix failed: ' + fix.type + ' on ' + fix.path + ' - ' + fix.error);
      }
    }
  }
  
  // Phase 3: Cleanup plan
  const cleanupPlan = planCleanup(sessionDirs);
  
  console.log('[Migration] Cleanup plan:');
  console.log('  - Temporary directories: ' + cleanupPlan.temporaryDirs.length);
  console.log('  - Empty directories: ' + cleanupPlan.emptyDirs.length);
  console.log('  - Expired sessions: ' + cleanupPlan.expiredSessions.length);
  console.log('  - Duplicate sessions: ' + cleanupPlan.duplicateSessions.size);
  
  report.duplicatesFound = cleanupPlan.duplicateSessions.size;
  
  // Execute cleanup if enabled
  if (options && options.cleanup && !options.dryRun) {
    // Delete temporary directories
    for (const tmpDir of cleanupPlan.temporaryDirs) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        report.temporaryDeleted++;
        report.details.push('[Cleanup] Deleted temporary: ' + tmpDir);
      } catch (err) {
        report.errors.push('Failed to delete ' + tmpDir);
      }
    }
    
    // Delete empty directories
    for (const emptyDir of cleanupPlan.emptyDirs) {
      try {
        fs.rmSync(emptyDir, { recursive: true, force: true });
        report.emptyDeleted++;
        report.details.push('[Cleanup] Deleted empty: ' + emptyDir);
      } catch (err) {
        report.errors.push('Failed to delete ' + emptyDir);
      }
    }
    
    // Delete expired sessions
    for (const expiredDir of cleanupPlan.expiredSessions) {
      try {
        fs.rmSync(expiredDir, { recursive: true, force: true });
        report.expiredDeleted++;
        report.details.push('[Cleanup] Deleted expired: ' + expiredDir);
      } catch (err) {
        report.errors.push('Failed to delete ' + expiredDir);
      }
    }
  }
  
  // Print duplicates for manual review
  if (cleanupPlan.duplicateSessions.size > 0) {
    console.log('\n[Migration] Duplicate sessions found (manual merge required):');
    const dupEntries = Array.from(cleanupPlan.duplicateSessions.entries());
    for (const entry of dupEntries) {
      console.log('  Project: ' + entry[0]);
      for (const p of entry[1]) {
        console.log('    - ' + p);
      }
    }
  }
  
  // Summary
  console.log('\n[Migration] Migration report:');
  console.log('  Scanned: ' + report.scanned);
  console.log('  Data issues: ' + report.dataIssues);
  console.log('  Fixes applied: ' + report.fixesApplied);
  console.log('  Duplicates: ' + report.duplicatesFound);
  if (options && options.cleanup) {
    console.log('  Temporary deleted: ' + report.temporaryDeleted);
    console.log('  Empty deleted: ' + report.emptyDeleted);
    console.log('  Expired deleted: ' + report.expiredDeleted);
  }
  console.log('  Errors: ' + report.errors.length);
  
  if (report.errors.length > 0) {
    console.log('\n[Migration] Errors:');
    for (const e of report.errors) {
      console.log('  - ' + e);
    }
  }
  
  return report;
}

// CLI entry point
const scriptPath = process.argv[1] || '';
if (scriptPath.includes('session-migration-tool')) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const cleanup = args.includes('--cleanup');
  
  runMigration({ dryRun, cleanup })
    .then(() => {
      console.log('\n[Migration] Complete.');
      if (dryRun) {
        console.log('[Migration] This was a dry run. Use --cleanup to execute.');
      }
    })
    .catch(err => {
      console.error('[Migration] Failed:', err);
      process.exit(1);
    });
}
