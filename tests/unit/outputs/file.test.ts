import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileOutput } from '../../../src/outputs/file.js';
import { createMessage } from '../../../src/core/schema.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('FileOutput', () => {
  let output: FileOutput;
  const testDir = path.join(os.tmpdir(), 'finger-output-test');
  const testFile = path.join(testDir, 'messages.log');

  beforeEach(async () => {
    output = new FileOutput('test-log', {
      path: testFile,
      format: 'jsonl'
    });
    await output.start();
  });

  afterEach(async () => {
    await output.stop();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('creates directory on start', () => {
    // FileOutput creates dir on start, file on first write
    expect(fs.existsSync(testDir)).toBe(true);
  });

  it('writes jsonl messages', async () => {
    const msg = createMessage('test', { text: 'hello' }, 'unit-test');
    
    await output.handle(msg);
    
    const content = fs.readFileSync(testFile, 'utf-8');
    const lines = content.trim().split('\n');
    
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('test');
    expect(parsed.payload).toEqual({ text: 'hello' });
  });

  it('appends multiple messages', async () => {
    await output.handle(createMessage('msg1', {}, 'test'));
    await output.handle(createMessage('msg2', {}, 'test'));

    const content = fs.readFileSync(testFile, 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines.length).toBe(2);
  });

  it('writes text format when configured', async () => {
    const textOutput = new FileOutput('text-log', {
      path: path.join(testDir, 'text.log'),
      format: 'text'
    });
    await textOutput.start();

    const msg = createMessage('cmd', { action: 'run' }, 'cli');
    await textOutput.handle(msg);

    const content = fs.readFileSync(path.join(testDir, 'text.log'), 'utf-8');
    expect(content).toContain('[20');  // ISO timestamp starts with year
    expect(content).toContain('cmd');
    expect(content).toContain('run');

    await textOutput.stop();
  });
});
