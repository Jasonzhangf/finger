# 2026-03-07 dispatch summary handoff

## Goal
修复 orchestrator 在子 agent 返回后直接吞入完整子会话结果，导致下一轮输入膨胀甚至 context window exceeded 的问题。

## Evidence
- 主 orchestrator 会话的 `agent.dispatch` tool_result 中包含完整 child `result.response` 与 `metadata.api_history`。
- `src/blocks/agent-runtime-block/index.ts` 原先 blocking dispatch 直接返回 `sendToModule()` 原始结果。
- `src/server/modules/event-forwarding.ts` 原先把 `payload.result` 原样序列化后推入 `runtimeInstructionBus`，导致下一轮输入并非 summary，而是完整 child payload。

## Fix
- 新增 `src/common/agent-dispatch.ts`：统一做 dispatch result 瘦身与 dispatch contract 文本构造。
- `agent-runtime-block` 现在给子 agent 注入 dispatch contract，并默认打开 structured output schema。
- blocking dispatch 返回只保留 `summary/status/keyFiles/outputs/evidence/childSessionId` 等轻量字段，不再回传 `api_history`。
- `event-forwarding` 推给 orchestrator 的反馈只包含 summary 化结果，而非完整 child payload。
- executor/orchestrator dev prompts 收紧：executor 必须用 `summary` 作为主交付字段并包含关键文件路径；orchestrator 只应消费 summary，不直接依赖 child raw transcript。

## Validation
- `pnpm vitest run tests/unit/blocks/agent-runtime-block.test.ts`
- `pnpm exec tsc -p tsconfig.json --noEmit`
- `pnpm build`

## Notes
- `pnpm build` 会自动 bump `package.json` 中的 `fingerBuildVersion`，这是仓库既有行为。
