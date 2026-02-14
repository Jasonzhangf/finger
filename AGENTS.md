# Finger - Agent Orchestrator 项目通用约束

## 项目概述

- **项目名称**: finger
- **定位**: AI Agent 编排系统
- **架构**: 三层架构 (Block → App → UI)
- **项目管理**: `bd` (Beads)
- **技术栈**: TypeScript/Node.js + React + SQLite

## 核心原则

1. **bd 是单一事实来源**: 所有任务、沟通、交付物都在 bd 中管理
2. **Git 前置检查**: 未 track 的文件无法通过 CI
3. **Block 是唯一功能实现层**: App 只编排，不实现具体功能
4. **CLI/API 双通道**: 所有能力都通过 CLI 和 API 暴露
5. **测试覆盖**: 单元 + API + E2E 三层测试必须通过

## 目录结构约束

```
finger/
├── AGENTS.md                 # 本文件
├── package.json              # 依赖管理
├── tsconfig.json             # TypeScript 配置
├── .gitignore                # Git 忽略
├── .github/workflows/ci.yml  # CI 工作流
├── scripts/                  # 工具脚本
├── docs/                     # 架构文档
│   ├── ARCHITECTURE.md       # 整体架构
│   ├── AGENT_ROLES.md        # Agent 角色设计
│   ├── BD_WORKFLOW.md        # bd 协作流程
│   ├── TASK_LIFECYCLE.md     # 任务状态机
│   ├── BLOCK_SPEC.md         # Block 开发规范
│   └── API_SPEC.md           # API 接口规范
├── src/
│   ├── core/                 # 核心接口
│   ├── blocks/               # 10个 Block 实现
│   ├── app/                  # App 编排层
│   ├── server/               # HTTP + WebSocket
│   └── cli/                  # CLI 入口
├── ui/                       # React 前端
├── tests/                    # 测试
└── .beads/
    └── issues.jsonl          # bd 任务管理（版本化）
```

## Block 开发规范

### 10个核心 Block

| Block | 文件路径 | 职责 |
|-------|----------|------|
| AgentBlock | `src/blocks/agent-block/` | Agent 实例管理 |
| TaskBlock | `src/blocks/task-block/` | 任务状态管理 |
| ProjectBlock | `src/blocks/project-block/` | 项目元数据 + bd 同步 |
| StateBlock | `src/blocks/state-block/` | 全局状态服务 |
| OrchestratorBlock | `src/blocks/orchestrator-block/` | 编排控制 |
| EventBusBlock | `src/blocks/eventbus-block/` | 事件总线 |
| StorageBlock | `src/blocks/storage-block/` | 存储抽象 |
| SessionBlock | `src/blocks/session-block/` | 会话管理 |
| AIBlock | `src/blocks/ai-block/` | AI 请求封装 |
| WebSocketBlock | `src/blocks/websocket-block/` | WS 服务 |

### Block 接口约束

每个 Block 必须实现:

```typescript
interface IBlock {
  readonly id: string;
  readonly type: string;
  readonly capabilities: BlockCapabilities;
  
  getState(): BlockState;
  execute(command: string, args: Record<string, unknown>): Promise<unknown>;
  
  initialize(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}
```

### Block 必须提供的 CLI

每个 Block 必须通过 `finger block exec <block> <cmd>` 暴露能力。

## 开发工作流

### 1. 任务驱动开发

```bash
# 1. 查看可执行任务
bd --no-db ready

# 2. 领取任务
bd --no-db update <id> --status in_progress --assignee <name>

# 3. 开发... (Git 提交必须包含 .beads/issues.jsonl)

# 4. 完成任务
bd --no-db close <id> --reason "已完成"
```

### 2. Git 提交规范

```
[<issue-id>] <type>: <description>

- 变更详情
- 交付物清单
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `block`

### 3. CI 检查项

- [ ] 所有文件在 git track
- [ ] `npm run build` 通过
- [ ] `npm run test` 通过
- [ ] `.beads/issues.jsonl` 已更新

## 命名规范

### 文件命名

- Block 目录: `kebab-case` (e.g., `agent-block/`)
- 类名: `PascalCase` (e.g., `AgentBlock`)
- 接口: `IPascalCase` (e.g., `IBlock`)
- 函数: `camelCase` (e.g., `executeCommand`)
- 常量: `UPPER_SNAKE_CASE`

### CLI 命令

```
finger <noun> <verb> [args...]

# 示例
finger block list
finger agent spawn --role executor
finger task create "Title" --priority 1
```

## 错误处理

### 错误码规范

| 错误码 | 含义 | 处理策略 |
|--------|------|----------|
| `BLOCK_NOT_FOUND` | Block 不存在 | 检查注册状态 |
| `AGENT_TIMEOUT` | Agent 超时 | 重试或重新分配 |
| `TASK_BLOCKED` | 任务被阻塞 | 等待依赖完成 |
| `VALIDATION_ERROR` | 验证失败 | 返回错误详情 |
| `BD_SYNC_ERROR` | bd 同步失败 | 重试，记录日志 |

## 性能约束

- 任务心跳间隔: 60s
- Agent 超时: 5min
- 任务执行超时: 30min
- 审查超时: 24h
- 检查点保存间隔: 5min

## 安全约束

- 所有文件操作必须通过 StorageBlock
- Agent 执行使用沙箱环境（推荐）
- API 认证通过 SessionBlock
- 敏感配置通过环境变量注入

## 参考文档

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) - 架构设计
- [AGENT_ROLES.md](./docs/AGENT_ROLES.md) - Agent 角色
- [BD_WORKFLOW.md](./docs/BD_WORKFLOW.md) - bd 协作流程
- [TASK_LIFECYCLE.md](./docs/TASK_LIFECYCLE.md) - 任务状态机
