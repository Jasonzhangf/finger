# Workflow调试指南

## 工作流调试步骤

### 1. 入口分析
检查HTTP请求入口点：
- `/v1/chat` - 双向工具和流式处理
- `/v1/responses` - 双向桥接适配
- `/v1/messages` - 双向协议转换
- `/api/debug` - 双向快照和监控

### 2. llmswitch-core调试
**关键检查点**:
- 工具规范化是否正确
- 文本收割是否完整
- 系统工具指引是否注入
- SSE流式是否正常

**常见问题**:
- 工具格式不规范导致执行失败
- 文本收割不完整导致内容丢失
- 流式传输中断导致响应不完整

### 3. 兼容性处理调试
**检查内容**:
- 字段映射是否正确
- 配置是否加载成功
- 错误兼容是否生效

**注意**: 不应该在此层看到工具处理逻辑

### 4. Provider通信调试
**验证点**:
- HTTP通信是否正常
- 认证是否成功
- 模型ID替换是否正确

### 5. 外部服务调试
**检查项**:
- API调用格式
- 响应解析
- 错误处理

## 调试工具使用

### 日志分析
```bash
# 查看最新请求日志
ls -la ~/.routecodex/codex-samples/openai-chat/ | tail -5

# 分析请求-响应对
grep -l "error" ~/.routecodex/codex-samples/openai-chat/*.json
```

### 快照解析
```bash
# 查看执行快照
cat ~/.routecodex/codex-samples/openai-chat/req_*_snapshot.json
```

## 问题定位模式

### SSE问题
1. 检查llmswitch-core的流式处理
2. 验证Compatibility层的字段转换
3. 确认Provider层的HTTP通信

### 工具处理问题
1. 重点检查llmswitch-core工具规范化
2. 验证工具收割和指引
3. 确认不在其他层处理工具

### 格式转换问题
1. 检查协议转换逻辑
2. 验证字段映射配置
3. 确认双向转换一致性