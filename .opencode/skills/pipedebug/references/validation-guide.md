# 验证流程指南

## 验证工作流概述

RouteCodex修改验证遵循渐进式验证原则：单元测试 → 集成测试 → 端到端测试。确保每个修改都经过完整验证，避免引入新问题。

## 1. 编译构建验证

### 构建流程
```bash
# 进入项目目录
cd ../../routecodex-worktree/fix

# 清理之前的构建
npm run clean

# 执行完整构建
npm run build

# 类型检查
npm run typecheck

# 代码质量检查
npm run lint
npm run lint:fix
```

### 构建验证检查点
- [ ] TypeScript编译无错误和警告
- [ ] 所有依赖正确解析
- [ ] 构建产物生成到dist/目录
- [ ] ESLint检查通过（无error级别问题）
- [ ] 代码格式化检查通过
- [ ] 类型定义文件生成正确

### 构建失败处理
1. **编译错误**: 检查TypeScript语法和类型定义
2. **依赖错误**: 验证package.json和node_modules
3. **类型错误**: 检查接口定义和类型导入
4. **ESLint错误**: 修复代码质量问题

## 2. 单元测试生成与执行

### 测试生成策略
使用失败payload生成针对性测试用例，确保修复的准确性。

### 测试类型
1. **边界测试**: 测试错误发生的边界条件
2. **功能测试**: 测试修复后的功能正确性
3. **回归测试**: 确保不影响现有功能
4. **性能测试**: 验证性能无显著退化

### 测试生成脚本
```bash
# 基于错误日志生成测试
~/.claude/skills/pipedebug/scripts/test-generator.py \
  --error-id tool_error_001 \
  --payload ~/.routecodex/codex-samples/openai-chat/failed_request.json \
  --output ./tests/generated/
```

### 测试执行验证
```bash
# 运行生成的测试
npm test -- tests/generated/

# 运行相关模块测试
npm test -- --testPathPattern="llmswitch"

# 检查测试覆盖率
npm run test:coverage

# 监视模式测试
npm run test:watch
```

### 测试验证标准
- [ ] 新测试用例全部通过
- [ ] 测试覆盖率达到80%以上
- [ ] 相关现有测试仍然通过
- [ ] 边界条件测试通过
- [ ] 错误处理测试通过

## 3. 逻辑验证

### 验证方法
1. **静态分析**: 代码审查和逻辑分析
2. **动态测试**: 运行时行为验证
3. **集成测试**: 模块间交互验证
4. **性能测试**: 响应时间和资源使用

### 逻辑验证检查点
```bash
# 检查特定模块逻辑
npm test -- --testNamePattern="工具规范化逻辑"

# 运行流水线集成测试
npm test -- --testPathPattern="pipeline-integration"

# 验证SSE流式处理
npm test -- --testNamePattern="流式传输"
```

### 逻辑验证标准
- [ ] 修改逻辑符合预期
- [ ] 边界条件处理正确
- [ ] 错误恢复机制有效
- [ ] 性能指标在预期范围内
- [ ] 内存使用无泄漏

## 4. 端到端测试

### 测试环境准备
```bash
# 启动开发服务器
npm run dev &

# 等待服务启动
sleep 5

# 验证服务健康状态
curl http://localhost:5506/api/health
```

### 测试执行
```bash
# 使用原始失败payload测试
~/.claude/skills/pipedebug/scripts/e2e-tester.py \
  --payload ~/.routecodex/codex-samples/openai-chat/failed_request.json \
  --endpoint http://localhost:5506/v1/chat

# 批量端到端测试
~/.claude/skills/pipedebug/scripts/e2e-tester.py \
  --payload-dir ~/.routecodex/codex-samples/ \
  --test-count 10
```

### 端到端验证检查点
- [ ] 原始失败请求现在成功
- [ ] 响应格式符合OpenAI规范
- [ ] 工具调用正确执行
- [ ] 流式传输无中断
- [ ] 响应时间在合理范围
- [ ] 无新错误产生

## 5. 性能验证

### 性能指标
- **响应时间**: < 2秒（正常请求）
- **SSE延迟**: < 100ms（流式响应）
- **内存使用**: < 512MB（单请求）
- **CPU使用**: < 50%（峰值）

### 性能测试命令
```bash
# 基准性能测试
npm run test:performance

# 负载测试
npm run test:load -- --concurrent=10 --duration=60s

# 内存泄漏测试
npm run test:memory -- --iterations=100
```

## 6. 迭代验证流程

### 失败处理流程
如果任何验证步骤失败：

1. **分析失败原因**
   ```bash
   # 查看详细错误日志
   npm test -- --verbose
   ```

2. **定位问题点**
   ```bash
   # 使用流水线追踪器
   ~/.claude/skills/pipedebug/scripts/pipeline-tracer.py --request-id <failed_id>
   ```

3. **重新分析架构**
   ```bash
   # 重新读取架构文档
   cat ../../routecodex-worktree/fix/AGENTS.md
   ```

4. **调整修复方案**
   - 基于新分析结果修改方案
   - 重新考虑架构边界
   - 验证功能分工正确性

5. **重新执行验证**
   - 从编译构建开始
   - 完整执行所有验证步骤

### 验证通过标准
- [ ] 所有编译检查通过
- [ ] 所有单元测试通过
- [ ] 所有逻辑验证通过
- [ ] 所有端到端测试通过
- [ ] 性能指标达标
- [ ] 无副作用产生

## 7. 验证报告生成

### 自动化报告
```bash
# 生成验证报告
~/.claude/skills/pipedebug/scripts/validation-reporter.py \
  --test-results ./test-results/ \
  --output ./validation-report.md
```

### 报告内容
1. **构建结果**: 编译、类型检查、代码质量
2. **测试结果**: 单元测试、集成测试、覆盖率
3. **性能结果**: 响应时间、资源使用
4. **端到端结果**: 功能验证、错误处理
5. **问题清单**: 发现的问题和解决方案

## 8. 常见验证问题

### 编译问题
- **类型不匹配**: 检查接口定义和实现
- **依赖缺失**: 验证package.json配置
- **语法错误**: 检查TypeScript语法

### 测试问题
- **测试失败**: 分析失败原因，修复代码或测试
- **覆盖率不足**: 补充测试用例
- **异步测试**: 确保正确的异步处理

### 端到端问题
- **服务启动失败**: 检查端口和配置
- **请求超时**: 调整超时设置
- **响应格式错误**: 检查序列化逻辑

### 性能问题
- **响应慢**: 优化算法和数据库查询
- **内存泄漏**: 检查对象生命周期
- **CPU高**: 优化计算密集型操作

## 验证最佳实践

1. **渐进验证**: 从小规模测试到大规模验证
2. **自动化**: 尽可能自动化验证流程
3. **监控**: 持续监控系统性能和错误
4. **文档**: 记录验证结果和问题解决过程
5. **回归预防**: 每次修复后都要验证无副作用