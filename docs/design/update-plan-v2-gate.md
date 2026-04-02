# update_plan v2 Gate（阶段门禁）

## 目的

在进入 worker-pool 编排实现前，先确保 `update_plan v2` 已达到可用基线，避免后续项目管理建立在不稳定工具之上。

## Gate 条件（必须全部满足）

1. Contract 对齐完成（BD 风格 action + PlanItem 字段 + errorCode）。
2. 权限/范围校验完成（system 全局、worker 项目内、worker 不可改他人）。
3. CAS 并发控制完成（写操作 `expectedRevision`）。
4. 状态机/依赖校验完成（含 blockedBy 与 transition 验证）。
5. evidence + plan_event 基线完成（含 review_pending -> done 证据门禁）。
6. 单元与集成测试通过。

## 标准校验命令（唯一）

```bash
npm run test:update-plan-v2-gate
```

该命令会执行：

1. `tests/unit/tools/internal/codex-update-plan-tool.test.ts`
2. `tests/unit/tools/internal/codex-update-plan-tool-v2.test.ts`
3. `tests/integration/update-plan-v2-workflow.test.ts`
4. `npm run build:backend:raw`

## 阻断规则

若 gate 命令失败，则：

1. 不允许将 worker-pool 后续任务推进为 in_progress/completed；
2. 必须先修复失败项并重跑 gate；
3. 失败证据（测试日志/构建日志）必须附到 update_plan 相关任务 evidence 中。

