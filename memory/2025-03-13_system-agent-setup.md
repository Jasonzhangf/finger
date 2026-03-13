# System Agent 实施记录

日期: 2025-03-13

Tags: system-agent, project-tool, memory, validation

## 完成的工作

### 1. 类型系统修复
- **问题**: project_tool 使用非标准 `execute` 字段，与 ToolRegistry 不兼容
- **解决**: 改为 `policy + handler` 标准结构
- **文件**: 
  - `src/tools/internal/project-tool/project-tool.ts`
  - `src/server/modules/agent-runtime/types.ts`

### 2. 注册机制重构
- **问题**: project_tool 被注册到 CLI 内部注册表，但需要运行时依赖
- **解决**: 
  - 从 `createDefaultInternalToolRegistry()` 移除 project_tool
  - 只在运行时通过 `registerProjectToolInRuntime()` 注册
  - 导出独立的 `registerProjectToolInRuntime()` 函数
- **文件**: 
  - `src/tools/internal/index.ts`
  - `src/runtime/default-tools.ts`

### 3. 依赖注入
- **变更**: 在 `AgentRuntimeDeps` 中添加可选的 `dispatchTaskToAgent`
- **理由**: project_tool 需要分派编排者 agent 到新项目

### 4. 静态验证测试
- ✅ `system-agent-static.test.ts`: 5 tests passed
- ✅ `memory-permission.test.ts`: 1 test passed
- 测试覆盖：
  - Prompt/Capability 文件存在性
  - System Agent 工具白名单
  - System Agent cwd / session path
  - Memory 权限控制

## 构建状态
✅ `npm run build:backend` 通过
✅ 类型检查通过
✅ 静态单元测试全部通过

## 待验证

### 运行验证（功能测试）
- [ ] project_tool.create（需要运行时环境）
- [ ] MEMORY 自动追加（需要真实 channel/webui）
- [ ] 跨项目限制验证
- [ ] Agent 派发不记录验证

## 当前限制
- `project_tool` 无法通过 `finger tool run --local` 测试
  - 原因: 只在运行时注册，CLI 内部注册表不包含
  - 设计意图: 需要 AgentRuntimeDeps（sessionManager, dispatchTaskToAgent）

## 下一步
需要在实际运行环境中测试 System Agent:
1. 启动 Daemon
2. 通过 channel/webui 切换到 system agent
3. 测试 `project_tool` 调用
4. 验证 MEMORY 自动记录
