export interface LearningEntry {
  timestamp: Date;
  successes: string[];
  failures: string[];
  tags: string[];
  toolUsage: ToolUsageRecord[];
  sessionId: string;
}

export interface ToolUsageRecord {
  tool: string;
  args: string;
  status: 'success' | 'failure' | 'unknown';
}

export interface FailurePattern {
  id: string;
  count: number;
  examples: string[];
  recommendation: string;
  rootCauseHypothesis: string;
}

export interface SuccessPattern {
  id: string;
  count: number;
  examples: string[];
  reusablePattern: string;
}

export interface UserPreferencePattern {
  pattern: string;
  frequency: number;
  confidence: number;
}

export interface CostEstimation {
  totalTokens: number;
  anomaly: boolean;
  breakdown: Record<string, number>;
}

export interface ToolUsageStats {
  tool: string;
  totalCalls: number;
  successRate: number;
  avgDuration?: number;
}

export interface UsageInsights {
  generatedAt: Date;
  periodDays: number;
  failurePatterns: FailurePattern[];
  successPatterns: SuccessPattern[];
  toolUsageStats: ToolUsageStats[];
  userPreferences: UserPreferencePattern[];
  costEstimation: CostEstimation;
  recommendations: string[];
}

export interface LedgerEvent {
  id: string;
  timestamp: string;
  type: string;
  sessionId: string;
  agentId: string;
  data: Record<string, unknown>;
}

export interface InsightsEngineConfig {
  ledgerPath: string;
  lookbackDays: number;
  minPatternCount: number;
  similarityThreshold: number;
}
