# Phase 3 Plan: AI Provider and Agent Integration

## 3.1 CLI Completeness Audit (finger-12) [P1]
- **Goal**: 每个模块有测试后检查 CLI 是否完备
- **Deliverables**:
  - 检查 10 个 Block 的 CLI 定义完整性
  - 验证所有 CLI 参数能正确控制 Block 功能
  - 确认 CLI 能获取 Block 状态
  - 补充缺失的 CLI 命令和参数
  - 编写 CLI 自动化测试用例
- **Acceptance Criteria**:
  - [ ] 每个 Block 有完整的 CLI 命令列表
  - [ ] CLI 测试覆盖率 > 80%
  - [ ] 文档更新：CLI 使用指南

## 3.2 AI Provider Configuration (finger-13) [P0]
- **Goal**: 基础 AI 配置，内部测试用
- **Internal AI Server**:
  - Host: 127.0.0.1:5520
  - Endpoint: /models (GET model list)
  - Endpoint: v1/chat/completions (POST chat)
  - Default model: iflow.kimi-k2.5
- **Deliverables**:
  - UI: 标准 AI Provider 配置界面
  - Backend: AI Block 配置存储和读取
  - CLI: 支持配置 AI Provider
  - API: /api/blocks/ai-1/exec 配置更新
- **Acceptance Criteria**:
  - [ ] UI 可配置 baseUrl, apiKey, defaultModel
  - [ ] UI 可 Fetch Models 并选择
  - [ ] UI 可 Test Connection
  - [ ] Backend 存储配置到 ~/.finger/config/ai.json
  - [ ] CLI: finger ai config --provider <name>

## 3.3 Agent Role Configuration (finger-14) [P0]
- **Goal**: 逐角色配置和测试
- **Roles**:
  1. Orchestrator: 任务拆解、项目管理
  2. Executor: 代码执行、文件操作
  3. Reviewer: 代码审查、质量检查
  4. Tester: 测试编写、测试执行
  5. Architect: 架构设计、技术选型
- **Deliverables**:
  - 每个角色的 Prompt 模板
  - 每个角色的 Capability 定义
  - 每个角色的 CLI 命令
  - UI: 角色配置页面
- **Acceptance Criteria**:
  - [ ] Orchestrator 能正确拆解任务到 BD
  - [ ] Executor 能执行代码生成任务
  - [ ] Reviewer 能进行代码审查
  - [ ] Tester 能生成和执行测试
  - [ ] Architect 能输出架构设计

## 3.4 Basic Orchestration Loop (finger-15) [P0]
- **Goal**: 1 个编排者 + 1 个执行者的编排循环
- **Workflow**:
  1. User Input -> Orchestrator
  2. Orchestrator 拆解任务 -> BD 创建子任务
  3. Orchestrator 分配非主设任务给 Executor
  4. Executor 执行 -> 更新 BD 任务状态
  5. Orchestrator 检查主设依赖
  6. Orchestrator 整合结果 -> User Output
- **Deliverables**:
  - WorkflowEngine 完整实现
  - Scheduler 主设/非主设逻辑
  - BD 任务状态流转集成
  - UI: 编排可视化（ReactFlow 节点状态）
- **Acceptance Criteria**:
  - [ ] 用户输入能触发编排流程
  - [ ] 非主设任务先执行
  - [ ] 主设任务等待依赖完成后执行
  - [ ] BD 任务状态实时更新到 UI
  - [ ] 编排结果返回到对话面板

## Execution Order
```
finger-12 (CLI Audit)
    ↓
finger-13 (AI Config) → finger-6 (UI AI Provider Config)
    ↓
finger-14 (Agent Roles)
    ↓
finger-15 (Orchestration Loop)
```
