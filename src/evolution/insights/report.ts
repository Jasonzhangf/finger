import type {
  UsageInsights,
  FailurePattern,
  SuccessPattern,
  ToolUsageStats,
  UserPreferencePattern,
  CostEstimation,
} from './types.js';

export interface ReportFormat {
  title: string;
  summary: string;
  sections: ReportSection[];
  generatedAt: string;
}

export interface ReportSection {
  title: string;
  items: string[];
}

/**
 * Format a UsageInsights object into a human-readable text report.
 */
export function formatInsightsReport(insights: UsageInsights): string {
  const lines: string[] = [];
  const dateStr = insights.generatedAt.toISOString().split('T')[0];

  lines.push(`# Insights Report (${dateStr})`);
  lines.push(`Period: last ${insights.periodDays} days`);
  lines.push('');

  // Failure patterns
  lines.push('## Failure Patterns');
  if (insights.failurePatterns.length === 0) {
    lines.push('  No recurring failure patterns detected.');
  } else {
    for (const p of insights.failurePatterns) {
      lines.push(`  [${p.id}] count=${p.count}`);
      lines.push(`    Root cause: ${p.rootCauseHypothesis}`);
      lines.push(`    Recommendation: ${p.recommendation}`);
      for (const ex of p.examples.slice(0, 2)) {
        lines.push(`    Example: ${ex.slice(0, 120)}`);
      }
      lines.push('');
    }
  }

  // Success patterns
  lines.push('## Success Patterns');
  if (insights.successPatterns.length === 0) {
    lines.push('  No recurring success patterns detected.');
  } else {
    for (const p of insights.successPatterns) {
      lines.push(`  [${p.id}] count=${p.count}`);
      lines.push(`    Pattern: ${p.reusablePattern.slice(0, 120)}`);
      lines.push('');
    }
  }

  // Tool usage
  lines.push('## Tool Usage');
  const toolStats = insights.toolUsageStats.sort(
    (a, b) => b.totalCalls - a.totalCalls,
  );
  if (toolStats.length === 0) {
    lines.push('  No tool usage data available.');
  } else {
    for (const t of toolStats.slice(0, 15)) {
      const pct = (t.successRate * 100).toFixed(1);
      lines.push(`  ${t.tool}: ${t.totalCalls} calls, ${pct}% success`);
    }
  }
  lines.push('');

  // User preferences
  lines.push('## User Intent Patterns');
  if (insights.userPreferences.length === 0) {
    lines.push('  No user preference patterns detected.');
  } else {
    for (const p of insights.userPreferences.slice(0, 10)) {
      lines.push(`  ${p.pattern}: ${p.frequency}x (confidence=${(p.confidence * 100).toFixed(0)}%)`);
    }
  }
  lines.push('');

  // Cost
  lines.push('## Cost Estimation');
  lines.push(`  Total tokens: ${insights.costEstimation.totalTokens.toLocaleString()}`);
  lines.push(`  Anomaly: ${insights.costEstimation.anomaly ? 'YES' : 'no'}`);
  if (Object.keys(insights.costEstimation.breakdown).length > 0) {
    for (const [key, val] of Object.entries(insights.costEstimation.breakdown)) {
      lines.push(`  ${key}: ${val.toLocaleString()} tokens`);
    }
  }
  lines.push('');

  // Recommendations
  lines.push('## Recommendations');
  if (insights.recommendations.length === 0) {
    lines.push('  No specific recommendations.');
  } else {
    for (let i = 0; i < insights.recommendations.length; i++) {
      lines.push(`  ${i + 1}. ${insights.recommendations[i]}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format insights as a structured JSON-compatible report object.
 */
export function formatInsightsJson(insights: UsageInsights): ReportFormat {
  const sections: ReportSection[] = [];

  sections.push({
    title: 'Failure Patterns',
    items: insights.failurePatterns.map(
      (p) => `[${p.id}] x${p.count}: ${p.rootCauseHypothesis} → ${p.recommendation}`,
    ),
  });

  sections.push({
    title: 'Success Patterns',
    items: insights.successPatterns.map(
      (p) => `[${p.id}] x${p.count}: ${p.reusablePattern.slice(0, 100)}`,
    ),
  });

  sections.push({
    title: 'Tool Usage',
    items: insights.toolUsageStats
      .sort((a, b) => b.totalCalls - a.totalCalls)
      .slice(0, 15)
      .map((t) => `${t.tool}: ${t.totalCalls} calls (${(t.successRate * 100).toFixed(1)}% success)`),
  });

  sections.push({
    title: 'Recommendations',
    items: insights.recommendations,
  });

  return {
    title: `Insights Report — ${insights.generatedAt.toISOString().split('T')[0]}`,
    summary: `${insights.failurePatterns.length} failure patterns, ${insights.successPatterns.length} success patterns over ${insights.periodDays} days`,
    sections,
    generatedAt: insights.generatedAt.toISOString(),
  };
}
