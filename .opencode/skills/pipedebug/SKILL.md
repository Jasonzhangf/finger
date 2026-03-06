---
name: pipedebug
description: RouteCodex流水线系统调试技能包，专门用于分析和debug RouteCodex V2双向流水线架构中的问题。该技能会读取agents.md、workflow、compatibility和provider的架构文档，分析codex-samples中的日志和快照，定位SSE、格式转换、工具处理等问题，提供交互式的问题诊断和修复建议，并包含完整的修改验证流程：编译构建、单元测试、端到端测试验证。
---

# RouteCodex流水线调试技能包

## 技能概述

pipedebug是专门为RouteCodex V2双向流水线架构设计的调试技能包。提供系统性的问题定位、日志分析、故障诊断、修复实施和验证的完整工作流。

## 核心功能

### 1. 架构理解与分析
- 自动读取RouteCodex架构文档(agents.md、各模块README)
- 理解4层流水线架构：LLM Switch Workflow → Compatibility → Provider → External AI Services
- 分析各组件职责边界和数据流向

### 2. 日志与快照分析
- 读取`~/.routecodex/codex-samples/`下的最新请求/响应日志
- 分析openai-chat和openai-responses的执行轨迹
- 识别异常模式和错误点

### 3. 问题定位策略
- **SSE问题**: 流式传输中断、数据格式错误
- **格式转换**: 协议转换中的字段映射错误
- **工具处理**: llmswitch-core中的工具规范化、收割、指引问题
- **兼容性处理**: provider层的标准化处理问题

### 4. 修复实施与验证
- **代码修改**: 基于问题定位的具体修改建议
- **编译构建**: 自动化编译构建流程
- **单元测试**: 使用失败payload构建针对性测试
- **逻辑验证**: 确保修改逻辑正确性
- **端到端测试**: 完整流程验证

### 5. 迭代优化
- 重新执行分析流程：架构分析 → 功能分工 → 问题定位
- 确保修改达到预期效果
- 验证无副作用

## 完整执行流程

#### 1. 初始化分析
```
读取: ../../routecodex-worktree/fix/AGENTS.md
读取: workflow/compatibility/provider/README
扫描: ~/.routecodex/codex-samples/最新日志
分析: 当前系统状态和错误模式
```

#### 2. 问题识别与定位
```
分析错误模式
定位异常层级
确定问题类型
识别根本原因
```

#### 3. 交互式诊断
```
向用户报告发现的问题
提供多种分析方向
等待用户选择诊断路径
深度分析具体问题点
```

#### 4. 修复方案制定
```
提供具体修改建议
制定分步修复计划
准备测试用例
确定验证标准
```

#### 5. 用户批准与实施
```
等待用户批准修改方案
执行代码修改
进行编译构建
运行单元测试
验证逻辑正确性
```

#### 6. 端到端验证
```
使用原始失败payload测试
验证问题是否解决
检查无副作用
确认性能无退化
```

#### 7. 迭代优化（如需要）
```
如果未达预期效果：
重新分析架构
检查功能分工
重新定位问题
调整修复方案
再次验证
```

## 关键原则

### 问题定位原则
1. **llmswitch唯一性**: 所有SSE、格式转换、工具处理都在llmswitch中统一处理
2. **compatibility纯粹性**: 只处理provider相关的标准化处理，不做多余转换
3. **provider简洁性**: 只负责通信和模型ID双向替换
4. **fail fast**: 错误直接暴露，不隐藏fallback

### 修改验证原则
1. **最小化修改**: 只修改必要部分，避免过度修复
2. **测试驱动**: 每个修改都要有对应测试
3. **渐进验证**: 单元测试 → 集成测试 → 端到端测试
4. **回归预防**: 确保修复不引入新问题

## 使用资源

### references/
- `architecture.md`: RouteCodex架构详解
- `workflow-guide.md`: 工作流调试指南
- `compatibility-rules.md`: 兼容性处理规则
- `provider-specs.md`: Provider接口规范
- `error-patterns.md`: 常见错误模式
- `validation-guide.md`: 验证流程指南

### scripts/
- `log-analyzer.py`: 日志分析脚本
- `error-detect.py`: 错误模式检测
- `pipeline-tracer.py`: 流水链追踪
- `snapshot-parser.py`: 快照解析器
- `test-generator.py`: 单元测试生成器
- `build-validator.py`: 构建验证脚本
- `e2e-tester.py`: 端到端测试工具

## 执行命令示例

### 快速诊断
```bash
# 分析最近的openai-chat请求失败
~/.claude/skills/pipedebug/scripts/log-analyzer.py --errors

# 检查流式传输中断问题
~/.claude/skills/pipedebug/scripts/pipeline-tracer.py --request-id <ID>

# 定位工具调用错误
~/.claude/skills/pipedebug/scripts/error-detect.py --type tool_error
```

### 修复验证
```bash
# 生成单元测试
~/.claude/skills/pipedebug/scripts/test-generator.py \
  --error-id <error_id> \
  --payload <failed_payload>

# 验证构建
~/.claude/skills/pipedebug/scripts/build-validator.py

# 端到端测试
~/.claude/skills/pipedebug/scripts/e2e-tester.py \
  --payload <original_failed_payload>
```

## 注意事项

1. **目标项目**: ../../routecodex-worktree/fix
2. **数据来源**: ~/.routecodex/codex-samples/
3. **交互模式**: 必须询问用户确认分析方向和修改方案
4. **输出目录**: ./claude/skills/pipedebug/
5. **问题聚焦**: 直面问题，不简化，不绕过
6. **验证优先**: 每个修改都要经过完整验证流程
7. **迭代改进**: 未达预期时重新分析，持续优化