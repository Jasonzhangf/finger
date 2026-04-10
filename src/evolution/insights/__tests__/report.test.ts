import { describe, it, expect } from 'vitest';
import { formatInsightsReport, formatInsightsJson } from '../report.js';
import type { UsageInsights } from '../types.js';

const mockInsights: UsageInsights = {
  generatedAt: new Date('2026-04-09T00:00:00Z'),
  periodDays: 7,
  failurePatterns: [
    {
      id: 'fp-1',
      count: 5,
      examples: ['EPIPE error → stdin closed → retry'],
      recommendation: 'Detect EPIPE early',
      rootCauseHypothesis: 'stdin pipe closed by kernel',
    },
  ],
  successPatterns: [
    {
      id: 'sp-1',
      count: 3,
      examples: ['exec_command parallel → 60% faster'],
      reusablePattern: 'exec_command parallel query → 60% faster',
    },
  ],
  toolUsageStats: [
    { tool: 'exec_command', totalCalls: 50, successRate: 0.9 },
    { tool: 'apply_patch', totalCalls: 30, successRate: 0.8 },
  ],
  userPreferences: [
    { pattern: 'tool-optimization', frequency: 10, confidence: 0.8 },
  ],
  costEstimation: {
    totalTokens: 150_000,
    anomaly: true,
    breakdown: { 'gpt-4': 120_000, 'claude-3': 30_000 },
  },
  recommendations: [
    '[Failure x5] Detect EPIPE early',
    '[Cost Warning] 150,000 tokens exceeds 100k',
  ],
};

describe('formatInsightsReport', () => {
  it('formats a human-readable text report', () => {
    const report = formatInsightsReport(mockInsights);

    expect(report).toContain('Insights Report');
    expect(report).toContain('Failure Patterns');
    expect(report).toContain('fp-1');
    expect(report).toContain('EPIPE');
    expect(report).toContain('Success Patterns');
    expect(report).toContain('Tool Usage');
    expect(report).toContain('exec_command');
    expect(report).toContain('Cost Estimation');
    expect(report).toContain('150,000');
    expect(report).toContain('Recommendations');
  });

  it('handles empty insights gracefully', () => {
    const empty: UsageInsights = {
      generatedAt: new Date(),
      periodDays: 7,
      failurePatterns: [],
      successPatterns: [],
      toolUsageStats: [],
      userPreferences: [],
      costEstimation: { totalTokens: 0, anomaly: false, breakdown: {} },
      recommendations: [],
    };

    const report = formatInsightsReport(empty);
    expect(report).toContain('No recurring failure patterns');
    expect(report).toContain('No recurring success patterns');
    expect(report).toContain('No tool usage data');
    expect(report).toContain('No user preference patterns');
    expect(report).toContain('No specific recommendations');
  });
});

describe('formatInsightsJson', () => {
  it('produces a structured report object', () => {
    const report = formatInsightsJson(mockInsights);

    expect(report.title).toContain('Insights Report');
    expect(report.summary).toContain('1 failure patterns');
    expect(report.summary).toContain('1 success patterns');
    expect(report.sections.length).toBe(4);
    expect(report.generatedAt).toContain('2026-04-09');
  });

  it('formats failure sections correctly', () => {
    const report = formatInsightsJson(mockInsights);
    const failureSection = report.sections.find((s) => s.title === 'Failure Patterns');

    expect(failureSection).toBeDefined();
    expect(failureSection!.items[0]).toContain('fp-1');
    expect(failureSection!.items[0]).toContain('x5');
  });

  it('formats tool usage section', () => {
    const report = formatInsightsJson(mockInsights);
    const toolSection = report.sections.find((s) => s.title === 'Tool Usage');

    expect(toolSection).toBeDefined();
    expect(toolSection!.items[0]).toContain('exec_command');
    expect(toolSection!.items[0]).toContain('50 calls');
  });
});
