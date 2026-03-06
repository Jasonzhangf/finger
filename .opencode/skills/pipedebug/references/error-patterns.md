# 常见错误模式

## 1. SSE流式传输错误

### 表现
- 响应中断不完整
- 客户端连接异常断开
- 数据格式错乱

### 定位方法
```bash
# 检查流式响应日志
grep -l "stream" ~/.routecodex/codex-samples/openai-chat/*post.json
grep -l "error" ~/.routecodex/codex-samples/openai-chat/*finalize*.json
```

### 常见原因
- llmswitch-core流式处理异常
- Compatibility层字段转换错误
- Provider层HTTP连接问题

## 2. 工具调用失败

### 表现
- 工具执行无响应
- 工具结果格式错误
- 工具重复调用

### 定位检查点
1. **llmswitch-core工具规范化**
   - 工具schema是否正确
   - 参数验证是否通过
   - 工具去重是否生效

2. **文本收割器**
   - 工具结果是否完整收割
   - 文本清理是否正确

3. **系统工具指引**
   - 指引注入是否正确
   - 行为标准化是否生效

### 严禁检查
- Compatibility层不应该有工具处理
- Provider层不应该处理工具逻辑

## 3. 协议转换错误

### 表现
- OpenAI ↔ Anthropic转换失败
- 字段映射错误
- 请求格式不兼容

### 检查位置
- llmswitch-core转换层
- Compatibility层字段映射
- 配置文件正确性

## 4. Provider通信错误

### 表现
- HTTP请求失败
- 认证错误
- 模型ID替换错误

### 检查清单
- Provider配置是否正确
- 认证信息是否有效
- 模型ID映射是否准确

## 5. 配置加载错误

### 表现
- 配置文件解析失败
- 默认配置生效
- 动态配置不生效

### 检查方法
```bash
# 验证配置文件格式
cat ../../routecodex-worktree/fix/config/*.json | jq .
```

## 错误分析工作流

### 1. 快速定位
```bash
# 查找最新错误
find ~/.routecodex/codex-samples/ -name "*error*" -o -name "*fail*" | sort -r | head -5
```

### 2. 层级分析
1. 确定错误发生的层级
2. 检查该层职责范围内的问题
3. 验证不跨层处理

### 3. 根因分析
1. 追踪完整请求链路
2. 识别第一个异常点
3. 分析错误传播路径

### 4. 修复验证
1. 实施修复方案
2. 验证问题解决
3. 确认无副作用