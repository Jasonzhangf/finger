/**
 * E2E Compact 功能测试
 * 
 * 使用真实 session 数据验证 compact 功能
 */
import { RuntimeFacade } from '../src/runtime/runtime-facade.js';
import { SessionManager } from '../src/orchestration/session-manager.js';
import { EventBus } from '../src/runtime/event-bus.js';
import { readJsonLines } from '../src/runtime/context-ledger-memory-helpers.js';
import { resolveLedgerPath, resolveCompactMemoryPath } from '../src/runtime/context-ledger-memory-helpers.js';
import path from 'path';

async function main() {
  const testSessionId = 'hb-session-finger-system-agent-global';
  const testAgentId = 'finger-system-agent';
  const testMode = 'main';
  const rootDir = path.join(process.env.HOME || '/tmp', '.finger', 'sessions');

  console.log('[E2E] Starting compact test on real session:', testSessionId);

  // Step 1: Load SessionManager with real data
  const sessionManager = new SessionManager({ rootDir });
  const eventBus = new EventBus();
  const runtimeFacade = new RuntimeFacade({ sessionManager, eventBus });

  // Step 2: Check if session exists
  const session = sessionManager.getSession(testSessionId);
  if (!session) {
    console.error('[E2E] Session not found:', testSessionId);
    console.log('[E2E] Available sessions:', sessionManager.listSessions().map(s => s.id));
    process.exit(1);
  }

  console.log('[E2E] Session found:', {
    id: session.id,
    totalTokens: session.totalTokens,
    latestCompactIndex: session.latestCompactIndex,
    originalStartIndex: session.originalStartIndex,
    originalEndIndex: session.originalEndIndex,
  });

  // Step 3: Check ledger file exists
  const ledgerPath = resolveLedgerPath(rootDir, testSessionId, testAgentId, testMode);
  const ledgerEntries = await readJsonLines(ledgerPath);
  console.log('[E2E] Ledger entries count:', ledgerEntries.length);

  // Step 4: Check if compact-memory.jsonl exists
  const compactPath = resolveCompactMemoryPath(rootDir, testSessionId, testAgentId, testMode);
  try {
    const existingCompact = await readJsonLines(compactPath);
    console.log('[E2E] Existing compact-memory entries:', existingCompact.length);
  } catch {
    console.log('[E2E] No existing compact-memory.jsonl (will be created)');
  }

  // Step 5: Trigger compact (manual)
  console.log('[E2E] Triggering compact with trigger=manual...');
  
  const startTime = Date.now();
  try {
    const summary = await runtimeFacade.compressContext(testSessionId, { trigger: 'manual' });
    const duration = Date.now() - startTime;
    
    console.log('[E2E] Compact completed in', duration, 'ms');
    console.log('[E2E] Summary length:', summary.length);
    console.log('[E2E] Summary preview:', summary.slice(0, 200));
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('[E2E] Compact failed after', duration, 'ms:', error);
    process.exit(1);
  }

  // Step 6: Verify compact-memory.jsonl created
  const compactEntries = await readJsonLines(compactPath);
  console.log('[E2E] Compact-memory entries after compression:', compactEntries.length);
  
  if (compactEntries.length > 0) {
    const lastEntry = compactEntries[compactEntries.length - 1];
    console.log('[E2E] Last compact_block entry:', {
      event_type: lastEntry.event_type,
      summary: lastEntry.payload?.summary?.slice(0, 100),
      source_range: lastEntry.payload?.source_range,
    });
  } else {
    console.error('[E2E] No compact_block entries found in compact-memory.jsonl');
    process.exit(1);
  }

  // Step 7: Verify context_compact event written to ledger
  const ledgerEntriesAfter = await readJsonLines(ledgerPath);
  console.log('[E2E] Ledger entries after compression:', ledgerEntriesAfter.length);

  const contextCompactEvent = ledgerEntriesAfter.find(e => e.event_type === 'context_compact');
  if (contextCompactEvent) {
    console.log('[E2E] context_compact event found:', {
      trigger: contextCompactEvent.payload?.trigger,
      summary: contextCompactEvent.payload?.summary?.slice(0, 100),
      compaction_id: contextCompactEvent.payload?.compaction_id,
    });
  } else {
    console.error('[E2E] No context_compact event found in ledger');
    process.exit(1);
  }

  // Step 8: Verify session pointers updated
  const sessionAfter = sessionManager.getSession(testSessionId)!;
  console.log('[E2E] Session pointers after compression:', {
    latestCompactIndex: sessionAfter.latestCompactIndex,
    originalStartIndex: sessionAfter.originalStartIndex,
    totalTokens: sessionAfter.totalTokens,
  });

  console.log('[E2E] ✅ Compact test PASSED');
}

main().catch(console.error);
