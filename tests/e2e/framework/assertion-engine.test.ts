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
} from './assertion-engine.js';
import { ResourceObserver } from '../observers/resource-observer.js';

describe('AssertionEngine', () => {
  let engine: AssertionEngine;
  
  beforeEach(() => {
    engine = new AssertionEngine({});
  });
  
  afterEach(() => {
    engine.clearHistory();
  });
  
  describe('lifecycle', () => {
    it('should start and stop correctly', () => {
      engine.start();
      expect(engine.getAssertionHistory()).toHaveLength(0);
      expect(engine.getEventTimeline()).toHaveLength(0);
      
      engine.stop();
      expect(engine.getAssertionHistory()).toHaveLength(0);
    });
    
    it('should clear history on start', () => {
      engine.start();
      engine.stop();
      
      engine.start(); // Should reset
      expect(engine.getAssertionHistory()).toHaveLength(0);
    });
  });
  
  describe('waitForCondition', () => {
    it('should pass when condition is met', async () => {
      engine.start();
      
      let counter = 0;
      await engine.waitForCondition(
        () => counter++ > 0,
        1000,
        'Counter should increment'
      );
      
      engine.stop();
      expect(engine.getEventTimeline().length).toBeGreaterThan(0);
    });
    
    it('should fail when condition is not met within timeout', async () => {
      engine.start();
      
      await expect(
        engine.waitForCondition(
          () => false,
          100,
          'Should timeout'
        )
      ).rejects.toThrow('Timeout');
      
      engine.stop();
    });
  });
  
  describe('assertion history', () => {
    it('should track assertions', async () => {
      engine.start();
      
      try {
        await engine.assertNoTimeout(
          () => true,
          100,
          'immediate_true'
        );
      } catch {
        // Ignore
      }
      
      engine.stop();
      
      const history = engine.getAssertionHistory();
      expect(history.length).toBeGreaterThan(0);
      expect(history[0].name).toContain('no_timeout');
      expect(history[0].passed).toBe(true);
    });
  });
  
  describe('report generation', () => {
    it('should generate JSON report', async () => {
      engine.start();
      
      try {
        await engine.waitForCondition(() => true, 100);
      } catch {
        // Ignore
      }
      
      const report = await engine.generateReport(
        'test-scenario',
        'test-prompt'
      );
      
      expect(report.scenarioName).toBe('test-scenario');
      expect(report.prompt).toBe('test-prompt');
      expect(report.startTime).toBeGreaterThan(0);
      expect(report.endTime).toBeGreaterThan(0);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof report.passed).toBe('boolean');
      expect(Array.isArray(report.assertionResults)).toBe(true);
      expect(Array.isArray(report.eventTimeline)).toBe(true);
    });
    
    it('should generate human-readable report', async () => {
      engine.start();
      
      const report = await engine.generateReport(
        'test-scenario',
        'test-prompt'
      );
      
      const humanReadable = engine.generateHumanReadableReport(report);
      expect(humanReadable).toContain('Test Report');
      expect(humanReadable).toContain('test-scenario');
      expect(humanReadable).toContain('test-prompt');
      expect(humanReadable).toContain('Status');
    });
  });
});

describe('AssertionHelpers', () => {
  let engine: AssertionEngine;
  let helpers: AssertionHelpers;
  
  beforeEach(() => {
    engine = new AssertionEngine({});
    helpers = new AssertionHelpers(engine);
    engine.start();
  });
  
  afterEach(() => {
    engine.stop();
  });
  
  describe('assertNoToolCallErrors', () => {
    it('should pass when no errors', async () => {
      await expect(helpers.assertNoToolCallErrors()).resolves.not.toThrow();
      
      const history = engine.getAssertionHistory();
      expect(history.some(a => a.name === 'no_tool_call_errors' && a.passed)).toBe(true);
    });
  });
  
  describe('assertEventSequence', () => {
    it('should pass for empty sequence', async () => {
      await expect(helpers.assertEventSequence([], 100)).resolves.not.toThrow();
    });
    
    it('should fail for non-existent sequence', async () => {
      await expect(
        helpers.assertEventSequence(['nonexistent_tool'], 100)
      ).rejects.toThrow('Timeout');
    });
  });
});
