/**
 * Test Session Isolation Setup
 *
 * Ensures all tests use isolated FINGER_HOME to avoid polluting system sessions.
 * This file is imported by vitest globalSetup.
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync, existsSync } from 'fs';

let testFingerHome: string | null = null;

export function setup(): void {
  // Create isolated test FINGER_HOME
  testFingerHome = join(tmpdir(), `finger-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testFingerHome, { recursive: true });
  
  // Set environment variable
  process.env.FINGER_HOME = testFingerHome;
  process.env.NODE_ENV = 'test';
  
  console.log(`[Test Isolation] Using isolated FINGER_HOME: ${testFingerHome}`);
}

export function teardown(): void {
  // Clean up test FINGER_HOME
  if (testFingerHome && existsSync(testFingerHome)) {
    try {
      rmSync(testFingerHome, { recursive: true, force: true });
      console.log(`[Test Isolation] Cleaned up: ${testFingerHome}`);
    } catch (e) {
      console.warn(`[Test Isolation] Failed to cleanup: ${e}`);
    }
  }
  
  // Reset environment
  delete process.env.FINGER_HOME;
}

// Auto-setup when imported (for vitest globalSetup)
if (typeof globalThis !== 'undefined' && !process.env.FINGER_HOME) {
  setup();
}
