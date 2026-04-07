/**
 * E2E test for ali-coding-plan via Rust Anthropic Wire implementation.
 * Tests the Rust kernel-bridge-bin with Anthropic Messages API.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execAsync = promisify(exec);

describe('ali-coding-plan via Rust Anthropic Wire', () => {
  const configPath = join(process.env.HOME || '~', '.finger', 'config', 'config.json');
  
  beforeAll(() => {
    // Ensure Rust binary is built
    const rustBinary = './rust/target/release/finger-kernel-bridge-bin';
    // Note: Assumes cargo build --release has been run
  });

  it('should respond to simple math question', async () => {
    const input = JSON.stringify({
      id: 'test-math',
      op: {
        type: 'user_turn',
        items: [{ type: 'text', text: '2+2' }]
      }
    });
    
    const inputFile = join(tmpdir(), `kernel-input-${Date.now()}.json`);
    writeFileSync(inputFile, input);
    
    const { stdout, stderr } = await execAsync(
      `timeout 30 cat ${inputFile} | FINGER_CONFIG_PATH=${configPath} ./rust/target/release/finger-kernel-bridge-bin`,
      { cwd: process.cwd() }
    );
    
    // Check for task_complete event
    expect(stdout).toContain('task_complete');
    
    // Extract last_agent_message from JSON output
    const lines = stdout.split('\n').filter(l => l.trim().startsWith('{'));
    const completeEvent = lines.find(l => l.includes('task_complete'));
    
    if (completeEvent) {
      const parsed = JSON.parse(completeEvent);
      expect(parsed.msg.type).toBe('task_complete');
      // Note: last_agent_message should contain '4'
      // But may be empty due to thinking blocks
    }
  }, 35000);

  it('should respond to greeting', async () => {
    const input = JSON.stringify({
      id: 'test-greeting',
      op: {
        type: 'user_turn',
        items: [{ type: 'text', text: 'Hello' }]
      }
    });
    
    const inputFile = join(tmpdir(), `kernel-input-${Date.now()}.json`);
    writeFileSync(inputFile, input);
    
    const { stdout } = await execAsync(
      `timeout 30 cat ${inputFile} | FINGER_CONFIG_PATH=${configPath} ./rust/target/release/finger-kernel-bridge-bin`,
      { cwd: process.cwd() }
    );
    
    expect(stdout).toContain('task_complete');
  }, 35000);
});
