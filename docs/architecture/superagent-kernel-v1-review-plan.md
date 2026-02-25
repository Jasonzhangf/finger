# SuperAgent Kernel V1 - 现有模块 Review 与改造计划

## 1. 评审范围
- Agent 抽象与循环内核
- MessageHub/ModuleRegistry 路由主链
- Tool 注册与角色授权
- 配置来源（用户配置与系统配置）
- Rust kernel 与 TS 编排对接层

## 2. Findings（按严重级别）

## P0（必须先改）

1. Agent 抽象分裂，无法满足“统一接口 + 可嵌套 superagent”
- 证据：
- `src/agents/agent.ts:47` 定义一套 `Agent`（强绑定 iflow）
- `src/agents/base/base-agent.ts:64` 又定义另一套 `BaseAgent`（独立状态机）
- 影响：
- 调用方无法依赖单一契约，子 Agent 难以组合成稳定编排图。

2. 消息内核并行两套实现，路由语义不一致
- 证据：
- `src/orchestration/message-hub.ts:56`（MessageHub）
- `src/core/hub-core.ts:13`（HubCore）
- `src/core/daemon.ts:35`（CoreDaemon 仍基于 HubCore）
- 影响：
- 同一消息在不同路径行为不一致，导致默认入口和直达入口难统一。

3. Tool 注册体系重复，策略域割裂
- 证据：
- `src/runtime/tool-registry.ts:22`（globalToolRegistry）
- `src/agents/shared/tool-registry.ts:16`（另一套 ToolRegistry）
- 影响：
- 角色授权、策略检查、审计日志无法单点治理，违背“基础能力模块统一注册”目标。

4. 路由与模型调用缺少统一 JSON Guardrail
- 证据：
- `src/agents/router/router-agent.ts:131` 使用 `(this.client as any).chat`
- `src/agents/router/router-agent.ts:100` 仅 parse，失败直接 fallback，未做掩码/修补链
- 影响：
- 结构化输出不稳定，无法保证对外事件与执行目标的确定性。

## P1（V1 应完成）

1. Server 入口过重、职责混合，难于替换为“轻量总管入口”
- 证据：
- `src/server/index.ts:1-120` 同时初始化 blocks/hub/modules/runtime/http/ws
- 影响：
- 无法模块化演进，回归与故障面都偏大。

2. 进程清理策略不安全（命令链式 kill）
- 证据：
- `src/server/index.ts:62` `lsof -ti:${port} | xargs kill -9 ...`
- 影响：
- 在共享开发机上存在误伤风险，不符合精确进程管理原则。

3. 配置来源碎片化，未统一到 `~/.finger/config.json` + `module.json`
- 证据：
- `src/server/index.ts:46`、`src/cli/chat-codex.ts:24`、`src/client/finger-client.ts:98`
- 影响：
- 默认值散落、环境变量优先级不一致，难排查问题。

4. Rust kernel 配置仍绑定特定 env key 与默认 provider 常量
- 证据：
- `rust/kernel-config/src/lib.rs:5-10`、`:36-56`
- 影响：
- 与“用户配置统一写 config.json”不一致，不利于多模型与多环境切换。

## P2（V1 后续增强）

1. capability 文件链路与 module.json 体系未打通
- 证据：
- `src/cli/capability-loader.ts:56-62` 当前偏向 yaml/frontmatter
- 影响：
- 能力声明与系统模块注册不一致，长期会出现重复配置。

## 3. 目标架构映射（旧 -> 新）

- `src/agents/agent.ts` + `src/agents/base/base-agent.ts`
  -> `kernel-agent` 统一 trait + `BaseAgent` 模板
- `src/core/hub-core.ts` + `src/orchestration/message-hub.ts`
  -> 单一 `MessageHub`（保留刚性直达）
- `src/runtime/tool-registry.ts` + `src/agents/shared/tool-registry.ts`
  -> 单一 `ToolRegistry`（角色授权 + 上下文预算 + CLI）
- `src/agents/router/router-agent.ts`
  -> `IngressSupervisorAgent`（强制 JSON Guardrail）
- `rust/kernel-config/src/lib.rs`
  -> `finger-config` 读取 `~/.finger/config.json`，模块细节读取 `module.json`

## 4. 分阶段改造计划

## Phase 0（当前）
- 落盘设计文档与评审结论。
- 用 BD 建立 epic 与基础模块任务树。

## Phase 1（基础设施加固，最高优先级）
- 强化 daemon 生命周期、配置、端口与健康探针。
- 强化 MessageHub（消息信封、阻塞/回调、超时、错误码）。
- 强化 ModuleRegistry（module.json 契约、动态注册校验、健康状态）。
- 收敛重复消息内核实现（HubCore -> MessageHub）。
- 补齐基础链路测试（daemon + messagehub + registry）。

## Phase 2（内核统一）
- 建立统一 `Agent` 接口与 `BaseAgent` 模板。
- 引入 `SuperAgent` 容器与嵌套防自锁护栏（depth/cycle/lease/timeout）。

## Phase 3（路由闭环）
- 默认入口切换到 `IngressSupervisorAgent`。
- 实现 `/hub` 直达语法并保留 MessageHub 指定路由。
- 接入 JSON Guardrail（校验/掩码/修补/重试）。

## Phase 4（能力模块）
- Tool 模块化：`module.json` 注册、角色授权、上下文预算。
- CLI 工具链：`tool list/show/run/register/grant`。

## Phase 5（配置统一）
- 用户配置统一 `~/.finger/config.json`。
- 系统配置统一 `module.json`。
- Rust/TS 双端统一配置解析与优先级策略。

## Phase 6（收敛与退役）
- 退役重复实现（HubCore、重复 ToolRegistry、旧入口代理）。
- 保留兼容层一个小版本，随后删除。

## 5. 验证矩阵（最小）
- E2E-1：普通文本 -> Supervisor 路由 -> MessageHub -> 返回结果
- E2E-2：`/hub` 直达 -> 指定 target -> 阻塞回包
- E2E-3：角色越权工具调用 -> 被拒绝 + EventBus 记录
- E2E-4：非法 JSON -> 修补成功/失败重试 -> 可观测失败事件
- E2E-5：嵌套调用环 A->B->A -> 被 cycle guard 阻断

## 6. 风险与回退
- 风险：双栈并存期可能出现行为漂移。
- 缓解：统一消息信封、双写事件、灰度开关（入口级）。
- 回退：入口路由开关回退到旧链路，保留 MessageHub 直达通道。
