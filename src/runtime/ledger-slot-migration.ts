import { promises as fs } from 'fs';
import { logger } from '../core/logger.js';

const log = logger.module('ledger-slot-migration');

/**
 * Migration: Add explicit slot_number to existing ledger entries.
 * 
 * Usage:
 *   node dist/runtime/ledger-slot-migration.js <ledger_dir>
 * 
 * Or call migrateLedgerSlots() from code.
 */
export async function migrateLedgerSlots(ledgerDir: string): Promise<{ files: number; entries: number }> {
  const files = await findLedgerFiles(ledgerDir);
  let totalEntries = 0;

  for (const file of files) {
    const result = await migrateSingleLedger(file);
    totalEntries += result.entries;
  }

  return { files: files.length, entries: totalEntries };
}

async function findLedgerFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  
  async function scan(currentDir: string): Promise<void> {
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = `${currentDir}/${entry.name}`;
        if (entry.isDirectory()) {
          await scan(fullPath);
        } else if (entry.name === 'context-ledger.jsonl' || entry.name === 'ledger.jsonl') {
          results.push(fullPath);
        }
      }
    } catch (err) {
      // Directory not accessible, skip
    }
  }

  await scan(dir);
  return results;
}

async function migrateSingleLedger(ledgerPath: string): Promise<{ path: string; entries: number }> {
  log.info('[migrateLedger] Processing ledger file', { path: ledgerPath });

  try {
    const content = await fs.readFile(ledgerPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    
    const newLines: string[] = [];
    let changed = false;
    let slotNum = 0;

    for (const line of lines) {
      slotNum++;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (!('slot_number' in entry)) {
          entry.slot_number = slotNum;
          changed = true;
        }
        newLines.push(JSON.stringify(entry));
      } catch {
        // Invalid JSON, keep as-is
        newLines.push(line);
      }
    }

    if (changed) {
      await fs.writeFile(ledgerPath, newLines.join('\n') + '\n', 'utf-8');
      log.info('[migrateLedger] Updated entries with explicit slot_number', {
        path: ledgerPath,
        entryCount: slotNum,
      });
    } else {
      log.info('[migrateLedger] Ledger already has slot_number', {
        path: ledgerPath,
        entryCount: slotNum,
      });
    }

    return { path: ledgerPath, entries: slotNum };
  } catch (err) {
    log.error('[migrateLedger] Failed to process ledger', err as Error, { path: ledgerPath });
    return { path: ledgerPath, entries: 0 };
  }
}

// CLI entry point
if (process.argv[1].includes('ledger-slot-migration')) {
  const ledgerDir = process.argv[2] || process.env.HOME + '/.finger';
  migrateLedgerSlots(ledgerDir)
    .then(result => {
      console.log('Migration complete:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
