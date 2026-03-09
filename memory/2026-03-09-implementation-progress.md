# 2026-03-09 Agent 会话与配置实现进度

**时间戳**: 2026-03-09T10:11:24.012Z (UTC)

## 已完成

### 1. UI 层：隐藏 finger-general
- **文件**: `ui/src/hooks/useAgentRuntimePanel.ts`
- **实现**: 过滤掉 `finger-general`，不在配置面板显示
- **状态**: ✅ 已完成

### 2. UI 层：添加 "+" 按钮基础
- **文件**: `ui/src/components/BottomPanel/BottomPanel.tsx`
- **实现**: 在 "Static Agent" 标题旁添加 "+" 按钮（UI占位）
- **状态**: ✅ 已完成

## 待实现（按优先级）

### 1. 实现 "+" 按钮功能
**优先级**: P0
**描述**: 使用 `finger-general` 作为模板创建新 agent
**涉及文件**:
- `ui/src/components/BottomPanel/BottomPanel.tsx` - 添加点击处理
- `src/server/routes/agent-configs.ts` - 新增创建 agent API
- `src/runtime/agent-json-config.ts` - 复制 finger-general 配置

**实现步骤**:
1. BottomPanel 添加点击处理，弹出创建对话框
2. 预填充 finger-general 的配置（id, name, role, prompts 等）
3. 允许用户修改 id 和 name
4. 调用后端 API 保存新 agent 配置
5. 刷新配置列表

### 2. 实现空会话默认启动编排器
**优先级**: P1
**描述**: 空会话时自动启动 finger-orchestrator 实例
**涉及文件**:
- `src/runtime/session-manager.ts` - 会话创建时启动编排器
- `src/runtime/runtime-facade.ts` - 协调启动逻辑

**实现步骤**:
1. 在 SessionManager.createSession 中添加启动编排器逻辑
2. 检查项目配置，如果有已记住的 agents，一并启动
3. 发送 session_created 事件，包含已启动的 agents

### 3. 实现项目级记住已打开的 agents
**优先级**: P1
**描述**: 每个项目记住用户已启用的 agents，下次打开自动恢复
**涉及文件**:
- `src/runtime/project-state.ts` (新建) - 项目状态管理
- `src/runtime/session-manager.ts` - 读取项目状态
- `src/server/routes/agent-configs.ts` - 更新项目状态 API

**实现步骤**:
1. 新建 `src/runtime/project-state.ts`，管理 `~/.finger/runtime/state/{project-hash}.json`
2. 存储格式: `{ projectPath, enabledAgents: string[], lastOpenedAt }`
3. 当用户启用/禁用 agent 时，更新项目状态
4. 创建会话时，读取项目状态，自动启动已启用的 agents

## 技术债务

### 需要处理的问题
1. `finger-general` 在多处代码中被引用，需要小心处理
2. UI 和 后端的状态同步需要确保一致性
3. 项目状态的并发访问需要考虑

## 下一步行动

由用户决定从哪个步骤开始实现：
1. 实现 "+" 按钮功能（P0）
2. 实现空会话默认启动编排器（P1）
3. 实现项目级记住已打开的 agents（P1）

Tags: agent, session, configuration, finger-general, project-state, implementation-plan
