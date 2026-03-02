# SuperAgent Kernel V1 设计（Rust Kernel + TS Orchestration）

> 会话控制平面与能力治理细化设计见：`docs/design/superagent-session-governance-v1.md`

## 1. 目标与边界

### 1.1 目标
- 以现有 Rust kernel 为执行内核，默认通过轻量总管 Agent 处理用户输入。
- 提供统一 Agent 抽象：上层接口一致，内部实现可为基础模型或外部框架。
- 保留 MessageHub 刚性路由能力：用户可显式绕过 AI 路由，直接指定模块。
- 引入基础能力模块（Tool System）：可 CLI 化、可注册、按角色授权、可控上下文占用。
- 路由输出强制 JSON 结构化，经过校验、掩码、修补、重试后才可执行。

### 1.2 非目标（V1 不做）
- 不做复杂长期记忆检索，只保留短窗口上下文与会话摘要。
- 不做全量多智能体并行优化，先支持顺序/有限并发编排。
- 不替换所有历史模块，采用渐进迁移与双栈兼容。

## 2. 总体架构

```text
User Input
  -> Entry Gateway
      -> [special syntax] MessageHub Direct Dispatch
      -> [normal syntax] IngressSupervisorAgent
             -> Capability Snapshot
             -> Router Engine (Model/Framework Adapter)
             -> JSON Guardrail (validate/mask/repair/retry)
             -> Dispatch Adapter (MessageHub)
             -> Result + EventBus + Context Update
```

## 3. 统一 Agent 抽象

### 3.1 统一接口（上层唯一依赖）

```rust
pub trait Agent: Send + Sync {
    fn id(&self) -> &str;
    fn role(&self) -> AgentRole;
    async fn init(&mut self, ctx: AgentInitContext) -> Result<(), AgentError>;
    async fn handle(&mut self, input: AgentInput, ctx: AgentRunContext) -> Result<AgentResult, AgentError>;
    async fn health(&self) -> AgentHealth;
    async fn shutdown(&mut self) -> Result<(), AgentError>;
}
```

### 3.2 同一基类模板（Template Method）
- `BaseAgent` 固化公共流程：
- `load_capability_snapshot -> build_context -> decide -> validate -> act -> emit_event`
- 子类只实现差异 hook：
- `decide()`、`act()`、`on_error()`

### 3.3 SuperAgent 编排
- `SuperAgent` 自身也是 `Agent`，内部维护子 Agent 图（FSM/DAG）。
- 对外仍暴露统一 `Agent` 接口。
- 子 Agent 全部继承 `BaseAgent`，角色差异通过策略与授权配置体现。

## 4. 默认入口与 MessageHub 直达

### 4.1 输入模式
- 默认模式：普通文本进入 `IngressSupervisorAgent`。
- 直达模式：特殊语法直接走 MessageHub，不经过模型路由。

### 4.2 建议直达语法（V1）
- `/hub target=<moduleId> blocking=<true|false> {json payload}`
- 例：`/hub target=chat-codex blocking=true {"text":"hello"}`

### 4.3 优先级
- `用户显式直达 > 系统安全策略 > AI 路由建议`

## 5. 基础能力模块（Tool System）

## 5.1 Tool 抽象
- 每个工具统一元信息：
- `tool_id/name/version/input_schema/output_schema/risk_level/context_cost`
- 执行入口：
- `execute(input, runtime_ctx) -> ToolResult`

## 5.2 注册与配置
- 用户配置：`~/.finger/config/config.json`
- 系统配置：每个工具/模块 `module.json`
- 注册源：
- 静态加载（启动时）
- 动态加载（daemon register-module / tool register）

## 5.3 角色授权
- `ToolGrantProfile` 按角色绑定工具集：
- `supervisor`: 路由/状态/轻量查询
- `executor`: 文件/命令/网络等执行工具
- `reviewer`: 只读审计工具

## 5.4 工具上下文预算
- 默认仅注入工具摘要（name/用途/约束/风险/context_cost）。
- 模型选中工具后再补全该工具完整 schema。
- 预算超限时按策略裁剪（优先保留当前角色高优工具）。

## 5.5 CLI 入口（V1）
- `myfinger tool list`
- `myfinger tool show <toolId>`
- `myfinger tool run <toolId> --args '{...}'`
- `myfinger tool register -f <module.json|module.js>`
- `myfinger tool grant --role <role> --tool <toolId>`

## 6. JSON Guardrail（强制结构化输出）

### 6.1 路由结果契约

```json
{
  "decision": "direct_reply|dispatch_agent|dispatch_module|ask_human|reject",
  "target": "module-or-agent-id",
  "confidence": 0.0,
  "reason": "string",
  "payload": {},
  "requires_human": false
}
```

### 6.2 处理链
1. 提取 JSON 片段
2. Schema 校验
3. 字段白名单掩码
4. 残缺修补（结构补齐）
5. 修补失败则带错误原因重试推理（最多 N 次）
6. 仍失败进入 `ask_human` 或 `reject`

## 7. 上下文与事件模型

### 7.1 上下文分层
- `session_context`: 会话历史摘要
- `routing_context`: 最近路由与执行反馈
- `capability_snapshot`: 本轮可用能力快照

### 7.2 事件（对外可观测）
- `INPUT_RECEIVED`
- `MODE_PARSED`
- `ROUTE_DECIDED`
- `JSON_REPAIRED`
- `DISPATCH_SENT`
- `DISPATCH_RESULT`
- `ROUTE_FAILED`

### 7.3 关联字段
- 全量携带：`request_id/session_id/workflow_id/target/timestamp`

## 8. 适配器分层（可插拔）

### 8.1 RouterEngine
- 输入统一上下文，输出标准路由 JSON。

### 8.2 ModelAdapter
- 对接基础模型（如 responses/chat）。

### 8.3 FrameworkAdapter
- 对接外部 Agent 框架（通过 kernel bridge / sdk bridge）。

### 8.4 DispatchAdapter
- 统一落到 MessageHub 执行，保证刚性路由一致性。

## 9. V1 里程碑

### M0（基础设施先行）
- 强化 daemon / messagehub / module-registry 基础链路。
- 统一消息信封、阻塞与回调语义、模块注册契约与健康检查。
- 确保该层长期稳定，后续 Agent/SuperAgent 在此之上演进。

### M1
- 统一 Agent trait + BaseAgent。
- IngressSupervisorAgent + `/hub` 直达语法。
- ModelAdapter/FrameworkAdapter 最小实现各 1 个。

### M2
- ToolRegistry v1（注册/授权/CLI）。
- Capability snapshot 注入。
- JSON Guardrail 完整链路（校验/掩码/修补/重试）。

### M3
- SuperAgent 编排（2~3 子 Agent）。
- EventBus 对外事件闭环与错误路径重放。

## 10. 验收标准（V1）
- 普通输入可由 IngressSupervisorAgent 正确路由到目标模块。
- `/hub` 语法可直接命中 MessageHub，且可阻塞回包。
- 同一上层调用可切换 model/framework 两种内部实现，无调用方改动。
- 工具按角色授权生效，越权调用被拒绝并有事件记录。
- 非法 JSON 输出可被修补或重试，最终行为可追踪可重放。

## 11. 反自锁与嵌套健壮性（硬约束）

### 11.1 嵌套执行护栏
- 每个请求携带 `execution_chain`（调用链）与 `nesting_depth`。
- 默认最大嵌套深度（例如 4），超过即拒绝并上报 `ROUTE_FAILED`。
- 检测调用环：若当前 `target` 已存在于 `execution_chain`，直接阻断（防止 A->B->A）。

### 11.2 租约与超时
- 每次 Agent/Tool 调用发放租约（lease_id + ttl）。
- 租约超时自动回收上下文锁与资源占用，禁止无限等待。
- 所有阻塞调用必须具备超时上限与明确错误码。

### 11.3 并发与幂等
- 每个 `request_id` 只允许一个活跃执行实例，重复请求走幂等返回。
- SuperAgent 子流程状态转移必须原子化（start/complete/fail）。
- 失败重试只针对幂等步骤；非幂等步骤需显式补偿动作。

### 11.4 降级策略
- 发生循环路由或连续失败时，自动降级到：
- `ask_human`（人工决策）
- 或 `direct_reply`（返回可执行建议，不继续嵌套）
- 降级事件必须写入 EventBus，支持错误路径重放。
