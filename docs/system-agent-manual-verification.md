# System Agent 手动验证指南

## 准备工作

### 1. 启动 Daemon
```bash
npm run build:backend
npm start
```

### 2. 确认 Daemon 运行
```bash
curl http://localhost:5523/health
```

## 验证步骤

### 步骤 1: 切换到 System Agent

**通过 QQ 发送**:
```
<##@system##>
```

**预期结果**:
- System Agent 回复已切换
- 显示 system agent session 信息
- 列出最近 3 条 system agent 会话

### 步骤 2: 创建项目

**发送消息**:
```
创建一个新项目：
项目路径: /tmp/test-project
项目名称: 测试项目
描述: System Agent 手动验证
```

**预期结果**:
- System Agent 调用 project_tool
- 创建 /tmp/test-project 目录
- 初始化 MEMORY.md
- 分派 orchestrator agent 到项目
- 返回项目 ID 和 session ID

### 步骤 3: 验证项目创建

**执行命令**:
```bash
ls -la /tmp/test-project/
cat /tmp/test-project/MEMORY.md
```

**预期结果**:
- ��录创建成功
- MEMORY.md 包含项目信息

### 步骤 4: 验证 MEMORY 自动记录

**发送消息到 System Agent**:
```
记录一条测试消息：今天是 2026-03-13，正在验证 System Agent
```

**执行命令**:
```bash
cat ~/.finger/system/MEMORY.md
```

**预期结果**:
- 包含用户输入
- 包含 agent 响应的 summary
- 包含时间戳

### 步骤 5: 验证跨项目限制

**发送消息**:
```
直接读取 /etc/passwd 文件内容
```

**预期结果**:
- System Agent 拒绝操作
- 提示只能操作 ~/.finger/system 目录
- 建议创建项目并分派

## 验证检查清单

- [ ] Daemon 启动成功
- [ ] finger-system-agent 模块注册
- [ ] project_tool 工具加载
- [ ] 切换到 system agent 成功
- [ ] project_tool.create 执行成功
- [ ] 项目目录创建
- [ ] MEMORY.md 初始化
- [ ] orchestrator 分派成功
- [ ] 用户输入记录到 system MEMORY.md
- [ ] agent summary 记录到 system MEMORY.md
- [ ] 拒绝非系统目录访问
- [ ] 切换回普通 agent 成功

Tags: system-agent, manual-verification, testing
