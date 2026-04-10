/**
 * Topic Shift Confidence Window Gate Block
 * 
 * Implements multi-turn confidence gating for context rebuild decisions:
 * - Ring buffer storing last 3 turns' shift_confidence
 * - Rule Gate: >=2 of 3 turns with confidence>=70, weighted mean>=72
 * - Cooldown: 120s or 2 turns since last rebuild
 * - Goal transition consistency check
 * 
 * Part of finger-283.3: session-level window state and threshold gate
 */

export interface TopicShiftWindowEntry {
  turnId: string;
  timestamp: number;
  confidence: number;
  fromTopic?: string;
  toTopic?: string;
  rationale?: string;
}

export interface TopicShiftWindowState {
  entries: TopicShiftWindowEntry[];
  lastRebuildTimestamp?: number;
  lastRebuildTurnId?: string;
  turnsSinceRebuild: number;
}

export interface TopicShiftGateConfig {
  windowSize: number;
  confidenceThreshold: number;
  weightedMeanThreshold: number;
  weights: number[];
  cooldownMs: number;
  cooldownTurns: number;
  goalTransitionRequired: boolean;
}

export interface TopicShiftGateResult {
  pass: boolean;
  reason: string;
  windowState: TopicShiftWindowState;
  weightedMean?: number;
  highConfidenceCount?: number;
  cooldownPassed?: boolean;
  goalConsistent?: boolean;
}

const DEFAULT_CONFIG: TopicShiftGateConfig = {
  windowSize: 3,
  confidenceThreshold: 70,
  weightedMeanThreshold: 72,
  weights: [0.2, 0.3, 0.5],
  cooldownMs: 120_000,
  cooldownTurns: 2,
  goalTransitionRequired: true,
};

export class TopicShiftWindowGate {
  private sessionStates: Map<string, TopicShiftWindowState> = new Map();
  private config: TopicShiftGateConfig;

  constructor(config?: Partial<TopicShiftGateConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  getSessionState(sessionId: string): TopicShiftWindowState {
    const existing = this.sessionStates.get(sessionId);
    if (existing) return existing;
    const newState: TopicShiftWindowState = {
      entries: [],
      turnsSinceRebuild: 0,
    };
    this.sessionStates.set(sessionId, newState);
    return newState;
  }

  addEntry(
    sessionId: string,
    entry: TopicShiftWindowEntry,
  ): TopicShiftWindowState {
    const state = this.getSessionState(sessionId);
    state.entries.push(entry);
    if (state.entries.length > this.config.windowSize) {
      state.entries = state.entries.slice(-this.config.windowSize);
    }
    state.turnsSinceRebuild += 1;
    this.sessionStates.set(sessionId, state);
    return state;
  }

  markRebuild(sessionId: string, turnId: string, timestamp: number): void {
    const state = this.getSessionState(sessionId);
    state.lastRebuildTimestamp = timestamp;
    state.lastRebuildTurnId = turnId;
    state.turnsSinceRebuild = 0;
    this.sessionStates.set(sessionId, state);
  }

  evaluateGate(sessionId: string, now?: number): TopicShiftGateResult {
    const state = this.getSessionState(sessionId);
    const currentTimestamp = now ?? Date.now();

    if (state.entries.length < this.config.windowSize) {
      return {
        pass: false,
        reason: `insufficient_window_entries:${state.entries.length}/${this.config.windowSize}`,
        windowState: state,
      };
    }

    const highConfidenceEntries = state.entries.filter(
      (e) => e.confidence >= this.config.confidenceThreshold,
    );
    const highConfidenceCount = highConfidenceEntries.length;

    if (highConfidenceCount < 2) {
      return {
        pass: false,
        reason: `insufficient_high_confidence_turns:${highConfidenceCount}/2`,
        windowState: state,
        highConfidenceCount,
      };
    }

    const weightedSum = state.entries.reduce(
      (sum, entry, index) => sum + entry.confidence * this.config.weights[index],
      0,
    );
    const weightedMean = weightedSum / this.config.weights.reduce((a, b) => a + b, 0);

    if (weightedMean < this.config.weightedMeanThreshold) {
      return {
        pass: false,
        reason: `weighted_mean_below_threshold:${weightedMean.toFixed(1)}/${this.config.weightedMeanThreshold}`,
        windowState: state,
        weightedMean,
        highConfidenceCount,
      };
    }

    const cooldownMsPassed = state.lastRebuildTimestamp
      ? currentTimestamp - state.lastRebuildTimestamp >= this.config.cooldownMs
      : true;
    const cooldownTurnsPassed = state.turnsSinceRebuild >= this.config.cooldownTurns;

    if (!cooldownMsPassed || !cooldownTurnsPassed) {
      return {
        pass: false,
        reason: `cooldown_not_elapsed:ms=${cooldownMsPassed},turns=${cooldownTurnsPassed}`,
        windowState: state,
        weightedMean,
        highConfidenceCount,
        cooldownPassed: false,
      };
    }

    if (this.config.goalTransitionRequired) {
      const allEntriesHaveGoalTransition = state.entries.every(
        (e) => e.fromTopic && e.toTopic,
      );
      const consistentGoalTransition = allEntriesHaveGoalTransition
        && state.entries.every((e) => e.toTopic === state.entries[0]?.toTopic);
      if (!allEntriesHaveGoalTransition || !consistentGoalTransition) {
        return {
          pass: false,
          reason: 'goal_transition_not_consistent',
          windowState: state,
          weightedMean,
          highConfidenceCount,
          cooldownPassed: true,
          goalConsistent: false,
        };
      }
    }

    return {
      pass: true,
      reason: 'gate_passed',
      windowState: state,
      weightedMean,
      highConfidenceCount,
      cooldownPassed: true,
      goalConsistent: true,
    };
  }

  clearSession(sessionId: string): void {
    this.sessionStates.delete(sessionId);
  }

  clearAll(): void {
    this.sessionStates.clear();
  }

  getStats(): { sessionCount: number; totalEntries: number } {
    let totalEntries = 0;
    for (const state of this.sessionStates.values()) {
      totalEntries += state.entries.length;
    }
    return {
      sessionCount: this.sessionStates.size,
      totalEntries,
    };
  }
}

export const topicShiftWindowGate = new TopicShiftWindowGate();