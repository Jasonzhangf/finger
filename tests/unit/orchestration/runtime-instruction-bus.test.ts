import { describe, it, expect, beforeEach } from 'vitest';
import { runtimeInstructionBus } from '../../../src/orchestration/runtime-instruction-bus.js';

describe('RuntimeInstructionBus', () => {
  beforeEach(() => {
    // Clear any existing queues
    const ids = ['wf1', 'wf2', 'wf3'];
    ids.forEach(id => runtimeInstructionBus.consume(id));
  });

  it('pushes content to workflow queue', () => {
    runtimeInstructionBus.push('wf1', 'instruction 1');
    const result = runtimeInstructionBus.consume('wf1');
    expect(result).toContain('instruction 1');
  });

  it('ignores empty content', () => {
    runtimeInstructionBus.push('wf1', '   ');
    const result = runtimeInstructionBus.consume('wf1');
    expect(result).toHaveLength(0);
  });

  it('trims whitespace', () => {
    runtimeInstructionBus.push('wf2', '  trimmed instruction  ');
    const result = runtimeInstructionBus.consume('wf2');
    expect(result[0]).toBe('trimmed instruction');
  });

  it('consumes all and clears queue', () => {
    runtimeInstructionBus.push('wf3', 'a');
    runtimeInstructionBus.push('wf3', 'b');
    const first = runtimeInstructionBus.consume('wf3');
    expect(first).toEqual(['a', 'b']);
    const second = runtimeInstructionBus.consume('wf3');
    expect(second).toHaveLength(0);
  });

  it('returns empty array for unknown workflow', () => {
    const result = runtimeInstructionBus.consume('unknown-wf');
    expect(result).toHaveLength(0);
  });
});
