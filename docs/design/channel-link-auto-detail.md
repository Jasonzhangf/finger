# Channel Link Auto Detail (QQ/Weixin)

## Goal

When inbound channel text contains web links:

- If link is Weibo (`weibo.com`, `weibo.cn`), auto-submit **webauto weibo detail** task.
- If link is Xiaohongshu (`xiaohongshu.com`, `xhslink.com`), auto-submit **webauto xhs unified --stage detail** task.

This runs in background and does **not** block normal agent dispatch.

---

## Capability Check (webauto)

- **Weibo detail**: supports links via `--links-file` (JSONL).  
  `finger` writes a temporary links JSONL file and submits:
  `webauto daemon task submit --detach -- weibo detail ... --links-file <file>`

- **XHS detail**: supports link-driven detail via `--shared-harvest-path` + `--stage detail`.  
  `finger` writes a temporary safe-detail-urls JSONL style file and submits:
  `webauto daemon task submit --detach -- xhs unified --stage detail --shared-harvest-path <file> ...`

- **Dynamic output path**: both commands support `--output-root`, loaded from config.

---

## Config Skeleton (`~/.finger/config/config.json`)

```json
{
  "channelAutoDetail": {
    "enabled": true,
    "channels": ["qqbot", "openclaw-weixin"],
    "triggers": [
      {
        "id": "weibo-detail",
        "enabled": true,
        "channels": ["qqbot"],
        "match": {
          "urlHosts": ["weibo.com", "weibo.cn"]
        },
        "input": {
          "format": "jsonl",
          "fileNamePrefix": "weibo",
          "rowTemplate": "{\"id\":\"${message_id}-${index}\",\"url\":\"${url}\"}"
        },
        "output": {
          "outputRoot": "~/.webauto/download"
        },
        "command": {
          "bin": "webauto",
          "cwd": "~/github/webauto",
          "timeoutMs": 15000,
          "args": [
            "daemon",
            "task",
            "submit",
            "--detach",
            "--",
            "weibo",
            "detail",
            "--profile",
            "weibo",
            "--links-file",
            "${links_file}",
            "--max-posts",
            "1",
            "--output-root",
            "${output_root}"
          ]
        }
      }
    ]
  }
}
```

### Notes

- `enabled=false` disables feature globally.
- Global `channels` is default scope; trigger-level `channels` can override it.
- `match` supports:
  - `urlHosts`: host suffix match (`a.b.weibo.com` matches `weibo.com`)
  - `urlHostRegex`: hostname regex
  - `containsAny`: message text must contain one keyword
- `input.rowTemplate` placeholders:
  - `${url}`, `${index}`, `${note_id}`, `${channel_id}`, `${message_id}`
- `command.args` placeholders:
  - `${links_file}`, `${links_count}`, `${channel_id}`, `${message_id}`, `${output_root}`
- `output.outputRoot` can be configured per trigger; it overrides global `channelAutoDetail.outputRoot`.
- Trigger engine writes JSONL to runtime temp path and submits command asynchronously.

## Backward Compatibility

If `triggers` is empty, system still supports old quick config:

- `channelAutoDetail.weibo`
- `channelAutoDetail.xiaohongshu`

and auto-generates equivalent built-in trigger rules.

## Skillized Config Change Path

Configuration change workflow is now also packaged as a system skill:

- `~/.finger/skills/channel-auto-trigger/SKILL.md`

Use this skill for future trigger updates so operators follow the same:

- backup
- edit
- JSON validation
- runtime verification
- rollback
