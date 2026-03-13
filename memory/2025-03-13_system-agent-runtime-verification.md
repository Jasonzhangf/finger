# System Agent 运行时验证框架

日期: 2025-03-13

Tags: system-agent, runtime-verification, testing, integration-test

## 验证框架设计

### 测试文件
`tests/integration/system-agent-runtime.test.ts`

### 测试用例

#### 1. Daemon 启动验证
```typescript
it('should verify daemon is running', async () => {
  expect(daemonProcess?.pid).toBeDefined();
  expect(daemonProcess?.killed).toBe(false);
});
```

#### 2. System Agent 模块注册验证
```typescript
it('should verify system agent module registered with project_tool', async () => {
  expect(daemonOutput).toContain('finger-system-agent');
  expect(daemonOutput).toContain('project_tool');
  expect(daemonOutput).toMatch(/tools=.*project_tool/);
});
```

#### 3. System Agent 目录结构验证
```typescript
it('should verify system agent configuration', async () => {
  const systemDir = path.join(process.env.HOME, '.finger/system');
  expect(systemDirExists).toBe(true);
});
```

#### 4. MEMORY 记录机制验证
```typescript
it('should verify memory recording mechanism in dispatch code', async () => {
  const dispatchContent = await fs.readFile(dispatchPath, 'utf-8');
  expect(dispatchContent).toContain('MEMORY.md');
  expect(dispatchContent).toContain('metadata.source');
  expect(dispatchContent).toContain('metadata.role');
});
```

#### 5. project_tool 实现验证
```typescript
it('should verify project_tool implementation', async () => {
  const projectToolContent = await fs.readFile(projectToolPath, 'utf-8');
  expect(projectToolContent).toContain('registerProjectTool');
  expect(projectToolContent).toContain('create');
  expect(projectToolContent).toContain('MEMORY.md');
  expect(projectToolContent).toContain('sessionManager');
});
```

### 运行测试

```bash
# 构建后端
npm run build:backend

# 运行集成测试
npx vitest run tests/integration/system-agent-runtime.test.ts
```

### 测试结果

```
 ✓ tests/integration/system-agent-runtime.test.ts  (5 tests) 3930ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Duration  4.19s
```

## 验证覆盖范围

### ✅ 已验证
- Daemon 启动成功
- finger-system-agent 模块注册
- project_tool 工具加载
- System Agent 目录结构
- MEMORY 记录机制代码实现
- project_tool 实现文件存在

### ⏳ 待手动验证
- 实际发送消息到 System Agent
- project_tool.create 创建项目
- MEMORY 自动追加用户输入和 summary
- 跨项目限制生效
- Agent 派发不记录

## 扩展测试

### 通过 API 测试（需要手动验证）

1. **切换到 System Agent**
   ```bash
   # 通过 QQ 发送: <##@system##>
   ```

2. **创建项目**
   ```
   创建一个新项目：
   项目路径: /tmp/test-project
   项目名称: 测试项目
   ```

3. **验证项目创建**
   ```bash
   ls -la /tmp/test-project/
   cat /tmp/test-project/MEMORY.md
   ```

4. **验证 MEMORY 记录**
   ```bash
   cat ~/.finger/system/MEMORY.md
   ```

## 测试设计原则

1. **自动化优先**: 尽可能自动化验证，减少手动操作
2. **代码层面验证**: 验证实现文件和关键逻辑存在
3. **运行时验证**: 验证 daemon 启动和模块注册
4. **可扩展性**: 测试框架易于添加新的验证用例

## 下一步

1. 添加 HTTP API 测试（需要 daemon 支持）
2. 添加 WebSocket 消息测试
3. 添加 channel 消息测试
4. 添加 MEMORY 自动追加验证
