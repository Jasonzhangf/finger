/**
 * Tests for Assertion Engine
 * Task: finger-280.7
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { 
  AssertionEngine, 
  AssertionHelpers,
  TestScenarioRunner,
  type TestReport,
  type AssertionResult,
  type EventTimelineEntry
} from './assertion-engine';

describe('AssertionEngine', () => {
  let engine: AssertionEngine;
  
  beforeEach(() => {
    engine = new AssertionEngine({});
  });
  
  afterEach(() => {
    engine.reset();
  });
  
  describe('lifecycle', () => {
    it('should start correctly', () => {
      engine.start('test-scenario');
      expect(engine.getAssertions()).toHaveLength(0);
      expect(engine.getTimeline()).toHaveLength(1); // test_started event
    });
    
    it('should clear history on start', () => {
      engine.start('test-1');
      engine.reset();
      
      engine.start('test-2');
      expect(engine.getAssertions()).toHaveLength(0);
    });
  });
  
  describe('waitForCondition', () => {
    it('should pass when condition is met', async () => {
      engine.start('test-scenario');
      
      let counter = 0;
      const result = await engine.waitForCondition(
        'counter_increment',
        () => counter++ > 0,
        1000
      );
      
      expect(result.passed).toBe(true);
      expect(engine.getTimeline().length).toBeGreaterThan(0);
    });
    
    it('should fail when condition is not met within timeout', async () => {
      engine.start('test-scenario');
      
      const result = await engine.waitForCondition(
        'always_false',
        () => false,
        100
      );
      
      expect(result.passed).toBe(false);
      expect(result.error).toContain('Timeout');
    });
  });
  
  describe('assertion history', () => {
    it('should track assertions', async () => {
      engine.start('test-scenario');
      
      const result = await engine.waitForCondition(
        'immediate_true',
        () => true,
        100
      );
      
      expect(result.passed).toBe(true);
      
      const history = engine.getAssertions();
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].name).toBe('immediate_true');
      expect(history[0].passed).toBe(true);
    });
  });
  
  describe('report generation', () => {
    it('should generate JSON report', async () => {
      engine.start('test-scenario');
      
      await engine.waitForCondition('test_condition', () => true, 100);
      
      const report = engine.generateReport(
        'test-scenario',
        'test-prompt'
      );
      
      expect(report.scenario).toBe('test-scenario');
      expect(report.prompt).toBe('test-prompt');
      expect(report.startedAt).toBeGreaterThan(0);
      expect(report.completedAt).toBeGreaterThan(0);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof report.passed).toBe('boolean');
      expect(Array.isArray(report.assertions)).toBe(true);
      expect(Array.isArray(report.timeline)).toBe(true);
    });
    
    it('should generate human-readable report', async () => {
      engine.start('test-scenario');
      
      const report = engine.generateReport(
        'test-scenario',
        'test-prompt'
      );
      
      const humanReadable = engine.formatHumanReadableReport(report);
      expect(humanReadable).toContain('Test Report');
      expect(humanReadable).toContain('test-scenario');
      expect(humanReadable).toContain('test-prompt');
    });
  });
});
