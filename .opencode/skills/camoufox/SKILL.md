---
name: camoufox
description: Use camo CLI for Camoufox automation with layered observe, operate, orchestrate, and recover flows.
---

# Camoufox (`camo`) Skill

`camo` only. Keep this skill short and operational.

## Hard Constraint

Allowed execution surface:
- `camo ...`

Disallowed execution surface:
- direct `curl` to browser/unified APIs
- direct `node scripts/...` for browser control
- direct controllerAction / custom wrappers when an equivalent `camo` command exists

If a required action is unclear or missing, run:

```bash
camo --help
camo <command> --help
```

Then report capability gap instead of switching control surface.

## Capability Map (L1)

1) Observe / Debug  
- DOM + visible filtering: `container filter/list/watch`  
- URL / page context: `status`, `list-pages`, `devtools eval`  
- Console capture: `devtools logs`

2) User-like Operations  
- Click / type / scroll / key / mouse / tab / viewport / window  
- Optional operation highlighting: `highlight-mode`, `--highlight`

3) Orchestration  
- Subscription sets: `container init/register/targets/watch`  
- Scripted flow: `autoscript validate/explain/run/resume/mock-run`

4) Progress / Recovery  
- Real-time and replay events: `events serve/tail/recent/emit`  
- Lifecycle and cleanup: `sessions/status/cleanup/force-stop/shutdown`

## Trigger Conditions

- User asks for any camo CLI browser/session/profile workflow.
- User asks for DOM probing or visible-only element filtering.
- User asks for devtools-style eval/console debugging.
- User asks for simulated user actions (click/type/scroll/keyboard/tab).
- User asks for subscription/autoscript orchestration or runtime recovery.

## Standard Execution Order

1. Check command surface
   - `which camo`
   - `camo --help`
2. Prepare profile/session
   - `camo profile create ...` / `camo profile default ...`
3. Start/reuse browser
   - `camo start ...` / `camo status ...`
4. Execute by layer
   - Observe/Debug or User Ops or Orchestration
5. Collect evidence
   - `camo status`, `camo sessions`, `camo screenshot ...`
   - `camo events recent` / `camo events tail ...`
6. Cleanup if needed
   - `camo cleanup ...`, `camo force-stop ...`, `camo shutdown`

## Core Commands (Compact)

- Profile management: `profiles`, `profile list/create/delete/default`
- Initialization/config: `init`, `init geoip`, `init list`, `create fingerprint`, `create profile`, `config repo-root`
- Browser/session lifecycle: `start`, `stop`, `status`, `list`, `sessions`, `cleanup`, `force-stop`, `lock`, `unlock`
- Browser actions: `goto`, `back`, `scroll`, `click`, `type`, `screenshot`, `highlight`, `clear-highlight`, `viewport`, `window`, `mouse`
- Pages/tabs: `new-page`, `close-page`, `switch-page`, `list-pages`
- Debug: `devtools eval/logs/clear`
- Cookies/system: `cookies ...`, `system display`, `shutdown`
- Container subscription layer: `container init/sets/register/targets/filter/watch/list`
- Autoscript strategy layer: `autoscript scaffold/validate/explain/snapshot/replay/run/resume/mock-run`
- Progress events: `events serve/tail/recent/emit` (non-events commands auto-start daemon)

## Environment Variables

- `WEBAUTO_BROWSER_URL` (default `http://127.0.0.1:7704`)
- `WEBAUTO_REPO_ROOT` (optional explicit repo root)
- `CAMO_PROGRESS_EVENTS_FILE` (optional progress JSONL path)
- `CAMO_PROGRESS_WS_HOST` / `CAMO_PROGRESS_WS_PORT` (progress ws daemon host/port)

## Quick Verification

Run after skill changes:

```bash
camo --help
camo devtools --help
camo container --help
camo autoscript --help
camo events --help
```

For autoscript path:

```bash
camo autoscript scaffold xhs-unified --output /tmp/xhs-unified.sample.json
camo autoscript validate /tmp/xhs-unified.sample.json
camo autoscript explain /tmp/xhs-unified.sample.json
```

## References

- `references/camo-cli-usage.md`
- `references/browser-service-capabilities.md`
