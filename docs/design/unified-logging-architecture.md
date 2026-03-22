# Unified Logging Architecture (finger-250)

Last updated: 2026-03-22 18:58 +08:00

## 1. 背景与目标

在 finger-250 之前，日志存在三个核心问题：

1. 模块日志入口不统一（`console.*`、局部 logger 混用）
2. 调试链路断点多（dispatch / route / gateway 关键路径信息不全）
3. 快照能力存在但调用不统一，难以做系统级排障

本次改造目标：

- 所有业务模块统一接入 `src/core/logger` 体系
- 将 `console.*` 收敛到唯一合法出口（`src/core/logger/index.ts`）
- 为历史/CLI 代码提供低风险迁移层，避免一次性重写复杂格式化输出

## 2. 架构决策

### 2.1 单一日志真源

- 真源：`FingerLogger` (`src/core/logger/index.ts`)
- 模块使用：`logger.module('<ModuleName>')`
- 旧代码迁移适配：`createConsoleLikeLogger()`

### 2.2 兼容适配层（新增）

新增文件：`src/core/logger/console-like.ts`

能力：

- 提供 `log/info/warn/error/debug/clear` 同名接口
- 内部转发到 `FingerLogger`（结构化 data + error）
- 允许历史代码保留“console 语义”，但不再直出到 `console.*`

这样可以把大规模替换风险降到最低：

- 旧代码：`console.log(...)`
- 迁移后：`clog.log(...)`

## 3. 关键改造成果

### 3.1 核心链路日志补齐

- `AgentRuntimeBlock`：补齐 dispatch 执行路径日志（start/send/result/error）
- `RuntimeFacade`：接入统一 logger，替换残留 `console.warn`
- `GatewayManager`：替换 `console.*` 为结构化日志
- `message-route`：统一 `const log = logger.module('message-route')`

### 3.2 全局迁移状态

当前 `src/**` 中 `console.*` 残留：**5 处**，且全部位于：

- `src/core/logger/index.ts`

这 5 处是日志系统的控制台 sink（合法保留）。

## 4. 快照策略

当前策略：

- `FingerLogger` 已支持 `startTrace()/endTrace()` + snapshot 写盘
- 业务层通过统一 logger 接入后，可按模块与 traceId 聚合快照

后续可增强：

1. 在高价值链路（message route / dispatch / gateway）默认打 trace
2. 提供 snapshot 检索工具（按 traceId/sessionId）

## 5. 验证

本次完成后验证：

- `pnpm run build:backend` ✅
- `node scripts/prebuild-check.mjs` ✅
- `rg "console\\.(log|error|warn|info|debug)" src --type ts` 仅剩 logger sink ✅

## 6. 约束（已落盘到 AGENTS.md）

项目级强制要求：

1. 新增/修改模块必须接入统一日志系统
2. 禁止新增业务层 `console.*`
3. 代码评审必须检查关键路径日志覆盖

