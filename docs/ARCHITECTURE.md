# Finger - Agent Orchestrator 架构设计

## 项目概览

- **名称**: finger (CLI 入口)
- **定位**: AI Agent 编排系统，后台持续运行，Web 访问
- **管理工具**: `bd` (Beads) - `.beads/issues.jsonl` 版本化
- **技术栈**: TypeScript/Node.js + React + SQLite

## 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│                        UI Layer                             │
│   React + Vite | Widgets 自动拉取 Block 能力               │
│   └────────────────────┬────────────────────────────────────┘
                         │ HTTP/WebSocket
┌────────────────────────▼────────────────────────────────────┐
│                       App Layer                             │
│   Orchestrator | TaskDecomposer | Scheduler                 │
│   (业务逻辑编排，无 UI)                                      │
└────────────────────┬───────────────────────────────────────┘
                     │
┌────────────────────▼───────────────────────────────────────┐
│                      Block Layer                            │
│   10个 Block | BlockRegistry 统一管理                       │
│   (基础功能，唯一实现)                                       │
└────────────────────┬───────────────────────────────────────┘
                     │
               ┌─────▼─────┐
               │  Storage  │
               │  (SQLite) │
               └───────────┘
```

## Block 清单 (10个)

| Block | 职责 | 核心能力 |
|-------|------|----------|
| **AgentBlock** | Agent 实例管理 | spawn/assign/kill agents |
| **TaskBlock** | 任务状态管理 | CRUD tasks, 依赖追踪 |
| **ProjectBlock** | 项目元数据 | 项目创建, bd 同步 |
| **StateBlock** | 全局状态 | 状态读写, 订阅通知 |
| **OrchestratorBlock** | 编排控制 | 启动/暂停编排, 进度监控 |
| **EventBusBlock** | 事件总线 | 发布/订阅, 跨Block通信 |
| **StorageBlock** | 存储抽象 | 统一存储接口 (SQLite/文件) |
| **SessionBlock** | 会话管理 | 用户会话, 上下文保持 |
| **AIBlock** | AI 请求 | SDK 封装, 提示词渲染 |
| **WebSocketBlock** | WS 服务 | 实时推送, 连接管理 |

## Agent 角色体系

详见 [docs/AGENT_ROLES.md](./AGENT_ROLES.md)

**核心角色**:
- **Orchestrator**: 编排者，任务分解与分配
- **Executor**: 执行者，具体任务执行
- **Reviewer**: 检查者，质量把关
- **Specialist**: 专家 (Architect/Tester/DocWriter/SecurityAuditor)

## 目录结构

```
finger/
├── AGENTS.md                 # 项目通用约束
├── package.json
├── tsconfig.json
├── .gitignore
├── .github/workflows/ci.yml  # CI: git check + build + test
├── scripts/git-check.sh      # Git track 检查
├── docs/
│   ├── ARCHITECTURE.md       # 本文档
│   ├── AGENT_ROLES.md        # Agent 角色设计
│   ├── BLOCK_SPEC.md         # Block 开发规范
│   └── API_SPEC.md           # API 接口规范
├── src/
│   ├── core/                 # 核心接口
│   │   ├── block.ts          # IBlock 接口
│   │   ├── registry.ts       # BlockRegistry
│   │   └── types.ts          # 通用类型
│   ├── blocks/               # 10个 Block 实现
│   │   ├── base-block.ts
│   │   ├── agent-block/
│   │   ├── task-block/
│   │   ├── project-block/
│   │   ├── state-block/
│   │   ├── orchestrator-block/
│   │   ├── eventbus-block/
│   │   ├── storage-block/
│   │   ├── session-block/
│   │   ├── ai-block/
│   │   └── websocket-block/
│   ├── app/                  # App 编排层
│   │   ├── orchestrator.ts
│   │   ├── task-decomposer.ts
│   │   ├── scheduler.ts
│   │   └── types.ts
│   ├── server/               # HTTP + WebSocket
│   │   ├── index.ts
│   │   ├── routes.ts
│   │   └── middleware.ts
│   └── cli/                  # CLI 入口
│       └── index.ts          # finger <block> <cmd>
├── ui/                       # React 前端
│   ├── package.json
│   ├── vite.config.ts
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api/client.ts
│   │   └── widgets/
│   └── index.html
├── tests/
│   ├── unit/
│   ├── api/
│   └── e2e/
└── .beads/
    └── issues.jsonl          # bd 任务管理
```

## CLI 命令设计

```bash
# Block 管理
finger block list
finger block status <id>
finger block exec <block> <cmd> [args...]

# Agent 管理
finger agent spawn --role executor --sdk codex
finger agent list
finger agent assign <id> --task <taskId>

# Task 管理
finger task create "Title" --desc "..." --priority 1
finger task list [--status pending]
finger task show <id>

# Project 管理
finger project init <name>
finger project sync            # 同步到 bd

# 编排
finger orchestrate <projectId>
finger schedule show

# 服务
finger server start [--port 8080]
finger server status
```

## API 端点

```
GET  /api/blocks              # 所有 Block 能力
GET  /api/blocks/:id/state    # Block 状态
POST /api/blocks/:id/exec     # 执行 Block 命令

GET|POST|PATCH|DELETE /api/tasks
GET|POST /api/projects
GET|POST /api/agents

WS   /ws                      # 实时状态推送
```

## 关键约束

1. **Git 前置**: 编译前检查所有文件在 git track
2. **bd 集成**: `.beads/issues.jsonl` 必须版本化
3. **Block 统一接口**: `getState()`, `execute()`, 生命周期方法
4. **CLI/API 双通道**: 每个 Block 能力都通过 CLI 和 API 暴露
5. **测试覆盖**: 单元 + API + E2E 三层测试
6. **UI 自动适配**: 前端启动时拉取 Block 能力，动态生成 Widget
