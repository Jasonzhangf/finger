/**
 * 通用 ReACT Loop - Review-before-Act 架构
 * 
 * 核心流程:
 * 1. Planner LLM 产出方案草案 (thought, action, params, expectedOutcome)
 * 2. 格式校验 (JSON Schema)
 * 3. Reviewer Agent 执行前审查 (Pre-Act Review)
 * 4. 批准后执行 action
 * 5. Observation 反馈，进入下一轮
 * 
 * 停止机制 (非 maxRounds):
 * - 完成 action (COMPLETE/FAIL)
 * - 收敛检测 (重复草案无进展)
 * - 卡死检测 (observation 重复)
 * - Review 连续拒绝
 */

import { Agent } from '../agent.js';
import { parseActionProposal } from './proposal-parser.js';
import { ReviewerRole } from '../roles/reviewer.js';
import type { PreActReviewOutput } from '../roles/reviewer.js';
import { SnapshotLogger } from '../shared/snapshot-logger.js';
import { SessionLogger, SessionIteration } from '../shared/session-logger.js';
import { buildPlannerPrompt, PLANNER_EXAMPLES } from '../prompts/planner-prompts.js';
import { buildPreActReviewPrompt } from '../prompts/reviewer-prompts.js';

export interface ActionProposal {
  thought: string;
  action: string;
  params: Record<string, unknown>;
  expectedOutcome?: string;
  risk?: string;
  alternativeActions?: string[];
}

export interface ReActIteration {
  round: number;
  proposal: ActionProposal;
  review?: PreActReviewOutput;
  executed: boolean;
  observation?: string;
  error?: string;
  timestamp: string;
}

export interface ReActState {
  task: string;
  iterations: ReActIteration[];
  convergence: {
    rejectionStreak: number;
    sameRejectionReason: string;
    stuckCount: number;
  };
}

export interface ActionHandler {
  name: string;
  description: string;
  paramsSchema: Record<string, unknown>;
  execute: (params: unknown, context: ActionContext) => Promise<ActionResult>;
}

export interface ActionContext {
  iteration?: number;
  agentId?: string;
  agentRole?: string;
  state: ReActState;
  round: number;
  cwd?: string;
}

export interface ActionResult {
  success: boolean;
  observation: string;
  data?: unknown;
}

export interface StopDecision {
  stop: boolean;
  reason?: string;
  shouldEscalate?: boolean;
}

export interface LoopConfig {
  planner: {
    agent: Agent;
    actionRegistry: ActionRegistry;
    fewShotExamples?: string;
    freshSessionPerRound?: boolean;
  };
  reviewer?: {
    agent: ReviewerRole;
    enabled: boolean;
  };
  stopConditions: {
    completeActions: string[];
    failActions: string[];
    maxRounds?: number;
    onConvergence?: boolean;
    onStuck?: number;
    maxRejections?: number;
  };
  formatFix: {
    maxRetries: number;
    schema: JSONSchema;
  };
  snapshotLogger: SnapshotLogger;
  sessionLogger?: SessionLogger;
  agentId?: string;
}

export interface ActionRegistry {
  list(): Array<{ name: string; description: string; paramsSchema: Record<string, unknown> }>;
  get(name: string): unknown;
  execute(name: string, params: unknown, context: ActionContext): Promise<ActionResult>;
}

export interface JSONSchema {
  type: string;
  required: string[];
  properties: Record<string, { type: string; description?: string }>;
}

export class ReActLoop {
  private config: LoopConfig;
  private state: ReActState;
  private sessionLogger?: SessionLogger;

  private truncateForPrompt(value: string | undefined, maxLength = 280): string {
    if (!value) return '';
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
  }

  constructor(config: LoopConfig, task: string) {
    this.config = config;
    this.state = {
      task,
      iterations: [],
      convergence: {
        rejectionStreak: 0,
        sameRejectionReason: '',
        stuckCount: 0,
      },
    };
    
    // Create session logger if agentId provided
    if (config.agentId) {
      this.sessionLogger = new SessionLogger(
        config.agentId,
        'react-loop',
        task
      );
      config.sessionLogger = this.sessionLogger;
    }
  }

  private logToConsole(message: string, data: Record<string, unknown> = {}): void {
    console.log(`[ReACT] ${message}`, Object.keys(data).length > 0 ? JSON.stringify(data) : '');
  }

  async run(): Promise<ReActResult> {
    const startTime = Date.now();
    
    this.config.snapshotLogger.log({
      timestamp: new Date().toISOString(),
      iteration: 0,
      phase: 'start',
      input: { task: this.state.task },
      output: null,
    });
    
    this.logToConsole('🚀 Starting ReACT Loop', { task: this.state.task.substring(0, 100) });
    if (this.sessionLogger) {
      this.logToConsole('📋 Session logger', { sessionId: this.sessionLogger.getSessionId() });
    }

    // Check for runtime instructions before each round
    const checkRuntimeInstructions = async (): Promise<string[]> => {
      try {
        const { runtimeInstructionBus } = await import('../../orchestration/runtime-instruction-bus.js');
        const stateLike = this.state as ReActState & { epicId?: string; workflowId?: string };
        const keys = [this.config.agentId, stateLike.epicId, stateLike.workflowId].filter(Boolean) as string[];
        const collected: string[] = [];
        for (const key of keys) collected.push(...runtimeInstructionBus.consume(key));
        return collected.filter((v, i, a) => a.indexOf(v) === i);
      } catch { return []; }
    };

    while (true) {
      const round = this.state.iterations.length + 1;
      
      this.logToConsole(`💭 Round ${round}: Generating proposal...`);
      
      // Check for new user input before generating proposal
      const newInstructions = await checkRuntimeInstructions();
      if (newInstructions.length > 0) {
        this.logToConsole(`📬 New runtime instructions (Round ${round})`, { instructions: newInstructions });
        // Instructions will be included in the next prompt via runtimeInstructions parameter
      }
      
      // 1. Planner 产出方案
      let proposal: ActionProposal;
      try {
        proposal = await this.generateProposal(round);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logToConsole(`❌ Proposal generation failed (Round ${round})`, { error: errorMsg });
        this.config.snapshotLogger.log({
          timestamp: new Date().toISOString(),
          iteration: round,
          phase: 'proposal_error',
          input: { task: this.state.task, round },
          output: null,
          error: errorMsg,
        });
        this.sessionLogger?.complete(false, 'proposal_error', undefined, errorMsg);
        return this.buildResult('proposal_error', startTime, errorMsg);
      }
      
      this.logToConsole(`📝 Proposal generated`, { action: proposal.action, thought: proposal.thought.substring(0, 80) });
      
      // 2. 格式校验
      const validation = await this.validateFormat(proposal);
      if (!validation.valid) {
        this.logToConsole(`❌ Format Error (Round ${round})`, { error: validation.error });
        await this.handleFormatError(validation.error || 'unknown format error', round);
        continue;
      }

      this.logToConsole(`✅ Format valid`, {});
      
      // 3. Pre-Act Review (执行前审查)
      let review: PreActReviewOutput | undefined;
      if (this.config.reviewer?.enabled) {
        this.logToConsole(`🔍 Round ${round}: Pre-Act Review...`, { action: proposal.action });
        
        review = await this.preActReview(proposal, round);
        
        this.logToConsole(`🔍 Review result`, { approved: review.approved, riskLevel: review.riskLevel });
        
        if (!review.approved) {
          this.logToConsole(`⛔ Review Rejected (Round ${round})`, { 
            feedback: review.feedback?.substring(0, 100)
          });
          await this.handleRejection(proposal, review, round);
          
          // 检查停止条件：连续拒绝
          const stopCheck = this.checkStopConditions();
          if (stopCheck.stop) {
            this.sessionLogger?.complete(false, stopCheck.reason || 'unknown', undefined, 'Max rejections reached');
            return this.buildResult(stopCheck.reason, startTime);
          }
          continue;
        }
      }

      // 4. 执行 Action
      this.logToConsole(`⚡ Round ${round}: Executing action "${proposal.action}"...`);
      
      const result = await this.executeAction(proposal, round);
      
      this.logToConsole(`⚡ Execution result`, { success: result.success, observation: result.observation?.substring(0, 80) });

      // 5. 记录迭代
      const iteration: ReActIteration = {
        round,
        proposal,
        review,
        executed: true,
        observation: result.observation,
        error: result.success ? undefined : result.observation,
        timestamp: new Date().toISOString(),
      };
      this.state.iterations.push(iteration);

      // Log iteration to session
      const sessionIteration: SessionIteration = {
        round,
        action: proposal.action,
        thought: proposal.thought,
        params: proposal.params,
        reviewApproved: review?.approved,
        reviewFeedback: review?.feedback,
        observation: result.observation,
        success: result.success,
        duration: 0,
        timestamp: new Date().toISOString(),
      };
      this.sessionLogger?.addIteration(sessionIteration);
      
      // 6. 检查停止条件
      const stopCheck = this.checkStopConditions();
      if (stopCheck.stop) {
        const emoji = stopCheck.reason === 'complete' ? '✅' : '⚠️';
        this.logToConsole(`${emoji} Loop Stopped: ${stopCheck.reason}`, {
          rounds: this.state.iterations.length,
          shouldEscalate: stopCheck.shouldEscalate,
        });
        
        this.sessionLogger?.complete(
          stopCheck.reason === 'complete',
          stopCheck.reason || 'unknown',
          result.observation,
          result.success ? undefined : result.observation
        );
        return this.buildResult(stopCheck.reason, startTime);
      }
    }
  }

  private async generateProposal(round: number): Promise<ActionProposal> {
    const history = this.state.iterations.slice(-5).map(i => {
      let summary = `Round ${i.round}: ${i.proposal.action}`;
      if (i.review) {
        summary += i.review.approved
          ? ' (approved)'
          : ` (rejected: ${this.truncateForPrompt(i.review.feedback)})`;
      }
      if (i.executed) {
        summary += i.error
          ? ` (error: ${this.truncateForPrompt(i.error)})`
          : ` (success: ${this.truncateForPrompt(i.observation, 120)})`;
      }
      return summary;
    }).join('\n');

    // Load any pending runtime instructions for current workflow/agent context.
    let runtimeInstructions: string[] | undefined;
    try {
      const { runtimeInstructionBus } = await import('../../orchestration/runtime-instruction-bus.js');
      const instructionKeys = new Set<string>();

      if (this.config.agentId) {
        instructionKeys.add(this.config.agentId);
      }

      const stateLike = this.state as ReActState & { epicId?: string; workflowId?: string };
      if (typeof stateLike.epicId === 'string' && stateLike.epicId) {
        instructionKeys.add(stateLike.epicId);
      }
      if (typeof stateLike.workflowId === 'string' && stateLike.workflowId) {
        instructionKeys.add(stateLike.workflowId);
      }

      const collected: string[] = [];
      for (const key of instructionKeys) {
        const items = runtimeInstructionBus.consume(key);
        for (const item of items) {
          if (!collected.includes(item)) {
            collected.push(item);
          }
        }
      }

      runtimeInstructions = collected.length > 0 ? collected : undefined;
    } catch {
      runtimeInstructions = undefined;
    }

    const tools = this.config.planner.actionRegistry.list().map(h => ({
      name: h.name,
      description: h.description,
      params: h.paramsSchema,
    }));

    const prompt = buildPlannerPrompt({
      task: this.state.task,
      tools,
      history,
      round,
      examples: this.config.planner.fewShotExamples || PLANNER_EXAMPLES,
      runtimeInstructions,
    });

    if (this.config.planner.freshSessionPerRound) {
      await this.config.planner.agent.startFreshSession();
    }

    const maxRetries = this.config.formatFix.maxRetries;
    let currentPrompt = prompt;
    let lastRawOutput = '';
    let lastParseError = '';

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await this.config.planner.agent.execute(currentPrompt);

      if (!response.success) {
        const detail = response.error || response.stopReason || 'unknown';
        throw new Error(`Planner execution failed: ${detail}`);
      }

      lastRawOutput = response.output?.trim() || '';
      if (!lastRawOutput) {
        lastParseError = `Planner output is empty (stopReason=${response.stopReason || 'unknown'})`;
      } else {
        const parsed = parseActionProposal(lastRawOutput);
        if (parsed.success && parsed.proposal) {
          this.logToConsole('🧩 Proposal parsed', {
            round,
            method: parsed.method || 'unknown',
            attempt,
          });
          return parsed.proposal as ActionProposal;
        }
        lastParseError = parsed.error || 'failed to parse planner output';
      }

      if (attempt >= maxRetries) {
        break;
      }

      const outputPreview = this.truncateForPrompt(lastRawOutput, 500);
      currentPrompt = `${prompt}

你上一条回复未通过系统解析（已尝试掩码提取和自动修复，均失败）。
解析错误：${lastParseError}
上一条输出：${outputPreview || '[empty]'}

请重新回复，严格遵循以下要求：
1. 仅输出一个 JSON 对象
2. 必须包含 thought/action/params 字段
3. action 必须来自可用工具列表
4. params 必须是 JSON object
5. 不要输出 markdown、代码块、解释文字
`;

      this.logToConsole('🛠️ Request planner reformat', {
        round,
        retry: attempt + 1,
        error: this.truncateForPrompt(lastParseError, 200),
      });
    }

    const finalPreview = this.truncateForPrompt(lastRawOutput, 400);
    throw new Error(
      `Failed to parse planner output after ${maxRetries + 1} attempts: ${lastParseError}; output=${finalPreview}`
    );
  }

  private async validateFormat(proposal: unknown): Promise<{ valid: boolean; error?: string }> {
    // 基础字段检查
    const p = proposal as ActionProposal;
    if (!p.thought) return { valid: false, error: 'Missing "thought" field' };
    if (!p.action) return { valid: false, error: 'Missing "action" field' };
    if (!p.params) return { valid: false, error: 'Missing "params" field' };
    
    // 检查 action 是否有效
    const handler = this.config.planner.actionRegistry.get(p.action);
    if (!handler) {
      return { valid: false, error: `Unknown action: ${p.action}` };
    }

    // 检查 params 是否为对象
    if (typeof p.params !== 'object' || p.params === null) {
      return { valid: false, error: 'params must be an object' };
    }

    // 增强验证：检查 action 名称是否在允许列表中
    const allowedActions = ['HIGH_DESIGN', 'DETAIL_DESIGN', 'DELIVERABLES', 'PARALLEL_DISPATCH', 'BLOCKED_REVIEW', 'VERIFY', 'CHECKPOINT', 'READ_FILE', 'WRITE_FILE', 'SHELL_EXEC', 'WEB_SEARCH', 
                            'FETCH_URL', 'COMPLETE', 'FAIL', 'PLAN', 'DISPATCH'];
    if (!allowedActions.includes(p.action)) {
      return { valid: false, error: `Action ${p.action} not in allowed list` };
    }

    // 增强验证：检查必需参数是否存在
    const requiredParams: Record<string, string[]> = {
      READ_FILE: ['path'],
      WRITE_FILE: ['path', 'content'],
      SHELL_EXEC: ['command'],
      WEB_SEARCH: ['query'],
      FETCH_URL: ['url'],
      COMPLETE: [],
      FAIL: ['reason'],
      PLAN: ['tasks'],
      DISPATCH: ['taskId'],
      PARALLEL_DISPATCH: ['taskIds'],
      BLOCKED_REVIEW: [],
      VERIFY: [],
      CHECKPOINT: [],
    };

    const required = requiredParams[p.action];
    if (required) {
      const missing = required.filter(key => !(key in p.params));
      if (missing.length > 0) {
        return { valid: false, error: `Missing required params for ${p.action}: ${missing.join(', ')}` };
      }
    }

    return { valid: true };
  }

  private async preActReview(proposal: ActionProposal, round: number): Promise<PreActReviewOutput> {
    const reviewer = this.config.reviewer!.agent;
    const availableTools = this.config.planner.actionRegistry.list().map(h => h.name);

    const history = this.state.iterations
      .slice(-3)
      .map(i => {
        const errorSuffix = i.error ? ` (error: ${this.truncateForPrompt(i.error)})` : '';
        return `Round ${i.round}: ${i.proposal.action}${errorSuffix}`;
      })
      .join('\n');

    const prompt = buildPreActReviewPrompt({
      task: this.state.task,
      round,
      proposal,
      availableTools,
      history,
    });

    const review = await reviewer.reviewPreAct({
      task: this.state.task,
      round,
      thought: proposal.thought,
      action: proposal.action,
      params: proposal.params,
      expectedOutcome: proposal.expectedOutcome,
      risk: proposal.risk,
      availableTools,
      prompt,
    });

    // 强制高风险拒绝
    if (review.riskLevel === 'high' && review.approved) {
      return {
        ...review,
        approved: false,
        feedback: `${review.feedback}; Auto-rejected due to high risk`,
        requiredFixes: [...review.requiredFixes, 'Risk level is high, must provide safer alternative'],
      };
    }

    return review;
  }

  private async executeAction(proposal: ActionProposal, round: number): Promise<ActionResult> {
    const handler = this.config.planner.actionRegistry.get(proposal.action);
    if (!handler) {
      return {
        success: false,
        observation: `Unknown action: ${proposal.action}`,
      };
    }

    const context: ActionContext = {
      state: this.state,
      round,
      cwd: process.cwd(),
    };

    try {
      const result = await this.config.planner.actionRegistry.execute(proposal.action, proposal.params, context);
      
      this.config.snapshotLogger.log({
        timestamp: new Date().toISOString(),
        iteration: round,
        phase: 'execute',
        input: proposal,
        output: result,
      });

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        observation: `Execution error: ${errorMsg}`,
      };
    }
  }

  private async handleFormatError(error: string, round: number): Promise<void> {
    // 记录格式错误，下一轮 Planner 会收到反馈
    this.state.iterations.push({
      round,
      proposal: { thought: 'Format error', action: 'INVALID', params: {} },
      executed: false,
      error,
      timestamp: new Date().toISOString(),
    });

    this.config.snapshotLogger.log({
      timestamp: new Date().toISOString(),
      iteration: round,
      phase: 'format_error',
      input: null,
      output: null,
      error,
    });
  }

  private async handleRejection(
    proposal: ActionProposal,
    review: PreActReviewOutput,
    round: number
  ): Promise<void> {
    // 记录拒绝
    this.state.iterations.push({
      round,
      proposal,
      review,
      executed: false,
      error: `Rejected: ${review.feedback}`,
      timestamp: new Date().toISOString(),
    });

    // 更新收敛检测
    this.state.convergence.rejectionStreak++;
    if (review.feedback === this.state.convergence.sameRejectionReason) {
      this.state.convergence.stuckCount++;
    } else {
      this.state.convergence.sameRejectionReason = review.feedback;
      this.state.convergence.stuckCount = 1;
    }

    this.config.snapshotLogger.log({
      timestamp: new Date().toISOString(),
      iteration: round,
      phase: 'rejected',
      input: proposal,
      output: review,
    });
  }

  private checkStopConditions(): StopDecision {
    const { stopConditions, reviewer } = this.config;
    const { convergence, iterations } = this.state;
    
    if (iterations.length === 0) return { stop: false };
    
    const lastIter = iterations[iterations.length - 1];
    const action = lastIter.proposal.action;

    // 1. 完成 Action 检测
    if (stopConditions.completeActions.includes(action)) {
      return { stop: true, reason: 'complete' };
    }
    
    // 2. 失败 Action 检测
    if (stopConditions.failActions.includes(action)) {
      return { stop: true, reason: 'fail' };
    }

    // 2.5 最大轮次保护，避免异常循环导致无限增长
    if (stopConditions.maxRounds && iterations.length >= stopConditions.maxRounds) {
      return { stop: true, reason: 'max_rounds', shouldEscalate: true };
    }

    // 3. 连续拒绝检测
    if (reviewer?.enabled && stopConditions.maxRejections) {
      if (convergence.rejectionStreak >= stopConditions.maxRejections) {
        return { stop: true, reason: 'max_rejections', shouldEscalate: true };
      }
    }

    // 4. 卡死检测（同一原因连续拒绝）
    if (stopConditions.onStuck && convergence.stuckCount >= stopConditions.onStuck) {
      return { stop: true, reason: 'stuck', shouldEscalate: true };
    }

    // 5. 收敛检测（无新进展）
    if (stopConditions.onConvergence && iterations.length >= 5) {
      const recentObs = iterations.slice(-5).map(i => i.observation).filter(Boolean);
      const uniqueObs = new Set(recentObs);
      if (recentObs.length >= 3 && uniqueObs.size === 1) {
        return { stop: true, reason: 'no_progress', shouldEscalate: true };
      }
    }

    return { stop: false };
  }

  private buildResult(reason: string | undefined, startTime: number, finalErrorOverride?: string): ReActResult {
    const lastIter = this.state.iterations[this.state.iterations.length - 1];
    
    // max_rounds is a protection stop - check if task was actually completed
    // If the last action was READ_FILE (verification step) and succeeded, treat as success
    const isMaxRounds = reason === 'max_rounds';
    const lastActionSuccess = lastIter && !lastIter.error;
    const actualSuccess = reason === 'complete' || (isMaxRounds && lastActionSuccess);
    
    return {
      success: actualSuccess,
      reason: reason || 'unknown',
      iterations: this.state.iterations,
      finalObservation: lastIter?.observation,
      finalError: finalErrorOverride || lastIter?.error,
      totalRounds: this.state.iterations.length,
      duration: Date.now() - startTime,
    };
  }
}

export interface ReActResult {
  success: boolean;
  reason: string;
  iterations: ReActIteration[];
  finalObservation?: string;
  finalError?: string;
  totalRounds: number;
  duration: number;
}
