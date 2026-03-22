/**
 * Finger Core Daemon - Snapshot Manager
 * 
 * Saves registry state to disk every 30s if dirty
 */

import fs from 'fs';
import path from 'path';
import { FINGER_PATHS } from './finger-paths.js';
import type { Registry } from './registry-new.js';
import { logger } from './logger.js';
import { createConsoleLikeLogger } from '../core/logger/console-like.js';

const clog = createConsoleLikeLogger('Snapshot');

const log = logger.module('Snapshot');

const FINGER_DIR = FINGER_PATHS.runtime.dir;
const SNAPSHOT_PATH = path.join(FINGER_DIR, 'snapshot.json');
const SNAPSHOT_INTERVAL = 30000; // 30 seconds

export class SnapshotManager {
  private lastHash: string = '';
  private dirty: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private registry: Registry,
    private path: string = SNAPSHOT_PATH
  ) {}

  start(): void {
    this.timer = setInterval(() => this.tick(), SNAPSHOT_INTERVAL);
    log.info('Started (interval: 30s)');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Final save
    this.tick();
    log.info('Stopped');
  }

  markDirty(): void {
    this.dirty = true;
  }

  private tick(): void {
    if (!this.dirty) return;

    const snapshot = this.registry.toSnapshot();
    (snapshot as Record<string, unknown>)['savedAt'] = Date.now();

    const content = JSON.stringify(snapshot, null, 2);
    const hash = this.simpleHash(content);

    if (hash !== this.lastHash) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.writeFileSync(this.path, content, 'utf-8');
      this.lastHash = hash;
      this.dirty = false;
      clog.log('[Snapshot] Saved to', this.path);
    }
  }

  load(): { entries: unknown[]; routes: unknown[] } | null {
    try {
      if (fs.existsSync(this.path)) {
        const content = fs.readFileSync(this.path, 'utf-8');
        const snapshot = JSON.parse(content);
        this.lastHash = this.simpleHash(JSON.stringify(snapshot, null, 2));
        clog.log('[Snapshot] Loaded from', this.path);
        return snapshot;
      }
    } catch (err) {
      clog.error('[Snapshot] Load failed:', err);
    }
    return null;
  }

  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }
}
