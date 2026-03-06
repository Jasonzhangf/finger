# camo CLI Usage (synced from local `camo --help`)

## 0. Enforcement

Use `camo` commands only.

Do not use:
- `curl` direct API calls
- `node scripts/...` browser-control scripts
- ad-hoc wrappers that bypass `camo`

If command is uncertain, check:

```bash
camo --help
camo <command> --help
```

## 1. Quick Start

```bash
# 1) Bootstrap camoufox + browser-service
camo init

# 2) Create profile and set default
camo profile create xhs-main
camo profile default xhs-main

# 3) Start browser
camo start xhs-main --url https://www.xiaohongshu.com

# 4) Check status
camo status xhs-main

# 5) Stop browser
camo stop xhs-main
```

## 2. Command Map

### Profile management

```bash
camo profiles
camo profile list
camo profile create <profileId>
camo profile delete <profileId>
camo profile default [profileId]
```

### Initialization/config

```bash
camo init
camo init geoip
camo init list
camo create fingerprint --os <os> --region <region>
camo create profile <profileId>
camo config repo-root [path]
```

### Browser/session lifecycle

```bash
camo start [profileId] [--url <url>] [--headless]
camo stop [profileId]
camo status [profileId]
camo list
camo sessions
camo cleanup [profileId]
camo cleanup all
camo cleanup locks
camo force-stop [profileId]
camo lock list
camo lock [profileId]
camo unlock [profileId]
```

### Navigation/actions

```bash
camo goto [profileId] <url>
camo back [profileId]
camo screenshot [profileId] [--output <file>] [--full]
camo scroll [profileId] [--down|--up|--left|--right] [--amount <px>]
camo click [profileId] <selector>
camo type [profileId] <selector> <text>
camo highlight [profileId] <selector>
camo clear-highlight [profileId]
camo viewport [profileId] --width <w> --height <h>
```

### Pages/tabs

```bash
camo new-page [profileId] [--url <url>]
camo close-page [profileId] [index]
camo switch-page [profileId] <index>
camo list-pages [profileId]
```

### Cookies/window/mouse/system

```bash
camo cookies get [profileId]
camo cookies save [profileId] --path <file>
camo cookies load [profileId] --path <file>
camo cookies auto start [profileId] [--interval <ms>]
camo cookies auto stop [profileId]
camo cookies auto status [profileId]

camo window move [profileId] --x <x> --y <y>
camo window resize [profileId] --width <w> --height <h>

camo mouse move [profileId] --x <x> --y <y> [--steps <n>]
camo mouse click [profileId] --x <x> --y <y> [--button left|right|middle] [--clicks <n>] [--delay <ms>]
camo mouse wheel [profileId] [--deltax <px>] [--deltay <px>]

camo system display
camo shutdown
```

### Container subscription layer

```bash
camo container init [--source <container-library-dir>] [--force]
camo container sets [--site <siteKey>]
camo container register [profileId] <setId...> [--append]
camo container targets [profileId]
camo container filter [profileId] <selector...>
camo container watch [profileId] [--selector <css>] [--throttle <ms>]
camo container list [profileId]
```

### Autoscript strategy layer

```bash
camo autoscript scaffold xhs-unified [--output <file>]
camo autoscript validate <file>
camo autoscript explain <file>
camo autoscript snapshot <jsonl-file> [--out <snapshot-file>]
camo autoscript replay <jsonl-file> [--summary-file <path>]
camo autoscript run <file> [--profile <id>] [--jsonl-file <path>] [--summary-file <path>]
camo autoscript resume <file> --snapshot <snapshot-file> [--from-node <nodeId>] [--profile <id>] [--jsonl-file <path>] [--summary-file <path>]
camo autoscript mock-run <file> --fixture <fixture.json> [--profile <id>] [--jsonl-file <path>] [--summary-file <path>]
```

### Progress events

```bash
camo events serve [--host 127.0.0.1] [--port 7788] [--poll-ms 220] [--from-start]
camo events tail [--host 127.0.0.1] [--port 7788] [--profile <id>] [--run-id <id>] [--mode <normal|autoscript>] [--events e1,e2] [--replay 50]
camo events recent [--limit 50]
camo events emit --event <name> [--mode <normal|autoscript>] [--profile <id>] [--run-id <id>] [--payload '{"k":"v"}']
```

## 3. Practical Flows

### A) XHS search bootstrap

```bash
camo init
camo profile default xhs-main
camo start --url https://www.xiaohongshu.com
camo type "#search-input" "工作服定制"
camo click "#search-input"
```

### B) Container subscription setup

```bash
camo container init
camo container sets --site xiaohongshu
camo container register xhs-main xiaohongshu_home.search_input xiaohongshu_search.search_result_item
camo container targets xhs-main
camo container watch xhs-main --throttle 500
```

### C) Autoscript dry-run and validation

```bash
camo autoscript scaffold xhs-unified --output /tmp/xhs-unified.json
camo autoscript validate /tmp/xhs-unified.json
camo autoscript explain /tmp/xhs-unified.json
camo autoscript mock-run /tmp/xhs-unified.json --fixture tests/fixtures/autoscript-events.json
```

### D) Progress event diagnostics

```bash
camo events recent --limit 30
camo events tail --mode autoscript --replay 20
```

### E) Stuck session recovery

```bash
camo sessions
camo lock list
camo cleanup locks
camo force-stop xhs-main
camo shutdown
```

## 4. Troubleshooting

- Browser service connection failure:
  - run `camo init`
  - verify `WEBAUTO_BROWSER_URL`
- Session lock conflict:
  - `camo lock list`
  - `camo cleanup locks` or `camo unlock <profileId>`
- Autoscript run failed:
  - `camo autoscript validate <file>`
  - `camo events recent --limit 80`
  - `camo events tail --mode autoscript --replay 50`
