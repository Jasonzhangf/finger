# System Agent 基础验证测试设计

## 目标
验证 System Agent 在以下方面符合设计：
1. 静态配置正确（提示词、工具、cwd、权限）
2. 功能行为符合约束（跨项目分派、MEMORY 自动记录）

---

## 一、静态验证（单元测试）

### 1. Prompt/Capability 文件存在性
- 路径:
  - `src/agents/finger-system-agent/system-prompt.md`
  - `src/agents/finger-system-agent/system-dev-prompt.md`
  - `src/agents/finger-system-agent/capability.md`

断言:
- 文件存在
- 内容包含关键规则:
  - “only operate within ~/.finger/system”
  - “delegate project operations”
  - “project memory in project root MEMORY.md”

### 2. System Agent 工具白名单
断言:
- `FINGER_SYSTEM_ALLOWED_TOOLS` 包含 `project_tool`

### 3. System Agent cwd / session path
断言:
- `SYSTEM_AGENT_CONFIG.projectPath === ~/.finger/system`
- `SYSTEM_AGENT_CONFIG.sessionPath === ~/.finger/system/sessions`

### 4. Memory 权限控制
断言:
- 非 system agent 无法写 system memory
- system agent 可写 system memory
- 普通 agent 可写 project memory

---

## 二、运行验证（功能测试）

### 1. project_tool.create
步骤:
1. 切换 system agent
2. 调用 project_tool.create({ projectPath })

预期:
- 创建目录
- 初始化 MEMORY.md
- session 创建成功
- orchestrator 分派成功

### 2. 跨项目限制
步骤:
1. system agent 直接尝试写非系统目录

预期:
- 被拒绝或提示必须分派

### 3. MEMORY 自动追加
步骤:
1. 从 channel 发送 user 消息
2. 观察 project MEMORY.md

预期:
- 自动追加 [input] + [summary]

### 4. Agent 派发不记录
步骤:
1. orchestrator -> executor dispatch
2. 检查 MEMORY.md

预期:
- 不追加

---

## 备注
- 静态验证建议用 unit tests
- 功能验证建议用真实 channel / webui
