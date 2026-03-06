
## 2026-03-06 Collaboration Preferences
- 当用户要求“提交所有代码”时，提交仓库内代码/文档/测试/脚本变更，但排除构建物、日志、临时文件、生成物、隐私文件与本地工具状态目录。
- 与 agent prompt 相关的覆盖链路采用：默认读取仓库系统 prompt，用户保存后写入 `~/.finger/runtime/agents/<agent-id>/prompts/...`，并以下次任务开始时优先加载该覆盖。
