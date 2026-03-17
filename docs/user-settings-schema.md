# 用户配置文件结构设计

## 配置文件位置
`~/.finger/config/user-settings.json`

## 配置文件结构

```json
{
  "version": "1.0",
  "updated_at": "2026-03-17T09:48:17+08:00",
  "aiProviders": {
    "default": "tcm",
    "providers": {
      "crs": {
        "name": "crs",
        "base_url": "https://api.funai.vip/openai",
        "wire_api": "responses",
        "env_key": "CRS_OAI_KEY",
        "model": "gpt-5.4",
        "enabled": true
      },
      "crsa": {
        "name": "crsa",
        "base_url": "https://api.funai.vip/openai",
        "wire_api": "responses",
        "env_key": "CRS_OAI_KEY1",
        "model": "gpt-5.3-codex",
        "enabled": true
      },
      "tcm": {
        "name": "tcm",
        "base_url": "http://127.0.0.0.1:5555/v1",
        "wire_api": "responses",
        "env_key": "TAILCODEX_HTTP_APIKEY",
        "model": "gpt-5.4",
        "enabled": true
      },
      "rcm": {
        "name": "rcm",
        "base_url": "http://127.0.0.0.1:5520/v1",
        "wire_api": "responses",
        "env_key": "ROUTECODEX_HTTP_APIKEY",
        "model": "gpt-5.4",
        "enabled": true
      }
    }
  },
  "preferences": {
    "defaultModel": "gpt-5.4",
    "maxTokens": 256000,
    "temperature": 0.7,
    "reasoningEffort": "high",
    "reasoningSummary": "detailed",
    "verbosity": "medium",
    "showRawAgentReasoning": false,
    "webSearch": "live"
  },
  "ui": {
    "theme": "dark",
    "language": "zh-CN",
    "timeZone": "Asia/Shanghai"
  }
}
```

## 字段说明

### aiProviders
- **default**: 默认AI供应商ID
- **providers**: AI供应商配置对象
  - **name**: 供应商名称
  - **base_url**: API基础URL
  - **wire_api**: wire协议类型（responses/http）
  - **env_key**: 环境变量key（用于获取API密钥）
  - **model**: 默认模型
  - **enabled**: 是否启用

### preferences
- **defaultModel**: 默认模型
- **maxTokens**: 最大token数
- **temperature**: 温度参数
- **reasoningEffort**: 推理强度（high/medium/low）
- **reasoningSummary**: 推理总结详细程度（detailed/medium/short）
- **verbosity**: 日志详细程度（high/medium/low）
- **showRawAgentReasoning**: 是否显示原始agent推理
- **webSearch**: 网络搜索模式（live/off）

### ui
- **theme**: UI主题（dark/light）
- **language**: 语言设置
- **timeZone**: 时区

## 配置优先级

1. 用户配置文件（~/.finger/config/user-settings.json）
2. 系统默认配置（~/.finger/config/config.json）
3. 代码硬编码默认值

## 与现有配置的关系

### 现有config.json（内核配置）
```json
{
  "kernel": {
    "providers": { ... },
    "provider": "tcm"
  }
}
```

### 新增user-settings.json（用户配置）
```json
{
  "aiProviders": { ... },
  "preferences": { ... },
  "ui": { ... }
}
```

**关系**：
- config.json：内核级别的provider配置（系统使用）
- user-settings.json：用户级别的配置和偏好（用户自定义）

配置合并策略：
- user-settings.json优先级更高
- 系统启动时合并两个配置
