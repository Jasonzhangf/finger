# AGENTS.md - Finger 项目全局规则与架构

## 1. 技术栈与约定

### 1.1 语言与模块系统
- **TypeScript 强制**：所有代码必须使用 TypeScript 编写，禁用 `any` 类型（特殊情况需注释说明）。
- **ES Modules (ESM)**：必须使用 `import/export`，禁用 `require`。`package.json` 中 `"type": "module"` 已设置。
- **文件命名**：使用 kebab-case（如 `message-hub.ts`），类/接口使用 PascalCase。
- **文件大小限制**：单个文件不得超过 500 行（逻辑相关可拆分）。

### 1.2 代码风格
- **函数全局唯一**：同一功能函数全局只实现一次，通过骨架+配置复用。
- **分层清晰**：严禁将不同层（如 role/agent/provider）混放在同一文件。
- **注释**：只在复杂逻辑处添加必要注释，禁止冗余注释（如 `// 设置变量`）。

### 1.3 测试与质量
- **单元测试强制**：每个模块必须有对应测试（`tests/unit/`）。
- **CI 门禁**：未通过 lint 和测试的代码不得合入 main。
- **构建验证**：修改后必须运行 `npm run check`（lint + test + build）。

### 1.4 配置文件规范
- **用户配置统一**：所有用户可编辑配置统一写入 `~/.finger/config.json`。
- **系统内配置统一**：所有模块内部静态/运行配置统一走各模块 `module.json`，禁止分散在临时文件或硬编码常量中。

### 1.5 文档归档规范
- **模块文档位置**：模块实现相关文档必须放在对应模块目录下（与模块代码同级或子目录）。
- **设计文档位置**：跨模块/系统级设计文档统一放在 `docs/` 目录下。

---

## 2. 项目架构

### 2.1 三层结构
```
└── src/
    ├── blocks/          # 基础功能块（无编排逻辑，每个块独立 CLI/API）
    ├── orchestration/   # 编排层（消息中枢、守护进程、模块注册）
    └── agents/          # Agent 层（角色、SDK 封装、工具）
```

#### 2.1.1 Blocks（基础功能）
- 每个 Block 实现单一功能（如 `StateBlock`、`TaskBlock`）。
- 必须实现 `BaseBlock` 接口，暴露 CLI 和状态查询 API。
- 所有 Block 注册到 `core/registry.ts`，前端可自动发现能力。

#### 2.1.2 Orchestration（编排）
- **MessageHub**：全局消息路由器，支持动态注册输入/输出，阻塞/非阻塞模式。
- **ModuleRegistry**：管理 `input`/`output`/`agent` 模块，支持从文件动态加载。
- **Daemon**：后台守护进程，管理生命周期，提供 REST API 和 IPC 通信。

#### 2.1.3 Agents（AI 代理）
- **Role**：定义角色行为（`orchestrator`、`executor`、`reviewer`）。
- **Provider**：封装 SDK（如 `iflow`、`codex`、`claude`）。
- **Runtime**：执行循环、工具注册。
- **Shared**：工具集、提示词、能力声明。

---

## 3. 消息中枢与模块系统

### 3.1 模块类型
| 类型 | 作用 | 示例 |
|------|------|------|
| `input` | 接收消息的入口 | CLI 输入、HTTP 回调 |
| `output` | 处理消息并返回结果 | Agent 执行器、Mock 服务 |
| `agent` | 可执行指令的代理 | Orchestrator、Executor |

### 3.2 模块定义（TypeScript）
```typescript
// 一个模块可同时拥有多个 input/output
import { InputModule, OutputModule, AgentModule } from '../orchestration/module-registry.js';

// Input 模块
export const myInput: InputModule = {
  id: 'my-input',
  type: 'input',
  name: 'my-input',
  version: '1.0.0',
  handle: async (msg) => {
    // 处理输入消息
    return { processed: true };
  },
  defaultRoutes: ['my-output']  // 可选默认路由
};

// Output 模块
export const myOutput: OutputModule = {
  id: 'my-output',
  type: 'output',
  name: 'my-output',
  version: '1.0.0',
  handle: async (msg, callback) => {
    const result = { echo: msg };
    if (callback) callback(result);
    return result;
  }
};

// Agent 模块（兼具 input/output 能力）
export const myAgent: AgentModule = {
  id: 'my-agent',
  type: 'agent',
  name: 'my-agent',
  version: '1.0.0',
  capabilities: ['execute', 'query'],
  execute: async (command, params) => {
    if (command === 'execute') return { done: true };
    throw new Error(`Unknown command: ${command}`);
  },
  // 可选：自定义 input/output
  initialize: async (hub) => {
    hub.registerInput('my-agent-input', async (msg) => {
      return myAgent.execute(msg.command, msg.params);
    });
    hub.registerOutput('my-agent-output', async (msg, cb) => {
      const result = await myAgent.execute('execute', msg);
      if (cb) cb(result);
      return result;
    });
  }
};
```

### 3.3 消息路由与同名回复
- **发送消息**：CLI 或模块通过 `hub.sendToModule(moduleId, message, callback?)` 直接发送。
- **同名回复**：若消息包含 `sender` 字段，中枢会尝试查找与 `sender` 同名的 input 模块，并将结果回调。
- **阻塞模式**：`-b` 标志使 CLI 等待结果（通过回调 ID 实现）。

### 3.4 动态注册
```bash
# 注册模块文件（支持数组批量注册）
finger daemon register-module -f ./dist/my-agent.js

# 列出所有模块
finger daemon list
```

---

## 4. 守护进程（Daemon）

### 4.1 生命周期管理
```bash
finger daemon start    # 启动后台进程（PID 写入 ~/.finger/daemon.pid）
finger daemon stop     # 停止进程
finger daemon restart  # 重启
finger daemon status   # 查看状态及已注册模块
```

### 4.2 服务端口
- **默认端口**：`5521`（可通过环境变量 `PORT` 覆盖）
- **REST API**：
  - `GET  /api/v1/modules` - 列出所有模块
  - `GET  /api/v1/routes`  - 列出路由规则
  - `POST /api/v1/message` - 发送消息（JSON 格式）
  - `POST /api/v1/module/register` - 动态注册模块（需提供模块文件路径）

### 4.3 日志
日志输出到 `~/.finger/daemon.log`，包含消息路由记录和错误堆栈。

---

## 5. 刚性约束

### 5.1 代码质量
- **禁止巨型文件**：超过 500 行必须拆分。
- **禁止重复函数**：同一功能全局唯一实现，通过配置复用。
- **禁止 any 类型**：必须定义接口或使用 `unknown` 加类型守卫。

### 5.2 测试与 CI
- **单元测试**：所有模块必须有对应测试（`tests/unit/`）。
- **集成测试**：关键流程（如 daemon 启动/消息路由）需有测试（`tests/integration/`）。
- **门禁**：提交前必须通过 `npm run check`。

### 5.3 构建验证
- 修改后运行 `npm run build` 确保无 TypeScript 错误。
- 运行 `npm test` 确保测试通过。
- **错误路径重放验证（强制）**：修复 bug 后必须重放原始报错命令/请求路径并记录结果，禁止以“推测已修复”作为结论。

---

## 6. BD 任务管理

### 6.1 任务与进度
- 所有开发任务必须创建 BD issue：
  ```bash
  bd --no-db create "任务标题" -p 0 --parent <epic>
  ```
- 任务状态更新：
  ```bash
  bd --no-db update <id> --status in_progress|blocked|closed
  ```
- 依赖管理：
  ```bash
  bd --no-db dep add <blocked> <blocker>
  ```

### 6.2 同步流程
- 使用 `git-portable` 模式：
  ```bash
  bd sync mode set git-portable
  bd hooks install
  ```
- 每次提交前自动同步 `.beads/issues.jsonl`。

---

## 7. 后续开发路线

### 7.1 已完成
- ✅ 消息中枢与模块注册表（TypeScript + ESM）
- ✅ 守护进程管理器与 CLI 命令
- ✅ 测试 Agent 示例（`mock-echo`）

### 7.2 待完成
- [ ] 实际 Agent 角色（Orchestrator/Executor）
- [ ] iFlow SDK 集成与能力测试
- [ ] 任务分解与分配逻辑
- [ ] 状态持久化与恢复机制

---

> 本文件作为项目核心约束，后续修改需通过 PR 更新。

## 8. EventBus 与事件系统

### 8.1 事件分组
所有事件按功能分组，UI 可按组订阅：
- `SESSION`: 会话生命周期
- `TASK`: 任务执行状态
- `TOOL`: 工具调用
- `DIALOG`: 对话流
- `PROGRESS`: 整体进度
- `PHASE`: 编排阶段
- `RESOURCE`: 资源池状态
- `HUMAN_IN_LOOP`: 需用户决策（核心交互闭环）
- `SYSTEM`: 系统级错误

### 8.2 订阅 API
```typescript
globalEventBus.subscribeByGroup('HUMAN_IN_LOOP', handler);
// WebSocket: { "type": "subscribe", "groups": ["HUMAN_IN_LOOP"] }
```

### 8.3 REST API
- `GET /api/v1/events/types` - 返回所有事件类型
- `GET /api/v1/events/groups` - 返回所有分组
- `GET /api/v1/events/history?type=xxx&group=xxx` - 按类型或分组查询历史

详细设计见 [docs/EVENT_BUS_DESIGN.md](./docs/EVENT_BUS_DESIGN.md)

## 8. 提交约束
- 禁止提交构建物（`dist/`、`node_modules/`、`*.tsbuildinfo`）
- 禁止提交临时文件（`*.tmp`、`*.temp`、`.tmp_*`）
- 禁止提交敏感信息（`.env`、`secrets.json`、API Key）
- 禁止提交测试覆盖率报告（`coverage/` 目录）

## 9. 测试覆盖要求
### 9.1 覆盖率目标
- **总体目标**：核心功能（`src/`）测试覆盖率 ≥ 80%
- **UI 测试**：关键组件和 hooks 必须有单元测试
- **WebSocket 集成**：消息流必须有端到端测试

### 9.2 必测模块
| 模块 | 要求 | 优先级 |
|------|------|--------|
| Backend Core | ≥ 80% | P0 |
| Backend Agents | ≥ 80% | P0 |
| Backend Runtime | ≥ 75% | P0 |
| Frontend Hooks | ≥ 70% | P1 |
| Frontend Components | ≥ 60% | P1 |
| WebSocket Integration | E2E 测试 | P1 |

### 9.3 CI 门禁
- 提交前必须通过 `npm run check`（lint + test + build）
- 测试覆盖率不达标时禁止合并到 main
- UI 修改需同时更新对应测试

## 10. 开发优先级
- **测试先行**：基础功能 CI 覆盖率达到 80%+ 后再开发编排特性
- **核心优先**：Backend Core > Backend Agents > Frontend
- **集成最后**：端到端测试在单元测试稳定后补充

## 11. 并发调度策略

### 11.1 核心原则

任务并发调度遵循以下刚性规则：

| 规则 | 描述 | 检查时机 |
|------|------|----------|
| **可并行** | 任务在 DAG 上无未完成前置依赖 | 任务派发前 |
| **资源齐全** | 任务声明的 `requiredCapabilities` 全部可从资源池分配 | 任务派发前 |
| **值得并发** | 预计执行时长 > 调度开销阈值（默认 2s） | 收益评估 |
| **不过载** | 不超过每类资源并发上限和系统总并发预算 | 资源分配 |
| **可回收** | 线程结束后释放资源；超时/失败进入重试或人工决策 | 任务完成 |
| **阻塞处理** | 资源被占用则进入等待队列，不抢占关键任务 | 队列管理 |
| **缺资源上报** | 不可恢复缺资源立即上报用户，不进入盲等 | 错误处理 |

### 11.2 策略配置

系统提供三种预设策略：

- `DEFAULT_CONCURRENCY_POLICY`: 平衡模式（默认）
- `HIGH_PERFORMANCE_POLICY`: 高性能模式（资源充足环境）
- `CONSERVATIVE_POLICY`: 保守模式（资源受限环境）

配置项详见 `src/orchestration/concurrency-policy.ts`。

### 11.3 调度器 API

```typescript
import { concurrencyScheduler } from './orchestration/concurrency-scheduler.js';

// 评估任务是否应该并发执行
const decision = concurrencyScheduler.evaluateScheduling(task, requirements);

// 将任务加入等待队列
concurrencyScheduler.enqueue(task, requirements, priority);

// 从队列取出可执行任务
const readyTask = concurrencyScheduler.dequeue();

// 标记任务状态
concurrencyScheduler.startTask(taskId, resources);
concurrencyScheduler.completeTask(taskId, success);

// 获取统计信息
const stats = concurrencyScheduler.getStats();
```

### 11.4 执行时间预估

支持三种预估模式：

- `static`: 基于静态配置的时长映射
- `adaptive`: 加权平均历史数据（默认）
- `llm_estimate`: LLM 预估（需要调用方提供）

### 11.5 队列策略

- `fifo`: 先进先出
- `priority`: 基于优先级排序
- `aging`: 优先级老化机制（防止饿死）

### 11.6 动态降级

当资源使用率超过阈值时自动启用降级：

- 降低最大并发数
- 可选暂停新任务派发
- 记录降级事件


## 12. 进程管理约束

### 12.1 禁止普杀命令
- **禁止使用** `pkill node`、`killall node`、`pkill -9 node` 等普杀命令
- **禁止使用** `pkill` 无参数或仅带通配符的命令
- **原因**：会误杀其他无关进程（如 IDE、其他开发工具、后台服务等）

### 12.2 安全的进程管理方式
```bash
# 正确：按端口精确查找并终止
lsof -ti :8080 | xargs kill -9 2>/dev/null

# 正确：按 PID 文件终止
kill $(cat /tmp/server.pid) 2>/dev/null

# 正确：按进程名精确匹配（带完整路径）
pkill -f "node.*dist/server/index.js"
```

### 12.3 测试环境清理
- E2E 测试应在独立端口运行，避免与开发环境冲突
- 测试前检查端口是否被占用，选择性清理而非普杀
- 测试后清理自己创建的进程，不影响其他服务

## 13. CLI 设计规范

### 13.1 架构原则

CLI 是系统的统一入口，遵循以下原则：

1. **异步启动**: `finger daemon start` 启动后台常驻进程
2. **标准 API**: 所有调用通过 HTTP/WebSocket API
3. **事件驱动**: 实时状态通过 WebSocket 推送
4. **用户交互**: 需要用户决策时阻塞等待
5. **状态机驱动**: 工作流状态由 FSM 管理

### 13.2 命令接口

```bash
# Daemon 管理
finger daemon start      # 启动后台进程
finger daemon stop       # 停止进程
finger daemon status     # 查看状态
finger daemon logs       # 查看日志

# Agent 命令
finger understand "输入"           # 语义理解
finger route --intent '{"..."}'    # 路由决策
finger plan "任务"                 # 任务规划
finger execute --task "xxx"        # 任务执行
finger review --proposal '{"..."}' # 质量审查
finger orchestrate "任务" --watch  # 编排协调

# 工作流控制
finger pause <workflowId>    # 暂停
finger resume <workflowId>   # 恢复
finger cancel <workflowId>   # 取消
finger status <workflowId>   # 查看状态
finger list                  # 列出所有工作流

# 交互模式
finger repl                  # 进入 REPL 模式
```

### 13.3 输入输出

**输入源**:
- 命令行参数: `finger plan "任务"`
- 管道: `echo "任务" | finger plan`
- 文件: `finger plan --file task.txt`
- 交互式: `finger repl`

**输出格式**:
- 人类可读 (默认)
- JSON (`--json`)
- SSE 流 (`--stream`)

### 13.4 用户决策

当 Agent 需要用户输入时：

```
❓ 检测到网络访问，是否继续？(Y/n)
> Y

❓ 找到 5 篇论文，选择哪些？
  1. paper1.pdf
  2. paper2.pdf
  3. paper3.pdf
> 1,3
```

### 13.5 错误码

| 退出码 | 说明 |
|--------|------|
| 0 | 成功 |
| 1 | 通用错误 |
| 2 | 参数错误 |
| 3 | 连接错误（Daemon 未启动） |
| 4 | 资源缺失 |
| 5 | 任务失败 |
| 6 | 用户取消 |
| 7 | 超时 |

### 13.6 详细设计

详见：
- [docs/CLI_DESIGN.md](./docs/CLI_DESIGN.md) - CLI 设计文档
- [docs/CLI_IMPLEMENTATION_PLAN.md](./docs/CLI_IMPLEMENTATION_PLAN.md) - 实现计划
- [docs/CLI_CALL_FLOW.md](./docs/CLI_CALL_FLOW.md) - 调用流程
