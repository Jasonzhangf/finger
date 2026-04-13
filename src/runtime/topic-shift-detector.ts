/**
 * Topic Shift Detector — 多轮置信度累积话题切换检测器
 *
 * 设计原则：保守触发，连续 N 轮高置信度才触发 context rebuild
 * 默认：连续 3 轮 >= 0.8 置信度
 */

export interface TopicShiftControl {
  /** 上次用户话题 */
  last_topic: string | null;
  /** 当前用户话题 */
  current_topic: string;
  /** 是否是新话题 */
  is_new_topic: boolean;
  /** 置信度 0-1 */
  confidence: number;
  /** 话题切换原因 */
  reason?: 'user_explicit' | 'content_mismatch' | 'time_gap' | 'keyword_shift';
}

export interface TopicShiftTracker {
  accumulationCount: number;
  confidenceHistory: number[];
  threshold: number;
  requiredRounds: number;
  maxHistoryLength: number;
}

export interface TopicShiftResult {
  shouldTrigger: boolean;
  reason: string;
  tracker: TopicShiftTracker;
}

/** 默认 tracker 配置 */
function createDefaultTracker(): TopicShiftTracker {
  return {
    accumulationCount: 0,
    confidenceHistory: [],
    threshold: 0.8,
    requiredRounds: 3,
    maxHistoryLength: 10,
  };
}

/**
 * 从 LLM response metadata 中提取 ControlBlock 话题判断
 */
export function extractTopicShiftControl(
  metadata: Record<string, unknown> | null | undefined,
): TopicShiftControl | null {
  if (!metadata) return null;

  // 尝试从 metadata.control 中提取
  const control = metadata.control as Record<string, unknown> | undefined;
  if (!control || typeof control !== 'object') return null;

  const is_new_topic = control.is_new_topic;
  if (typeof is_new_topic !== 'boolean') return null;

  const current_topic = control.current_topic;
  if (typeof current_topic !== 'string' || current_topic.trim().length === 0) return null;

  const confidence = control.confidence as number;
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) return null;

  return {
    last_topic: typeof control.last_topic === 'string' ? control.last_topic : null,
    current_topic,
    is_new_topic,
    confidence,
    reason: typeof control.reason === 'string' ? (control.reason as TopicShiftControl['reason']) : undefined,
  };
}

/**
 * 多轮话题切换检测器
 */
export class TopicShiftDetector {
  private tracker: TopicShiftTracker;

  constructor(initial?: TopicShiftTracker) {
    this.tracker = initial ?? createDefaultTracker();
  }

  /**
   * 检测是否应该触发 context rebuild
   */
  shouldTrigger(control: TopicShiftControl | null): TopicShiftResult {
    // 无 control 信息 → 不触发
    if (!control) {
      return {
        shouldTrigger: false,
        reason: 'no_control_info',
        tracker: { ...this.tracker },
      };
    }

    // 不是新话题 → 清空累积
    if (!control.is_new_topic) {
      this.reset();
      return {
        shouldTrigger: false,
        reason: 'not_new_topic',
        tracker: { ...this.tracker },
      };
    }

    // 是新话题 → 累积置信度
    this.tracker.confidenceHistory.push(control.confidence);
    this.tracker.accumulationCount++;

    // 限制历史长度
    if (this.tracker.confidenceHistory.length > this.tracker.maxHistoryLength) {
      this.tracker.confidenceHistory.shift();
    }

    // 判断：连续 requiredRounds 轮置信度都 >= threshold
    if (this.tracker.accumulationCount >= this.tracker.requiredRounds) {
      const recent = this.tracker.confidenceHistory.slice(-this.tracker.requiredRounds);
      if (recent.every(c => c >= this.tracker.threshold)) {
        this.reset();
        return {
          shouldTrigger: true,
          reason: `topic_shift_accumulation (${this.tracker.requiredRounds} rounds >= ${this.tracker.threshold})`,
          tracker: { ...this.tracker },
        };
      }
    }

    return {
      shouldTrigger: false,
      reason: `accumulating (${this.tracker.accumulationCount}/${this.tracker.requiredRounds} rounds)`,
      tracker: { ...this.tracker },
    };
  }

  /**
   * 重置累积状态
   */
  reset(): void {
    this.tracker.accumulationCount = 0;
    this.tracker.confidenceHistory = [];
  }

  /**
   * 获取当前状态
   */
  getStatus(): TopicShiftTracker {
    return { ...this.tracker };
  }

  /**
   * 序列化为 JSON（用于持久化到 ledger）
   */
  toJSON(): TopicShiftTracker {
    return { ...this.tracker };
  }

  /**
   * 从 JSON 恢复
   */
  static fromJSON(data: TopicShiftTracker): TopicShiftDetector {
    return new TopicShiftDetector(data);
  }
}

/**
 * 心跳 session 标识判断
 */
export function isHeartbeatSession(sessionId: string): boolean {
  return (
    sessionId.startsWith('hb-session') ||
    sessionId.startsWith('system-') ||
    sessionId.includes('heartbeat')
  );
}

/**
 * 循环任务标识判断
 */
export function isCronTask(sourceType: string): boolean {
  const normalized = sourceType.toLowerCase();
  return (
    normalized === 'cron' ||
    normalized === 'clock' ||
    normalized.includes('schedule') ||
    normalized.includes('heartbeat')
  );
}

/**
 * 历史引用关键词检测
 */
export function containsHistoryReference(prompt: string): boolean {
  const historyKeywords = ['之前', '上次', '还记得', '回顾', '刚才', '前面'];
  return historyKeywords.some(kw => prompt.includes(kw));
}

/**
 * 完整触发决策
 */
export interface RebuildDecision {
  shouldRebuild: boolean;
  reason: string;
  confidence: number;
}

export function decideContextRebuild(
  sessionId: string,
  sourceType: string,
  prompt: string,
  currentTokens: number,
  maxTokens: number,
  control: TopicShiftControl | null,
  detector: TopicShiftDetector | null,
): RebuildDecision {
  // P0: 心跳 session
  if (isHeartbeatSession(sessionId)) {
    return { shouldRebuild: true, reason: 'heartbeat_session', confidence: 1.0 };
  }

  // P0: 循环任务
  if (isCronTask(sourceType)) {
    return { shouldRebuild: true, reason: 'cron_task', confidence: 1.0 };
  }

  // P2: 上下文溢出
  if (currentTokens > maxTokens * 0.8) {
    return { shouldRebuild: true, reason: 'context_overflow', confidence: 0.9 };
  }

  // P3: 显式关键词
  if (containsHistoryReference(prompt)) {
    return { shouldRebuild: true, reason: 'explicit_keyword', confidence: 0.7 };
  }

  // P1: 话题切换累积
  if (control && control.is_new_topic && detector) {
    const result = detector.shouldTrigger(control);
    if (result.shouldTrigger) {
      return { shouldRebuild: true, reason: result.reason, confidence: 0.8 };
    }
  }

  // 默认：不触发
  return { shouldRebuild: false, reason: 'none', confidence: 0 };
}
