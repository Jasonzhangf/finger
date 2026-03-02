import { useCallback, useEffect, useRef, useState } from 'react';
import { getWebSocket } from '../api/websocket.js';
import type {
  AgentExecutionDetail,
  AgentRuntime,
  AgentUpdatePayload,
  ExecutionRound,
  RuntimeEvent,
  TaskNode,
  TaskReport,
  UserInputPayload,
  UserRound,
  WorkflowExecutionState,
  WorkflowInfo,
  WorkflowUpdatePayload,
  WsMessage,
} from '../api/types.js';
import {
  CHAT_PANEL_TARGET,
  CONTEXT_HISTORY_WINDOW_SIZE,
  DEBUG_SNAPSHOTS_STORAGE_KEY,
  DEFAULT_CHAT_AGENT_ID,
  DEFAULT_LEDGER_FOCUS_MAX_CHARS,
  ENABLE_UI_DIRECT_AGENT_TEST_ROUTE,
  SEND_RETRY_BASE_DELAY_MS,
  SEND_RETRY_MAX_ATTEMPTS,
  SESSION_BOUND_WS_TYPES,
  SESSION_MESSAGES_FETCH_LIMIT,
} from './useWorkflowExecution.constants.js';
import {
  buildContextEditableEventIds,
  buildGatewayHistory,
  buildKernelInputItems,
  buildUserRoundsFromSessionMessages,
  mapSessionMessageToRuntimeEvent,
  normalizeReviewSettings,
} from './useWorkflowExecution.session.js';
import {
  buildExecutionRoundsFromTasks,
  buildRoundExecutionPath,
  computeAgentLoadFromLog,
  inferAgentStatus,
  inferAgentType,
  pickWorkflowForSession,
} from './useWorkflowExecution.runtime.js';
import { describeOrchestratorPhase, mapOrchestratorPhaseToUiState } from './useWorkflowExecution.phase.js';
import { extractChatReply, extractTokenUsageFromRoundTrace } from './useWorkflowExecution.reply.js';
import { useWebSocket } from './useWebSocket.js';
import {
  normalizeToolName,
  normalizeToolNameList,
  resolveDisplayToolName,
  resolveToolActionLabel,
  resolveToolCategoryLabel,
} from './useWorkflowExecution.tools.js';
import {
  computeContextUsagePercent,
  extractCompactSummary,
  extractErrorMessageFromBody,
  extractStatusCodeFromErrorMessage,
  isAbortError,
  isRecord,
  isPersistedSessionMessageId,
  parseNumberLike,
  parseRetryAfterMs,
  parseInputLockState,
  safeParseJson,
  shouldRetryChatRequest,
  sleep,
} from './useWorkflowExecution.utils.js';
import type {
  AgentRunStatus,
  DebugSnapshotItem,
  DebugSnapshotStage,
  InputLockState,
  OrchestratorRuntimeModeState,
  RuntimeOverview,
  SessionLog,
  ToolPanelOverview,
  UseWorkflowExecutionReturn,
} from './useWorkflowExecution.types.js';

export function useWorkflowExecution(sessionId: string): UseWorkflowExecutionReturn {
  const isSessionBoundWsMessage = useCallback((type: string): boolean => SESSION_BOUND_WS_TYPES.has(type), []);
  const [workflow, setWorkflow] = useState<WorkflowInfo | null>(null);
  const [executionState, setExecutionState] = useState<WorkflowExecutionState | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEvent[]>([]);
  const [userRounds, setUserRounds] = useState<UserRound[]>([]);
  const [executionRounds, setExecutionRounds] = useState<ExecutionRound[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<SessionLog[]>([]);
  const [agentRunStatus, setAgentRunStatus] = useState<AgentRunStatus>({
    phase: 'idle',
    text: '已就绪',
    updatedAt: new Date().toISOString(),
  });
  const [runtimeOverview, setRuntimeOverview] = useState<RuntimeOverview>({
    ledgerFocusMaxChars: DEFAULT_LEDGER_FOCUS_MAX_CHARS,
    compactCount: 0,
    updatedAt: new Date().toISOString(),
  });
  const [sessionAgentId, setSessionAgentId] = useState<string>(DEFAULT_CHAT_AGENT_ID);
  const [toolPanelOverview, setToolPanelOverview] = useState<ToolPanelOverview>({
    availableTools: [],
    exposedTools: [],
  });
  const [debugSnapshotsEnabled, setDebugSnapshotsEnabledState] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.localStorage) return true;
    const raw = window.localStorage.getItem(DEBUG_SNAPSHOTS_STORAGE_KEY);
    if (!raw) return true;
    const normalized = raw.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  });
  const [debugSnapshots, setDebugSnapshots] = useState<DebugSnapshotItem[]>([]);
  const [orchestratorRuntimeMode, setOrchestratorRuntimeMode] = useState<OrchestratorRuntimeModeState | null>(null);
  const executionStateRef = useRef<WorkflowExecutionState | null>(null);
  const runtimeEventsRef = useRef<RuntimeEvent[]>([]);
  const inFlightSendAbortRef = useRef<AbortController | null>(null);
  const sessionHydratedRef = useRef(false);
  const deferredWsEventsRef = useRef<WsMessage[]>([]);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadSessionMessagesRef = useRef<(() => void) | null>(null);

  const setDebugSnapshotsEnabled = useCallback((enabled: boolean) => {
    setDebugSnapshotsEnabledState(enabled);
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(DEBUG_SNAPSHOTS_STORAGE_KEY, String(enabled));
    }
  }, []);

  const pushDebugSnapshot = useCallback((input: {
    stage: DebugSnapshotStage;
    summary: string;
    requestId?: string;
    attempt?: number;
    phase?: string;
    payload?: unknown;
  }) => {
    const timestamp = new Date().toISOString();
    const nextItem: DebugSnapshotItem = {
      id: `${timestamp}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp,
      sessionId,
      stage: input.stage,
      summary: input.summary.trim().length > 0 ? input.summary.trim() : input.stage,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      ...(typeof input.attempt === 'number' ? { attempt: input.attempt } : {}),
      ...(input.phase ? { phase: input.phase } : {}),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    };
    setDebugSnapshots((prev) => {
      const merged = [...prev, nextItem];
      return merged.length > 300 ? merged.slice(merged.length - 300) : merged;
    });
  }, [sessionId]);

  const clearDebugSnapshots = useCallback(() => {
    setDebugSnapshots([]);
  }, []);

  const resolveMessageRoute = useCallback((): {
    target: string;
    headers: Record<string, string>;
    directTest: boolean;
  } => {
    const selected = typeof selectedAgentId === 'string' ? selectedAgentId.trim() : '';
    const directTest = ENABLE_UI_DIRECT_AGENT_TEST_ROUTE
      && selected.length > 0
      && selected !== DEFAULT_CHAT_AGENT_ID
      && selected !== CHAT_PANEL_TARGET;
    return {
      target: directTest ? selected : CHAT_PANEL_TARGET,
      headers: {
        'Content-Type': 'application/json',
        ...(directTest ? { 'x-finger-route-mode': 'test' } : {}),
      },
      directTest,
    };
  }, [selectedAgentId]);

  useEffect(() => {
    executionStateRef.current = executionState;
  }, [executionState]);

  useEffect(() => {
    runtimeEventsRef.current = runtimeEvents;
  }, [runtimeEvents]);

  const scheduleSessionMessagesRefresh = useCallback(() => {
    if (!sessionId) return;
    if (sessionRefreshTimerRef.current) {
      clearTimeout(sessionRefreshTimerRef.current);
    }
    sessionRefreshTimerRef.current = setTimeout(() => {
      loadSessionMessagesRef.current?.();
    }, 300);
  }, [sessionId]);

  const processWebSocketMessage = useCallback((msg: WsMessage) => {
    const payload = isRecord(msg.payload) ? msg.payload : {};
    const messageSessionId =
      (typeof msg.sessionId === 'string' ? msg.sessionId : undefined)
      ?? (typeof payload.sessionId === 'string' ? payload.sessionId : undefined);
    const isCurrentSessionEvent = !messageSessionId || messageSessionId === sessionId;

    if (isCurrentSessionEvent) {
      if (msg.type === 'user_message') {
        scheduleSessionMessagesRefresh();
      }
      if (msg.type === 'tool_call' || msg.type === 'tool_result' || msg.type === 'tool_error' || msg.type === 'agent_update') {
        scheduleSessionMessagesRefresh();
      }
      if (msg.type === 'chat_codex_turn') {
        const wsPhase = typeof payload.phase === 'string' ? payload.phase.trim() : '';
        pushDebugSnapshot({
          stage: 'chat_codex_turn',
          summary: wsPhase.length > 0 ? `chat_codex_turn.${wsPhase}` : 'chat_codex_turn',
          ...(wsPhase.length > 0 ? { phase: wsPhase } : {}),
          payload,
        });
      } else if (msg.type === 'phase_transition') {
        const from = typeof payload.from === 'string' ? payload.from.trim() : '';
        const to = typeof payload.to === 'string' ? payload.to.trim() : '';
        pushDebugSnapshot({
          stage: 'phase_transition',
          summary: `phase ${from || '?'} -> ${to || '?'}`,
          ...(to.length > 0 ? { phase: to } : {}),
          payload,
        });
      } else if (msg.type === 'tool_call') {
        const toolName = resolveDisplayToolName(payload, payload.input, payload.output);
        pushDebugSnapshot({
          stage: 'tool_call',
          summary: `tool_call ${toolName}`,
          payload,
        });
      } else if (msg.type === 'tool_result') {
        const toolName = resolveDisplayToolName(payload, payload.input, payload.output);
        pushDebugSnapshot({
          stage: 'tool_result',
          summary: `tool_result ${toolName}`,
          payload,
        });
      } else if (msg.type === 'tool_error') {
        const toolName = resolveDisplayToolName(payload, payload.input, payload.output);
        pushDebugSnapshot({
          stage: 'tool_error',
          summary: `tool_error ${toolName}`,
          payload,
        });
      }
    }

    if (msg.type === 'chat_codex_turn') {
      if (!isCurrentSessionEvent) return;
      const phase = typeof payload.phase === 'string' ? payload.phase : 'kernel_event';
      const mode = typeof payload.mode === 'string' ? payload.mode : 'main';
      const reviewIteration = typeof payload.reviewIteration === 'number' ? payload.reviewIteration : undefined;
      const label = mode === 'review'
        ? `Review 回合${typeof reviewIteration === 'number' ? ` #${reviewIteration}` : ''}`
        : '主回合';
      if (phase === 'turn_start') {
        setAgentRunStatus({
          phase: 'running',
          text: `${label}开始执行...`,
          updatedAt: new Date().toISOString(),
        });
      } else if (phase === 'kernel_event' && payload.type === 'task_started') {
        const modelContextWindow =
          typeof payload.modelContextWindow === 'number' && Number.isFinite(payload.modelContextWindow)
            ? Math.max(0, Math.floor(payload.modelContextWindow))
            : undefined;
        if (modelContextWindow !== undefined && modelContextWindow > 0) {
          setRuntimeOverview((prev) => ({
            ...prev,
            contextMaxInputTokens: modelContextWindow,
            updatedAt: new Date().toISOString(),
          }));
        }
        setAgentRunStatus({
          phase: 'running',
          text: modelContextWindow
            ? `${label}开始执行... 上下文窗口 ${modelContextWindow} tokens`
            : `${label}开始执行...`,
          updatedAt: new Date().toISOString(),
        });
      } else if (phase === 'kernel_event' && payload.type === 'pending_input_queued') {
        setAgentRunStatus({
          phase: 'running',
          text: `${label}执行中，新的输入已排队，等待当前回合合并...`,
          updatedAt: new Date().toISOString(),
        });
      } else if (phase === 'kernel_event' && payload.type === 'turn_interrupted') {
        setAgentRunStatus({
          phase: 'idle',
          text: `${label}已停止`,
          updatedAt: new Date().toISOString(),
        });
      } else if (phase === 'kernel_event' && payload.type === 'model_round') {
        const round = typeof payload.round === 'number' && Number.isFinite(payload.round)
          ? Math.floor(payload.round)
          : undefined;
        if (round && round > 0) {
          const finishReason = typeof payload.finishReason === 'string' ? payload.finishReason.trim() : '';
          const contextUsagePercent =
            typeof payload.contextUsagePercent === 'number' && Number.isFinite(payload.contextUsagePercent)
              ? Math.max(0, Math.floor(payload.contextUsagePercent))
              : undefined;
          const estimatedTokensInContextWindow =
            typeof payload.estimatedTokensInContextWindow === 'number' && Number.isFinite(payload.estimatedTokensInContextWindow)
              ? Math.max(0, Math.floor(payload.estimatedTokensInContextWindow))
              : undefined;
          const maxInputTokens =
            typeof payload.maxInputTokens === 'number' && Number.isFinite(payload.maxInputTokens)
              ? Math.max(0, Math.floor(payload.maxInputTokens))
              : undefined;
          const thresholdPercent =
            typeof payload.thresholdPercent === 'number' && Number.isFinite(payload.thresholdPercent)
              ? Math.max(0, Math.floor(payload.thresholdPercent))
              : undefined;
          const effectiveContextUsagePercent = contextUsagePercent
            ?? computeContextUsagePercent(estimatedTokensInContextWindow, maxInputTokens);
          const fragments: string[] = [];
          if (finishReason.length > 0) {
            fragments.push(`finish=${finishReason}`);
          }
          if (effectiveContextUsagePercent !== undefined) {
            if (estimatedTokensInContextWindow !== undefined && maxInputTokens !== undefined && maxInputTokens > 0) {
              fragments.push(`上下文 ${effectiveContextUsagePercent}% (${estimatedTokensInContextWindow}/${maxInputTokens})`);
            } else if (estimatedTokensInContextWindow !== undefined) {
              fragments.push(`上下文 ${estimatedTokensInContextWindow} tokens`);
            } else {
              fragments.push(`上下文 ${effectiveContextUsagePercent}%`);
            }
          } else if (estimatedTokensInContextWindow !== undefined) {
            fragments.push(`上下文 ${estimatedTokensInContextWindow} tokens`);
          }
          if (
            thresholdPercent !== undefined
            && effectiveContextUsagePercent !== undefined
            && effectiveContextUsagePercent >= thresholdPercent
          ) {
            fragments.push('接近上下文阈值');
          }
          setAgentRunStatus({
            phase: 'running',
            text: `${label}内部循环第 ${round} 轮${fragments.length > 0 ? ` · ${fragments.join(' · ')}` : ''}`,
            updatedAt: new Date().toISOString(),
          });

          const inputTokens = parseNumberLike(payload.inputTokens, payload.input_tokens);
          const outputTokens = parseNumberLike(payload.outputTokens, payload.output_tokens);
          const totalTokens = parseNumberLike(payload.totalTokens, payload.total_tokens);
          if (
            inputTokens !== undefined
            || outputTokens !== undefined
            || totalTokens !== undefined
            || effectiveContextUsagePercent !== undefined
            || estimatedTokensInContextWindow !== undefined
            || maxInputTokens !== undefined
            || thresholdPercent !== undefined
          ) {
            setRuntimeOverview((prev) => ({
              ...prev,
              ...(inputTokens !== undefined ? { reqTokens: inputTokens } : {}),
              ...(outputTokens !== undefined ? { respTokens: outputTokens } : {}),
              ...(totalTokens !== undefined ? { totalTokens } : {}),
              ...((inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined)
                ? { tokenUpdatedAtLocal: new Date().toLocaleString() }
                : {}),
              ...(effectiveContextUsagePercent !== undefined ? { contextUsagePercent: effectiveContextUsagePercent } : {}),
              ...(estimatedTokensInContextWindow !== undefined
                ? { contextTokensInWindow: estimatedTokensInContextWindow }
                : {}),
              ...(maxInputTokens !== undefined ? { contextMaxInputTokens: maxInputTokens } : {}),
              ...(thresholdPercent !== undefined ? { contextThresholdPercent: thresholdPercent } : {}),
              updatedAt: new Date().toISOString(),
            }));
          }
        }
      } else if (phase === 'kernel_event' && payload.type === 'context_compact') {
        setRuntimeOverview((prev) => ({
          ...prev,
          compactCount: prev.compactCount + 1,
          updatedAt: new Date().toISOString(),
        }));
      } else if (phase === 'turn_complete') {
        const finalKernelEvent =
          typeof payload.finalKernelEvent === 'string' ? payload.finalKernelEvent.trim() : '';
        if (finalKernelEvent === 'pending_input_queued') {
          setAgentRunStatus({
            phase: 'running',
            text: `${label}执行中，输入已排队，等待当前回合继续...`,
            updatedAt: new Date().toISOString(),
          });
          return;
        }
        setAgentRunStatus({
          phase: 'running',
          text: `${label}完成，等待下一步...`,
          updatedAt: new Date().toISOString(),
        });
      } else if (phase === 'turn_error') {
        setAgentRunStatus({
          phase: 'error',
          text: `${label}执行失败`,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }

    if (msg.type === 'tool_call') {
      if (!isCurrentSessionEvent) return;
      const toolName = resolveDisplayToolName(payload, payload.input, payload.output);
      const actionLabel = resolveToolActionLabel(toolName, payload.input);
      const category = resolveToolCategoryLabel(toolName, payload.input);
      const normalizedToolName = toolName.trim().toLowerCase();
      const isDispatchTool = normalizedToolName.includes('dispatch');
      setAgentRunStatus({
        phase: isDispatchTool ? 'dispatching' : 'running',
        text: isDispatchTool
          ? `编排器任务分配中：${actionLabel}`
          : `正在执行${category}工具：${actionLabel}`,
        updatedAt: new Date().toISOString(),
      });
    } else if (msg.type === 'tool_result') {
      if (!isCurrentSessionEvent) return;
      const toolName = resolveDisplayToolName(payload, payload.input, payload.output);
      const actionLabel = resolveToolActionLabel(toolName, payload.input);
      const category = resolveToolCategoryLabel(toolName, payload.input);
      const output = isRecord(payload.output) ? payload.output : null;
      if (toolName === 'context_ledger.memory' && output) {
        const focusMaxChars = parseNumberLike(output.focus_max_chars, output.focusMaxChars);
        const insertChars = parseNumberLike(output.chars);
        setRuntimeOverview((prev) => ({
          ...prev,
          ...(focusMaxChars !== undefined ? { ledgerFocusMaxChars: focusMaxChars } : {}),
          ...(insertChars !== undefined ? { lastLedgerInsertChars: insertChars } : {}),
          updatedAt: new Date().toISOString(),
        }));
      }
      setAgentRunStatus({
        phase: 'running',
        text: `${category}工具完成：${actionLabel}，继续处理中...`,
        updatedAt: new Date().toISOString(),
      });
    } else if (msg.type === 'tool_error') {
      if (!isCurrentSessionEvent) return;
      const toolName = resolveDisplayToolName(payload, payload.input, payload.output);
      const actionLabel = resolveToolActionLabel(toolName, payload.input);
      const category = resolveToolCategoryLabel(toolName, payload.input);
      setAgentRunStatus({
        phase: 'error',
        text: `${category}工具失败：${actionLabel}`,
        updatedAt: new Date().toISOString(),
      });
    } else if (msg.type === 'assistant_complete') {
      setAgentRunStatus({
        phase: 'idle',
        text: '本轮已完成',
        updatedAt: new Date().toISOString(),
      });
      if (isCurrentSessionEvent) {
        scheduleSessionMessagesRefresh();
      }
    }

    if (msg.type === 'phase_transition') {
      if (!isCurrentSessionEvent) return;
      const to = typeof payload.to === 'string' ? payload.to.trim() : '';
      if (to.length > 0) {
        const uiState = mapOrchestratorPhaseToUiState(to);
        const phaseLabel = describeOrchestratorPhase(to);
        setExecutionState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            status: uiState.status,
            ...(uiState.fsmState ? { fsmState: uiState.fsmState } : {}),
            orchestratorPhase: to,
            paused: uiState.paused,
          };
        });
        setAgentRunStatus({
          phase: uiState.runPhase,
          text: `编排阶段：${phaseLabel}`,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    if (msg.type === 'workflow_update') {
      const workflowPayload = msg.payload as WorkflowUpdatePayload;

      if (workflowPayload.taskUpdates && workflowPayload.taskUpdates.length > 0) {
        setExecutionRounds(buildExecutionRoundsFromTasks(workflowPayload.taskUpdates));
      }
      setExecutionState((prev) => {
        if (!prev || prev.workflowId !== workflowPayload.workflowId) return prev;
        return {
          ...prev,
          status: workflowPayload.status,
          ...(workflowPayload.fsmState ? { fsmState: workflowPayload.fsmState } : {}),
          orchestrator: workflowPayload.orchestratorState
            ? {
                ...prev.orchestrator,
                currentRound: workflowPayload.orchestratorState.round,
                thought: workflowPayload.orchestratorState.thought,
              }
            : prev.orchestrator,
          tasks: workflowPayload.taskUpdates || prev.tasks,
          agents: workflowPayload.agentUpdates || prev.agents,
          executionPath: workflowPayload.executionPath || prev.executionPath,
          userInput: workflowPayload.userInput || prev.userInput,
          paused: workflowPayload.status === 'paused' ? true : workflowPayload.status === 'executing' ? false : prev.paused,
        };
      });
      // workflow_update 只用于状态更新，不再生成会话面板占位消息
      return;
    }

    if (msg.type === 'agent_update') {
      const payload = msg.payload as AgentUpdatePayload;
      setExecutionState((prev) => {
        if (!prev) return prev;
        const updatedAgents = prev.agents.map((agent) =>
          agent.id === payload.agentId
            ? {
                ...agent,
                status: payload.status,
                currentTaskId: payload.currentTaskId,
                load: payload.load,
              }
            : agent,
        );
        // 当新 agent 出现时添加到列表
        if (!updatedAgents.some((agent) => agent.id === payload.agentId)) {
          updatedAgents.push({
            id: payload.agentId,
            name: payload.agentId,
            type: inferAgentType(payload.agentId),
            status: payload.status,
            load: payload.load || 0,
            errorRate: 0,
            requestCount: 0,
            tokenUsage: 0,
            currentTaskId: payload.currentTaskId,
          });
        }
        return { ...prev, agents: updatedAgents };
      });
      return;
    }

    // 处理输入锁事件
    if (msg.type === 'input_lock_changed') {
      const lockPayload = parseInputLockState(msg.payload);
      if (lockPayload) {
        setInputLockState(lockPayload);
      }
      return;
    }

    if (msg.type === 'typing_indicator') {
      // 更新正在输入状态，但不改变锁持有者
      const typingPayload = isRecord(msg.payload) ? msg.payload : null;
      const typingClientId = typingPayload && typeof typingPayload.clientId === 'string' ? typingPayload.clientId : '';
      const typing = typingPayload ? typingPayload.typing === true : false;
      setInputLockState((prev) => {
        if (!prev || prev.lockedBy !== typingClientId) return prev;
        return { ...prev, typing };
      });
      return;
    }

    if (msg.type === 'input_lock_heartbeat_ack') {
      if (msg.sessionId !== sessionId) return;
      if (msg.alive === false) {
        setInputLockState((prev) => {
          if (!prev) return prev;
          return {
            sessionId: prev.sessionId,
            lockedBy: null,
            lockedAt: null,
            typing: false,
            lastHeartbeatAt: null,
            expiresAt: null,
          };
        });
        return;
      }
      const nextState = parseInputLockState(msg.state);
      if (nextState) {
        setInputLockState(nextState);
      }
      return;
    }
  }, [pushDebugSnapshot, scheduleSessionMessagesRefresh, sessionId]);

  const handleWebSocketMessage = useCallback((msg: WsMessage) => {
    const payload = isRecord(msg.payload) ? msg.payload : {};
    const messageSessionId =
      (typeof msg.sessionId === 'string' ? msg.sessionId : undefined)
      ?? (typeof payload.sessionId === 'string' ? payload.sessionId : undefined);
    if (isSessionBoundWsMessage(msg.type)) {
      if (!messageSessionId) return;
      if (messageSessionId !== sessionId) return;
      if (!sessionHydratedRef.current) {
        deferredWsEventsRef.current.push(msg);
        return;
      }
    }
    processWebSocketMessage(msg);
  }, [processWebSocketMessage, sessionId]);

  const { isConnected, getClientId, send: sendWs } = useWebSocket(handleWebSocketMessage);

  // 输入锁状态
  const [inputLockState, setInputLockState] = useState<InputLockState | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const lockHeartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lockAcquireTokenRef = useRef(0);

  const stopLockHeartbeat = useCallback(() => {
    if (lockHeartbeatTimerRef.current) {
      clearInterval(lockHeartbeatTimerRef.current);
      lockHeartbeatTimerRef.current = null;
    }
  }, []);

  const startLockHeartbeat = useCallback(() => {
    if (!sessionId || !clientId) return;
    stopLockHeartbeat();
    lockHeartbeatTimerRef.current = setInterval(() => {
      sendWs({ type: 'input_lock_heartbeat', sessionId });
    }, 8000);
  }, [clientId, sendWs, sessionId, stopLockHeartbeat]);

  // 更新 clientId
  useEffect(() => {
    const id = getClientId();
    if (id && id !== clientId) {
      setClientId(id);
    }
  }, [getClientId, clientId, isConnected]);

  // 查询初始锁状态
  useEffect(() => {
    if (!sessionId || !isConnected) return;
    fetch(`/api/v1/input-lock/${sessionId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.state) {
          setInputLockState(data.state);
        }
      })
      .catch(() => {});
  }, [sessionId, isConnected]);

  // 锁状态变化时自动启动/停止心跳
  useEffect(() => {
    if (inputLockState?.lockedBy && clientId && inputLockState.lockedBy === clientId) {
      startLockHeartbeat();
      return;
    }
    stopLockHeartbeat();
  }, [clientId, inputLockState?.lockedBy, startLockHeartbeat, stopLockHeartbeat]);

  useEffect(() => {
    return () => stopLockHeartbeat();
  }, [stopLockHeartbeat]);

  // 获取输入锁
  const acquireInputLock = useCallback(async (): Promise<boolean> => {
    // Fail-open: lock is best-effort coordination and should not block user send path.
    if (!sessionId || !isConnected) return true;
    const acquireToken = ++lockAcquireTokenRef.current;
    return new Promise((resolve) => {
      const handler = (msg: WsMessage) => {
        if (msg.type === 'input_lock_result') {
          if (msg.sessionId !== sessionId) return;
          if (typeof msg.acquired !== 'boolean') return;
          if (acquireToken !== lockAcquireTokenRef.current) return;

          unsubscribe();
          if (timeoutHandle) clearTimeout(timeoutHandle);

          if (msg.acquired) {
            const next = parseInputLockState(msg.state) ?? {
              sessionId,
              lockedBy: clientId,
              lockedAt: new Date().toISOString(),
              typing: true,
              lastHeartbeatAt: new Date().toISOString(),
              expiresAt: null,
            };
            setInputLockState(next);
            sendWs({ type: 'typing_indicator', sessionId, typing: true });
            startLockHeartbeat();
          }
          resolve(msg.acquired);
        }
      };

      // 临时订阅
      const wsClient = getWebSocket();
      const unsubscribe = wsClient.onMessage(handler);
      sendWs({ type: 'input_lock_acquire', sessionId });

      // 超时处理
      const timeoutHandle = setTimeout(() => {
        unsubscribe();
        // Fail-open on timeout to avoid silently dropping user inputs.
        resolve(true);
      }, 5000);
    });
  }, [isConnected, sessionId, clientId, sendWs, startLockHeartbeat]);

  // 释放输入锁
  const releaseInputLock = useCallback(() => {
    if (!sessionId) return;
    stopLockHeartbeat();
    sendWs({ type: 'typing_indicator', sessionId, typing: false });
    sendWs({ type: 'input_lock_release', sessionId });
    setInputLockState((prev) => {
      if (prev?.lockedBy === clientId) {
        return {
          sessionId,
          lockedBy: null,
          lockedAt: null,
          typing: false,
          lastHeartbeatAt: null,
          expiresAt: null,
        };
      }
      return prev;
    });
  }, [sessionId, clientId, sendWs, stopLockHeartbeat]);

  const loadSessionMessages = useCallback(async (defaultAgentId?: string) => {
    try {
      const response = await fetch(`/api/v1/sessions/${sessionId}/messages?limit=${SESSION_MESSAGES_FETCH_LIMIT}`);
      if (!response.ok) return;

      const payload = (await response.json()) as { success?: boolean; messages?: Array<Record<string, unknown>> };
      if (!payload.success || !Array.isArray(payload.messages)) return;

      const sortedMessages = payload.messages
        .slice()
        .sort((a, b) => new Date(String(a.timestamp ?? '')).getTime() - new Date(String(b.timestamp ?? '')).getTime());
      const agentId = typeof defaultAgentId === 'string' && defaultAgentId.trim().length > 0
        ? defaultAgentId.trim()
        : sessionAgentId;
      const typedMessages = sortedMessages.filter((message): message is {
        id: string;
        role: 'user' | 'assistant' | 'system' | 'orchestrator';
        content: string;
        timestamp: string;
      } => typeof message.id === 'string' && typeof message.role === 'string' && typeof message.timestamp === 'string');
      const mappedEvents = typedMessages.map((message) => mapSessionMessageToRuntimeEvent(message, agentId));
      setRuntimeEvents(mappedEvents);
      setUserRounds(buildUserRoundsFromSessionMessages(typedMessages));
    } catch {
      // keep current UI state if load fails
    }
  }, [sessionAgentId, sessionId]);

  useEffect(() => {
    loadSessionMessagesRef.current = () => {
      void loadSessionMessages();
    };
    return () => {
      loadSessionMessagesRef.current = null;
    };
  }, [loadSessionMessages]);

  useEffect(() => {
    return () => {
      if (sessionRefreshTimerRef.current) {
        clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = null;
      }
    };
  }, [sessionId]);

  const loadSessionMeta = useCallback(async (): Promise<string> => {
    try {
      const response = await fetch(`/api/v1/sessions/${sessionId}`);
      if (!response.ok) return DEFAULT_CHAT_AGENT_ID;
      const payload = (await response.json()) as { ownerAgentId?: string };
      if (typeof payload.ownerAgentId === 'string' && payload.ownerAgentId.trim().length > 0) {
        const resolved = payload.ownerAgentId.trim();
        setSessionAgentId(resolved);
        return resolved;
      }
      setSessionAgentId(DEFAULT_CHAT_AGENT_ID);
      return DEFAULT_CHAT_AGENT_ID;
    } catch {
      setSessionAgentId(DEFAULT_CHAT_AGENT_ID);
      return DEFAULT_CHAT_AGENT_ID;
    }
  }, [sessionId]);

  const refreshToolPanelOverview = useCallback(async () => {
    try {
      const [toolsRes, policyRes] = await Promise.all([
        fetch('/api/v1/tools'),
        fetch(`/api/v1/tools/agents/${encodeURIComponent(DEFAULT_CHAT_AGENT_ID)}/policy`),
      ]);
      if (!toolsRes.ok || !policyRes.ok) return;
      const toolsPayload = (await toolsRes.json()) as { success?: boolean; tools?: Array<Record<string, unknown>> };
      const policyPayload = (await policyRes.json()) as { success?: boolean; policy?: Record<string, unknown> };
      if (!toolsPayload.success || !Array.isArray(toolsPayload.tools) || !policyPayload.success) return;

      const availableTools = Array.from(new Set(
        toolsPayload.tools
          .filter((item) => isRecord(item))
          .filter((item) => (typeof item.policy === 'string' ? item.policy : 'allow') === 'allow')
          .map((item) => (typeof item.name === 'string' ? normalizeToolName(item.name) : ''))
          .filter((name) => name.length > 0),
      )).sort();

      const policy = isRecord(policyPayload.policy) ? policyPayload.policy : {};
      const whitelist = normalizeToolNameList(policy.whitelist);
      const blacklistSet = new Set(normalizeToolNameList(policy.blacklist));
      const exposedBase = whitelist.length > 0 ? whitelist : availableTools;
      const exposedTools = exposedBase.filter((name) => !blacklistSet.has(name)).sort();

      setToolPanelOverview((prev) => ({
        ...prev,
        availableTools,
        exposedTools,
      }));
    } catch {
      // ignore tool panel refresh failures
    }
  }, []);

  const updateToolExposure = useCallback(async (tools: string[]): Promise<boolean> => {
    const normalized = Array.from(
      new Set(
        tools
          .filter((item) => typeof item === 'string')
          .map((item) => normalizeToolName(item))
          .filter((item) => item.length > 0),
      ),
    ).sort();

    try {
      const response = await fetch(`/api/v1/tools/agents/${encodeURIComponent(DEFAULT_CHAT_AGENT_ID)}/policy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ whitelist: normalized, blacklist: [] }),
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as { success?: boolean; policy?: { whitelist?: unknown } };
      if (!payload.success) return false;
      const whitelist = normalizeToolNameList(payload.policy?.whitelist);
      setToolPanelOverview((prev) => ({
        ...prev,
        exposedTools: whitelist.sort(),
      }));
      void refreshToolPanelOverview();
      return true;
    } catch {
      return false;
    }
  }, [refreshToolPanelOverview]);

  const refreshOrchestratorRuntimeMode = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/orchestrator/runtime-mode');
      if (!response.ok) return;
      const payload = await response.json() as {
        success?: boolean;
        mode?: string;
        fsmV2Implemented?: boolean;
        runnerModuleId?: string;
      };
      if (!payload.success || typeof payload.mode !== 'string' || payload.mode.trim().length === 0) return;
      setOrchestratorRuntimeMode({
        mode: payload.mode,
        fsmV2Implemented: payload.fsmV2Implemented === true,
        ...(typeof payload.runnerModuleId === 'string' && payload.runnerModuleId.trim().length > 0
          ? { runnerModuleId: payload.runnerModuleId.trim() }
          : {}),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // ignore runtime mode refresh failures
    }
  }, []);

  const patchSessionMessage = useCallback(async (messageId: string, content: string): Promise<boolean> => {
    const response = await fetch(`/api/v1/sessions/${sessionId}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return response.ok;
  }, [sessionId]);

  const removeSessionMessage = useCallback(async (messageId: string): Promise<boolean> => {
    const response = await fetch(`/api/v1/sessions/${sessionId}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
    return response.ok;
  }, [sessionId]);

  useEffect(() => {
    sessionHydratedRef.current = false;
    deferredWsEventsRef.current = [];
    setRuntimeEvents([]);
    setUserRounds([]);
    setRuntimeOverview({
      ledgerFocusMaxChars: DEFAULT_LEDGER_FOCUS_MAX_CHARS,
      compactCount: 0,
      updatedAt: new Date().toISOString(),
    });
    setToolPanelOverview({
      availableTools: [],
      exposedTools: [],
    });
    setAgentRunStatus({
      phase: 'idle',
      text: '已就绪',
      updatedAt: new Date().toISOString(),
    });
    const hydrateSession = async () => {
      const agentId = await loadSessionMeta();
      await loadSessionMessages(agentId);
      sessionHydratedRef.current = true;
      const queued = deferredWsEventsRef.current;
      deferredWsEventsRef.current = [];
      queued.forEach((item) => processWebSocketMessage(item));
    };
    void hydrateSession();
    void refreshToolPanelOverview();
    void refreshOrchestratorRuntimeMode();
  }, [loadSessionMessages, loadSessionMeta, processWebSocketMessage, refreshOrchestratorRuntimeMode, refreshToolPanelOverview]);

  const refreshRuntimeState = useCallback(async () => {
    try {
      const [workflowsRes, logsRes] = await Promise.all([
        fetch('/api/v1/workflows'),
        fetch('/api/v1/execution-logs'),
      ]);

      if (!workflowsRes.ok || !logsRes.ok) {
        return;
      }

      const workflows = (await workflowsRes.json()) as WorkflowInfo[];
      const logsPayload = (await logsRes.json()) as { success: boolean; logs: SessionLog[] };
      const allLogs = logsPayload.success ? logsPayload.logs : [];
      const scopedLogs = allLogs.filter((log) => log.sessionId === sessionId);
      setLogs(scopedLogs);

      const preferredWorkflowId = executionStateRef.current?.workflowId || workflow?.id;
      const selectedWorkflow = pickWorkflowForSession(workflows, sessionId, preferredWorkflowId);
      
      // Always set workflow state, even if empty
      setWorkflow(selectedWorkflow);
      
      if (!selectedWorkflow) {
        // No workflow found - show empty state with default orchestrator agent
        setExecutionState({
          workflowId: `empty-${sessionId}`,
          status: 'planning',
          fsmState: 'idle',
          orchestratorPhase: 'idle',
          orchestrator: {
            id: DEFAULT_CHAT_AGENT_ID,
            currentRound: 0,
            maxRounds: 10,
          },
          agents: [{
            id: DEFAULT_CHAT_AGENT_ID,
            name: DEFAULT_CHAT_AGENT_ID,
            type: 'orchestrator',
            status: 'idle',
            load: 0,
            errorRate: 0,
            requestCount: 0,
            tokenUsage: 0,
          }],
          tasks: [],
          executionPath: [],
          paused: false,
          executionRounds: [],
        });
        return;
      }

      const tasksRes = await fetch(`/api/v1/workflows/${selectedWorkflow.id}/tasks`);
      const taskList = tasksRes.ok ? ((await tasksRes.json()) as TaskNode[]) : [];

      const latestByAgent = new Map<string, SessionLog>();
      for (const log of scopedLogs) {
        const existing = latestByAgent.get(log.agentId);
        if (!existing || new Date(log.startTime).getTime() > new Date(existing.startTime).getTime()) {
          latestByAgent.set(log.agentId, log);
        }
      }

      const agentsFromLogs: AgentRuntime[] = Array.from(latestByAgent.values()).map((log) => {
        const currentRound = log.iterations.length;
        const load = computeAgentLoadFromLog(log);

        return {
          id: log.agentId,
          name: log.agentId,
          type: inferAgentType(log.agentId),
          status: inferAgentStatus(log),
          load,
          errorRate: log.finalError ? 100 : 0,
          requestCount: currentRound,
          tokenUsage: 0,
          currentTaskId: log.taskId,
        };
      });

      const assigneeSet = new Set(taskList.map((task) => task.assignee).filter((v): v is string => Boolean(v)));
      const agentsWithAssignees = [...agentsFromLogs];
      for (const assignee of assigneeSet) {
        if (!agentsWithAssignees.some((agent) => agent.id === assignee)) {
          agentsWithAssignees.push({
            id: assignee,
            name: assignee,
            type: inferAgentType(assignee),
            status: 'idle',
            load: 0,
            errorRate: 0,
            requestCount: 0,
            tokenUsage: 0,
          });
        }
      }

      if (!agentsWithAssignees.some((agent) => agent.type === 'orchestrator')) {
        agentsWithAssignees.push({
          id: DEFAULT_CHAT_AGENT_ID,
          name: DEFAULT_CHAT_AGENT_ID,
          type: 'orchestrator',
          status: selectedWorkflow.status === 'failed' ? 'error' : selectedWorkflow.status === 'paused' ? 'paused' : 'running',
          load: 0,
          errorRate: 0,
          requestCount: 0,
          tokenUsage: 0,
        });
      }

      const orchestratorLog = Array.from(latestByAgent.values())
        .filter((log) => inferAgentType(log.agentId) === 'orchestrator')
        .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())[0];

      const executionPath = buildRoundExecutionPath(taskList, DEFAULT_CHAT_AGENT_ID);

      setExecutionState((prev) => ({
        workflowId: selectedWorkflow.id,
        status: selectedWorkflow.status,
        fsmState: selectedWorkflow.fsmState ?? prev?.fsmState,
        orchestratorPhase: prev?.orchestratorPhase ?? selectedWorkflow.fsmState,
        orchestrator: {
          id: DEFAULT_CHAT_AGENT_ID,
          currentRound: orchestratorLog?.iterations.length || prev?.orchestrator.currentRound || 0,
          maxRounds: Math.max(orchestratorLog?.totalRounds || 10, 1),
          thought: orchestratorLog?.iterations[orchestratorLog.iterations.length - 1]?.thought,
        },
        agents: agentsWithAssignees,
        tasks: taskList,
        executionPath,
        paused: selectedWorkflow.status === 'paused',
        userInput: prev?.userInput,
        executionRounds: prev?.executionRounds || [],
      }));

      // 根据任务状态构建执行轮次并更新状态
      const rounds = buildExecutionRoundsFromTasks(taskList);
      setExecutionRounds(rounds);
    } catch {
      // keep current UI state if polling fails
    }
  }, [sessionId, workflow?.id]);

  useEffect(() => {
    void refreshRuntimeState();
    const timer = setInterval(() => {
      void refreshRuntimeState();
    }, 3000);
    return () => clearInterval(timer);
  }, [refreshRuntimeState]);

  useEffect(() => {
    void refreshOrchestratorRuntimeMode();
    const timer = setInterval(() => {
      void refreshOrchestratorRuntimeMode();
    }, 10_000);
    return () => clearInterval(timer);
  }, [refreshOrchestratorRuntimeMode]);

  const startWorkflow = useCallback(
    async (userTask: string) => {
      setIsLoading(true);
      setError(null);

      try {
        const route = resolveMessageRoute();
        const res = await fetch('/api/v1/message', {
          method: 'POST',
          headers: route.headers,
          body: JSON.stringify({
            target: route.target,
            message: { text: userTask, content: userTask, sessionId },
            blocking: false,
          }),
        });

        if (!res.ok) {
          throw new Error(`Failed to start workflow: ${res.status}`);
        }

        setExecutionState({
          workflowId: workflow?.id || `pending-${Date.now()}`,
          status: 'planning',
          fsmState: 'plan_loop',
          orchestratorPhase: 'intake',
          orchestrator: {
            id: DEFAULT_CHAT_AGENT_ID,
            currentRound: 0,
            maxRounds: 10,
          },
          agents: [
            {
              id: DEFAULT_CHAT_AGENT_ID,
              name: DEFAULT_CHAT_AGENT_ID,
              type: 'orchestrator',
              status: 'running',
              load: 1,
              errorRate: 0,
              requestCount: 0,
              tokenUsage: 0,
            },
          ],
          tasks: [],
          executionPath: [],
          paused: false,
          executionRounds: [],
        });

        await refreshRuntimeState();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to start workflow');
      } finally {
        setIsLoading(false);
      }
    },
    [refreshRuntimeState, resolveMessageRoute, sessionId, workflow?.id],
  );

  const pauseWorkflow = useCallback(async () => {
    if (!executionState) return;

    try {
      await fetch('/api/v1/workflow/pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: executionState.workflowId,
          hard: true,
        }),
      });
      setAgentRunStatus({
        phase: 'idle',
        text: '执行已暂停',
        updatedAt: new Date().toISOString(),
      });

      setExecutionState((prev) => (prev ? { ...prev, paused: true, status: 'paused', fsmState: 'paused' } : prev));
    } catch {
      // ignore pause failure in UI
    }
  }, [executionState]);

  const resumeWorkflow = useCallback(async () => {
    if (!executionState) return;

    try {
      await fetch('/api/v1/workflow/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: executionState.workflowId,
        }),
      });
      setAgentRunStatus({
        phase: 'running',
        text: '执行已恢复',
        updatedAt: new Date().toISOString(),
      });

      setExecutionState((prev) => (prev ? { ...prev, paused: false, status: 'executing', fsmState: 'execution' } : prev));
    } catch {
      // ignore resume failure in UI
    }
  }, [executionState]);

  const interruptCurrentTurn = useCallback(async (): Promise<boolean> => {
    const activeAbort = inFlightSendAbortRef.current;
    if (activeAbort) {
      activeAbort.abort();
    }
    try {
      const res = await fetch(`/api/v1/finger-general/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await safeParseJson(res);
      if (!res.ok) {
        const message = extractErrorMessageFromBody(body) ?? `HTTP ${res.status}`;
        throw new Error(message);
      }
      const interrupted = body?.interrupted === true;
      setAgentRunStatus({
        phase: 'idle',
        text: interrupted ? '已停止当前回合' : '当前没有可停止的回合',
        updatedAt: new Date().toISOString(),
      });
      return interrupted;
    } catch (error) {
      const message = error instanceof Error ? error.message : '停止当前回合失败';
      setAgentRunStatus({
        phase: 'error',
        text: `停止失败：${message}`,
        updatedAt: new Date().toISOString(),
      });
      return false;
    }
  }, [sessionId]);

  const sendUserInput = useCallback(
  async (inputPayload: UserInputPayload) => {
    const text = inputPayload.text.trim();
    const images = inputPayload.images ?? [];
    const files = inputPayload.files ?? [];
    const review = normalizeReviewSettings(inputPayload.review);
    const planModeEnabled = inputPayload.planModeEnabled === true;
    if (!text && images.length === 0 && files.length === 0) return;
      if (text === '/compact' && images.length === 0 && files.length === 0) {
      try {
        const compactRes = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/compress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const compactBody = await safeParseJson(compactRes);
        if (!compactRes.ok) {
          const compactError = extractErrorMessageFromBody(compactBody) ?? `HTTP ${compactRes.status}`;
          throw new Error(compactError);
        }
        setRuntimeOverview((prev) => ({
          ...prev,
          compactCount: prev.compactCount + 1,
          updatedAt: new Date().toISOString(),
        }));
        setAgentRunStatus({
          phase: 'idle',
          text: (() => {
            const summary = extractCompactSummary(compactBody);
            return summary ? `上下文压缩完成：${summary}` : '上下文压缩完成';
          })(),
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '上下文压缩失败';
        setAgentRunStatus({
          phase: 'error',
          text: `压缩失败：${message}`,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }
    const inputItems = buildKernelInputItems(text, images, files);
    const displayText = text || (images.length > 0 || files.length > 0 ? '[附件输入]' : '');

    const eventTime = new Date().toISOString();

    const route = resolveMessageRoute();
    setAgentRunStatus({
      phase: 'running',
      text: route.directTest
        ? `测试直连 ${route.target} 执行中...`
        : review
          ? `finger-general 正在思考（${planModeEnabled ? '计划模式 · ' : ''}Review: ${review.strictness === 'strict' ? '严格' : '主线'}, 上限 ${review.maxTurns}）...`
          : `finger-general 正在思考${planModeEnabled ? '（计划模式）' : ''}...`,
      updatedAt: new Date().toISOString(),
    });

    // 3. 统一走 finger orchestrator gateway
    try {
      try {
        await loadSessionMessages();
      } catch {
        // keep going even if session persistence fails
      }
      const history = buildGatewayHistory(
        [
          ...runtimeEventsRef.current,
          {
            id: `${eventTime}-pending-local`,
            role: 'user',
            content: displayText,
            timestamp: eventTime,
            kind: 'status',
            agentId: 'pending',
          },
        ],
        CONTEXT_HISTORY_WINDOW_SIZE,
      );

      const abortController = new AbortController();
      inFlightSendAbortRef.current = abortController;
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const requestBody = {
        target: route.target,
        blocking: true,
        message: {
          text: displayText,
          sessionId,
          history,
          deliveryMode: 'sync',
          metadata: {
            inputItems,
            mode: planModeEnabled ? 'plan' : 'main',
            kernelMode: planModeEnabled ? 'plan' : 'main',
            planModeEnabled,
            includePlanTool: planModeEnabled,
            ...(review
              ? {
                  review,
                }
              : {}),
          },
          ...(toolPanelOverview.exposedTools.length > 0
            ? { tools: toolPanelOverview.exposedTools }
            : {}),
        },
      };
      pushDebugSnapshot({
        stage: 'request_build',
        requestId,
        summary: `message request built -> ${route.target}`,
        payload: {
          target: route.target,
          directTest: route.directTest,
          historyCount: history.length,
          hasReview: review !== null,
          planModeEnabled,
          message: requestBody.message,
        },
      });

      let responseData: { result?: unknown; error?: string } | null = null;
      let attempt = 1;
      for (; attempt <= SEND_RETRY_MAX_ATTEMPTS; attempt += 1) {
        let responseStatus: number | undefined;
        try {
          pushDebugSnapshot({
            stage: 'request_attempt',
            requestId,
            attempt,
            summary: `attempt ${attempt}/${SEND_RETRY_MAX_ATTEMPTS}`,
            payload: {
              url: '/api/v1/message',
              target: route.target,
            },
          });
          const res = await fetch('/api/v1/message', {
            method: 'POST',
            headers: route.headers,
            signal: abortController.signal,
            body: JSON.stringify(requestBody),
          });
          responseStatus = res.status;
          if (!res.ok) {
            const failureBody = await safeParseJson(res);
            const message = extractErrorMessageFromBody(failureBody) ?? `HTTP ${res.status}`;
            pushDebugSnapshot({
              stage: 'request_error',
              requestId,
              attempt,
              summary: `attempt ${attempt} failed: HTTP ${res.status}`,
              payload: failureBody,
            });
            const wrapped = message.startsWith('HTTP') ? message : `HTTP ${res.status}: ${message}`;
            throw new Error(wrapped);
          }
          responseData = (await res.json()) as { result?: unknown; error?: string } | null;
          if (!responseData || responseData.error) {
            pushDebugSnapshot({
              stage: 'request_error',
              requestId,
              attempt,
              summary: `attempt ${attempt} failed: invalid response body`,
              payload: responseData,
            });
            throw new Error(responseData?.error || 'Empty response from daemon');
          }
          pushDebugSnapshot({
            stage: 'request_ok',
            requestId,
            attempt,
            summary: `attempt ${attempt} succeeded`,
            payload: {
              status: res.status,
              hasResult: responseData?.result !== undefined,
            },
          });
          break;
        } catch (error) {
          if (isAbortError(error)) throw error;
          const errorMessage = error instanceof Error ? error.message : String(error);
          const inferredStatus = responseStatus ?? extractStatusCodeFromErrorMessage(errorMessage);
          pushDebugSnapshot({
            stage: 'request_error',
            requestId,
            attempt,
            summary: `attempt ${attempt} error: ${errorMessage}`,
            payload: {
              inferredStatus,
            },
          });
          const canRetry = attempt < SEND_RETRY_MAX_ATTEMPTS && shouldRetryChatRequest(inferredStatus, errorMessage);
          if (!canRetry) {
            throw error;
          }
          const backoffMs = parseRetryAfterMs(attempt, SEND_RETRY_BASE_DELAY_MS);
          const waitSeconds = Math.max(1, Math.ceil(backoffMs / 1000));
          setAgentRunStatus({
            phase: 'running',
            text: `请求失败，${waitSeconds}s 后自动重试（${attempt}/${SEND_RETRY_MAX_ATTEMPTS}）...`,
            updatedAt: new Date().toISOString(),
          });
          await sleep(backoffMs);
        }
      }

      if (!responseData) {
        throw new Error('Empty response from daemon');
      }

      if (!responseData || responseData.error) {
        throw new Error(responseData?.error || 'Empty response from daemon');
      }
      const { tokenUsage, pendingInputAccepted } = extractChatReply(responseData.result);
      if (pendingInputAccepted) {
        await loadSessionMessages();
        setAgentRunStatus({
          phase: 'running',
          text: '当前回合仍在执行，输入已排队...',
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      if (tokenUsage) {
        setRuntimeOverview((prev) => ({
          ...prev,
          ...(typeof tokenUsage.inputTokens === 'number' ? { reqTokens: tokenUsage.inputTokens } : {}),
          ...(typeof tokenUsage.outputTokens === 'number' ? { respTokens: tokenUsage.outputTokens } : {}),
          ...(typeof tokenUsage.totalTokens === 'number' ? { totalTokens: tokenUsage.totalTokens } : {}),
          tokenUpdatedAtLocal: new Date().toLocaleString(),
          updatedAt: new Date().toISOString(),
        }));
      }
      if (isRecord(responseData.result) && isRecord(responseData.result.metadata)) {
        const metadata = responseData.result.metadata;
        const slotIdsRaw = metadata.contextSlotIds ?? metadata.context_slot_ids ?? metadata.contextSlotIds;
        const trimmedIdsRaw = metadata.contextSlotTrimmedIds ?? metadata.context_slot_trimmed_ids ?? metadata.contextSlotTrimmedIds;
        const slotIds = Array.isArray(slotIdsRaw)
          ? slotIdsRaw.filter((item): item is string => typeof item === 'string')
          : [];
        const trimmedIds = Array.isArray(trimmedIdsRaw)
          ? trimmedIdsRaw.filter((item): item is string => typeof item === 'string')
          : [];
        if (slotIds.length > 0 || trimmedIds.length > 0) {
          pushDebugSnapshot({
            stage: 'request_ok',
            summary: 'context slots rendered',
            payload: { slotIds, trimmedIds },
          });
        }
        const focusMaxChars = parseNumberLike(
          metadata.contextLedgerFocusMaxChars,
          metadata.context_ledger_focus_max_chars,
        );
        const contextUsagePercent = parseNumberLike(
          metadata.context_usage_percent,
          metadata.contextUsagePercent,
          metadata.context_budget_usage_percent,
          isRecord(metadata.context_budget) ? metadata.context_budget.context_usage_percent : undefined,
        );
        const contextTokens = parseNumberLike(
          metadata.estimated_tokens_in_context_window,
          metadata.estimatedTokensInContextWindow,
          isRecord(metadata.context_budget) ? metadata.context_budget.estimated_tokens_in_context_window : undefined,
        );
        const contextMaxInputTokens = parseNumberLike(
          metadata.max_input_tokens,
          metadata.maxInputTokens,
          isRecord(metadata.context_budget) ? metadata.context_budget.max_input_tokens : undefined,
        );
        const contextThresholdPercent = parseNumberLike(
          metadata.threshold_percent,
          metadata.thresholdPercent,
          isRecord(metadata.context_budget) && typeof metadata.context_budget.threshold_ratio === 'number'
            ? metadata.context_budget.threshold_ratio * 100
            : undefined,
        );
        const effectiveContextUsagePercent = contextUsagePercent
          ?? computeContextUsagePercent(contextTokens, contextMaxInputTokens);
        const roundTraceUsage = extractTokenUsageFromRoundTrace(metadata);
        const exposedToolsFromMetadata = normalizeToolNameList(metadata.tools);
        if (exposedToolsFromMetadata.length > 0) {
          setToolPanelOverview((prev) => ({
            availableTools: prev.availableTools,
            exposedTools: exposedToolsFromMetadata,
          }));
        }
        if (
          focusMaxChars !== undefined
          || effectiveContextUsagePercent !== undefined
          || contextTokens !== undefined
          || contextMaxInputTokens !== undefined
          || contextThresholdPercent !== undefined
          || roundTraceUsage
        ) {
          setRuntimeOverview((prev) => ({
            ...prev,
            ...(focusMaxChars !== undefined ? { ledgerFocusMaxChars: focusMaxChars } : {}),
            ...(effectiveContextUsagePercent !== undefined ? { contextUsagePercent: effectiveContextUsagePercent } : {}),
            ...(contextTokens !== undefined ? { contextTokensInWindow: contextTokens } : {}),
            ...(contextMaxInputTokens !== undefined ? { contextMaxInputTokens } : {}),
            ...(contextThresholdPercent !== undefined ? { contextThresholdPercent } : {}),
            ...(roundTraceUsage?.inputTokens !== undefined ? { reqTokens: roundTraceUsage.inputTokens } : {}),
            ...(roundTraceUsage?.outputTokens !== undefined ? { respTokens: roundTraceUsage.outputTokens } : {}),
            ...(roundTraceUsage?.totalTokens !== undefined ? { totalTokens: roundTraceUsage.totalTokens } : {}),
            ...((roundTraceUsage?.inputTokens !== undefined
              || roundTraceUsage?.outputTokens !== undefined
              || roundTraceUsage?.totalTokens !== undefined)
              ? { tokenUpdatedAtLocal: new Date().toLocaleString() }
              : {}),
            updatedAt: new Date().toISOString(),
          }));
        }
      }
      await loadSessionMessages();

      setExecutionState((prev) => (prev ? { ...prev, userInput: displayText } : prev));
      setAgentRunStatus({
        phase: 'idle',
        text: '本轮已完成',
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (isAbortError(err)) {
        await loadSessionMessages();
        setAgentRunStatus({
          phase: 'idle',
          text: '当前回合已中止',
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      const interruptedByUser =
        err instanceof Error && err.message.toLowerCase().includes('interrupted by user');
      if (interruptedByUser) {
        await loadSessionMessages();
        setAgentRunStatus({
          phase: 'idle',
          text: '当前回合已停止',
          updatedAt: new Date().toISOString(),
        });
        return;
      }
      // 6. API 失败：更新事件为 error 并追加错误事件
      await loadSessionMessages();

      const errorMsg = err instanceof Error ? err.message : '发送失败';
      setAgentRunStatus({
        phase: 'error',
        text: `执行失败：${errorMsg}`,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      inFlightSendAbortRef.current = null;
    }
  },
  [loadSessionMessages, pushDebugSnapshot, resolveMessageRoute, sessionId, toolPanelOverview.exposedTools],
);

  const editRuntimeEvent = useCallback(async (eventId: string, content: string): Promise<boolean> => {
    const normalized = content.trim();
    if (normalized.length === 0) {
      return false;
    }

  const current = runtimeEventsRef.current.find((event) => event.id === eventId);
  if (!current || (current.role !== 'user' && current.role !== 'agent')) {
    return false;
  }

  setRuntimeEvents((prev) => prev.map((event) => (event.id === eventId ? { ...event, content: normalized } : event)));

  if (!isPersistedSessionMessageId(eventId)) {
    return true;
  }

  const updated = await patchSessionMessage(eventId, normalized);
  if (!updated) {
    await loadSessionMessages();
    return false;
  }
  await loadSessionMessages();
  return true;
}, [loadSessionMessages, patchSessionMessage]);

const deleteRuntimeEvent = useCallback(async (eventId: string): Promise<boolean> => {
  const current = runtimeEventsRef.current.find((event) => event.id === eventId);
  if (!current || (current.role !== 'user' && current.role !== 'agent')) {
    return false;
  }

  setRuntimeEvents((prev) => prev.filter((event) => event.id !== eventId));
  if (!isPersistedSessionMessageId(eventId)) {
    return true;
  }

  const deleted = await removeSessionMessage(eventId);
  if (!deleted) {
    await loadSessionMessages();
    return false;
  }
  await loadSessionMessages();
  return true;
}, [loadSessionMessages, removeSessionMessage]);

const contextEditableEventIds = buildContextEditableEventIds(
  runtimeEvents,
  CONTEXT_HISTORY_WINDOW_SIZE,
);

  const getAgentDetail = useCallback(
    (agentId: string): AgentExecutionDetail | null => {
      const latestLog = logs
        .filter((log) => log.agentId === agentId)
        .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())[0];

      const agent = executionState?.agents.find((a) => a.id === agentId);
      if (!agent && !latestLog) return null;

      return {
        agentId,
        agentName: agent?.name || agentId,
        taskId: latestLog?.taskId,
        taskDescription: latestLog?.userTask,
        status: agent?.status || (latestLog ? inferAgentStatus(latestLog) : 'idle'),
        steps: (latestLog?.iterations || []).map((iteration) => ({
          round: iteration.round,
          action: iteration.action,
          thought: iteration.thought,
          params: iteration.params,
          observation: iteration.observation,
          success: iteration.success,
          timestamp: iteration.timestamp,
          duration: iteration.duration,
        })),
        currentRound: latestLog?.iterations.length || 0,
        totalRounds: latestLog?.totalRounds || latestLog?.iterations.length || 0,
        startTime: latestLog?.startTime || new Date().toISOString(),
        endTime: latestLog?.endTime,
      };
    },
    [executionState, logs],
  );

  const getTaskReport = useCallback((): TaskReport | null => {
    if (!workflow || !executionState) return null;

    const completedTasks = executionState.tasks.filter((t) => t.status === 'completed');
    const failedTasks = executionState.tasks.filter((t) => t.status === 'failed');

    return {
      workflowId: executionState.workflowId,
      epicId: workflow.epicId,
      userTask: workflow.userTask,
      status: executionState.status,
      summary: {
        totalTasks: executionState.tasks.length,
        completed: completedTasks.length,
        failed: failedTasks.length,
        success: failedTasks.length === 0 && completedTasks.length === executionState.tasks.length,
        rounds: executionState.orchestrator.currentRound,
        duration: 0,
      },
      taskDetails: executionState.tasks.map((task) => ({
        taskId: task.id,
        description: task.description,
        status: task.status,
        assignee: task.assignee,
        output: task.result?.output,
        error: task.result?.error,
      })),
      createdAt: workflow.createdAt,
      completedAt:
        executionState.status === 'completed' || executionState.status === 'failed'
          ? new Date().toISOString()
          : undefined,
    };
  }, [workflow, executionState]);

  return {
    workflow,
    executionState,
    runtimeEvents,
    userRounds,
    executionRounds,
    selectedAgentId,
    setSelectedAgentId,
    isLoading,
    error,
    startWorkflow,
    pauseWorkflow,
    resumeWorkflow,
    interruptCurrentTurn,
    sendUserInput,
    editRuntimeEvent,
    deleteRuntimeEvent,
    agentRunStatus,
    runtimeOverview,
    toolPanelOverview,
    updateToolExposure,
    contextEditableEventIds,
    getAgentDetail,
    getTaskReport,
    isConnected,
    inputLockState,
    clientId,
   acquireInputLock,
   releaseInputLock,
   debugSnapshotsEnabled,
   setDebugSnapshotsEnabled,
   debugSnapshots,
   clearDebugSnapshots,
   orchestratorRuntimeMode,
 };
}
