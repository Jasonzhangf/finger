import fs from 'fs';
import path from 'path';

const LOG_DIR = '/Volumes/extension/code/finger/logs';
const SNAPSHOT_DIR = path.join(LOG_DIR, 'snapshots');

// Ensure directories exist
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

export interface Snapshot {
  timestamp: string;
  agentId: string;
  iteration: number;
  phase: string;
  input: unknown;
  output: unknown;
  duration?: number;
  error?: string;
}

export class SnapshotLogger {
  private agentId: string;
  private logFile: string;

  constructor(agentId: string) {
    this.agentId = agentId;
    this.logFile = path.join(LOG_DIR, `${agentId}.jsonl`);
  }

  log(snapshot: Omit<Snapshot, 'agentId'>): void {
    const fullSnapshot: Snapshot = {
      ...snapshot,
      agentId: this.agentId,
    };
    
    // Append to JSONL
    fs.appendFileSync(this.logFile, JSON.stringify(fullSnapshot) + '\n');
    
    // Also save detailed snapshot file
    const snapshotFile = path.join(SNAPSHOT_DIR, `${this.agentId}-${snapshot.timestamp}-${snapshot.phase}.json`);
    fs.writeFileSync(snapshotFile, JSON.stringify(fullSnapshot, null, 2));
  }

  getRecentSnapshots(limit = 10): Snapshot[] {
    if (!fs.existsSync(this.logFile)) return [];
    
    const lines = fs.readFileSync(this.logFile, 'utf-8').trim().split('\n');
    return lines
      .slice(-limit)
      .map(line => JSON.parse(line) as Snapshot);
  }
}

export function createSnapshotLogger(agentId: string): SnapshotLogger {
  return new SnapshotLogger(agentId);
}
