/**
 * E2E test for Rust kernel Anthropic Wire protocol.
 *
 * Tests that the Rust binary can successfully route requests via WireApi::Anthropic.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';

interface KernelEvent {
  id: string;
  msg: {
    type: string;
    [key: string]: unknown;
  };
}

interface KernelSubmission {
  id: string;
  items: Array<{
    type: 'text' | 'image';
    text?: string;
    image_url?: string;
  }>;
  options?: {
    system_prompt?: string;
  };
}

describe('Rust Kernel - Anthropic Wire Protocol', () => {
  let kernelProcess: ChildProcess | null = null;
  let eventBuffer: KernelEvent[] = [];

  beforeAll(async () => {
    // Build the Rust binary
    const rustDir = resolve(import.meta.dirname, '../../../rust');
    const { execSync } = await import('child_process');
    execSync('cargo build --release', { cwd: rustDir, stdio: 'inherit' });

    // Spawn the kernel process
    const binaryPath = resolve(rustDir, 'target/release/finger-kernel-bridge-bin');
    
    kernelProcess = spawn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FINGER_CONFIG_PATH: resolve(process.env.HOME || '~', '.finger/config/config.json'),
      },
    });

    kernelProcess.stderr?.on('data', (data) => {
      console.log('[Kernel stderr]', data.toString());
    });

    kernelProcess.stdout?.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as KernelEvent;
          eventBuffer.push(event);
        } catch {
          // Ignore parse errors
        }
      }
    });

    // Wait for session configured event
    await new Promise<void>((resolve) => {
      const check = () => {
        if (eventBuffer.some(e => e.msg.type === 'session_configured')) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }, 60000);

  afterAll(() => {
    if (kernelProcess) {
      kernelProcess.kill();
      kernelProcess = null;
    }
  });

  it('should spawn with Anthropic Wire protocol (ali-coding-plan)', () => {
    const sessionConfigured = eventBuffer.find(e => e.msg.type === 'session_configured');
    expect(sessionConfigured).toBeDefined();
    console.log('[Test] Session configured:', sessionConfigured);
  });

  it('should handle a basic text submission', async () => {
    eventBuffer = []; // Clear buffer
    
    const submission: KernelSubmission = {
      id: 'test-001',
      items: [{ type: 'text', text: 'Hello, what is your name?' }],
    };

    kernelProcess?.stdin?.write(JSON.stringify(submission) + '\n');

    // Wait for task_started event
    await new Promise<void>((resolve) => {
      const check = () => {
        if (eventBuffer.some(e => e.msg.type === 'task_started')) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });

    const taskStarted = eventBuffer.find(e => e.msg.type === 'task_started');
    expect(taskStarted).toBeDefined();
    expect(taskStarted?.msg.submission_id).toBe('test-001');
  }, 30000);

  it('should complete a turn and return response', async () => {
    eventBuffer = []; // Clear buffer
    
    const submission: KernelSubmission = {
      id: 'test-002',
      items: [{ type: 'text', text: 'What is 2 + 2? Answer with just the number.' }],
    };

    kernelProcess?.stdin?.write(JSON.stringify(submission) + '\n');

    // Wait for task_complete event
    await new Promise<void>((resolve) => {
      const check = () => {
        if (eventBuffer.some(e => e.msg.type === 'task_complete')) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });

    const taskComplete = eventBuffer.find(e => e.msg.type === 'task_complete');
    expect(taskComplete).toBeDefined();
    expect(taskComplete?.msg.submission_id).toBe('test-002');
    
    // Check for model round events (text output)
    const modelRounds = eventBuffer.filter(e => e.msg.type === 'model_round');
    console.log('[Test] Model rounds:', modelRounds.length);
    
    // Should have some output
    const hasOutput = modelRounds.some(e => {
      const msg = e.msg as { output_text?: string };
      return msg.output_text && msg.output_text.trim().length > 0;
    });
    expect(hasOutput).toBe(true);
  }, 60000);
});
