#!/usr/bin/env node
/**
 * Daemon Restart Script - runs daemon-guard in foreground
 */
const { execSync } = require('child_process');
const path = require('path');

const FINGER_ROOT = path.resolve(__dirname, '..');

console.log('[Restart] Restarting daemon...');
execSync(`node ${path.join(__dirname, 'daemon-stop.cjs')}`, { stdio: 'inherit' });
execSync(`node ${path.join(__dirname, 'daemon-guard.cjs')}`, { stdio: 'inherit' });
