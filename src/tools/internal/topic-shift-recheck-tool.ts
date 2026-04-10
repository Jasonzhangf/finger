import type { TopicShiftRecheckInput, TopicShiftRecheckResult } from '../../common/topic-shift-gate.js';
import { resolveTopicShiftRecheck } from '../../common/topic-shift-gate.js';
import { logger } from '../../core/logger.js';

const log = logger.module('TopicShiftRecheckTool');

interface TopicShiftRecheckToolContext {
  invocationId: string;
  cwd: string;
  timestamp: string;
  sessionId: string;
  agentId: string;
  channelId: string;
}

export const topicShiftRecheckTool = {
  name: 'topic_shift_recheck',
  description:
    'LLM-backed structured recheck for topic-shift context rebuild decisions. ' +
    'Takes aggregated shift evidence and returns a deterministic rebuild verdict.',

  async execute(
    params: {
      session_id: string;
      agent_id: string;
      input: TopicShiftRecheckInput;
    },
    context: TopicShiftRecheckToolContext,
  ): Promise<TopicShiftRecheckResult> {
    const { session_id: sessionId, agent_id: agentId, input } = params;

    if (!input || !input.previousGoal || !input.currentGoal) {
      log.error('Invalid recheck input: missing goals', undefined, { sessionId, agentId });
      return {
        should_rebuild: false,
        confidence: 0,
        reason: 'invalid_input_missing_goals',
        risk_of_forgetting_recent: 0,
        evidence_summary: '',
      };
    }

    log.info('Topic shift recheck requested', {
      sessionId,
      agentId,
      previousGoal: input.previousGoal,
      currentGoal: input.currentGoal,
      windowSize: input.windowSize ?? 3,
    });

    try {
      const result = await resolveTopicShiftRecheck(input, { sessionId, agentId });
      log.info('Topic shift recheck resolved', {
        sessionId,
        shouldRebuild: result.should_rebuild,
        confidence: result.confidence,
        risk: result.risk_of_forgetting_recent,
      });
      return result;
    } catch (error) {
      log.error('Topic shift recheck failed, defaulting to no-rebuild',
        error instanceof Error ? error : undefined,
        { sessionId },
      );
      return {
        should_rebuild: false,
        confidence: 0,
        reason: `recheck_error: ${error instanceof Error ? error.message : String(error)}`,
        risk_of_forgetting_recent: 80,
        evidence_summary: '',
      };
    }
  },
};
