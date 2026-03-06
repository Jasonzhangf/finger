---
name: bd-task-flow
description: Manage task tracking with the Beads `bd` CLI using `--no-db` and `.beads/issues.jsonl`. Use when creating, claiming, updating, or closing issues/epics, resolving bd conflicts, or following git-portable sync rules.
---

# BD Task Flow

## Overview

Use `bd` as the single source of truth for tasks, dependencies, and progress. Keep `.beads/issues.jsonl` consistent by using CLI commands only.

## Workflow

1. Check existing work before starting.
2. Create or update the issue with clear acceptance criteria.
3. Claim the issue before making changes.
4. Track dependencies without introducing cycles.
5. Close issues only with reproducible evidence.
6. Sync and resolve conflicts via bd tooling.

## Required Commands

- `bd init --no-db`
- `bd --no-db where`
- `bd --no-db ready`
- `bd --no-db search "<keywords>"`
- `bd --no-db show <id>`
- `bd --no-db create "Title" -p 0 --parent <epic>`
- `bd --no-db update <id> --claim`
- `bd --no-db update <id> --status in_progress|blocked|closed`
- `bd --no-db dep add <blocked> <blocker>`
- `bd --no-db close <id> --reason "<what>" --suggest-next`

## Sync And Conflict Rules

- Use `bd sync mode set git-portable` for git-only collaboration.
- Install hooks with `bd hooks install` to auto-sync on commit/merge/push.
- Force a flush before handoff with `bd sync`.
- Resolve JSONL conflicts with `bd resolve-conflicts` only.
- Do not hand-edit `.beads/issues.jsonl`.

## File Rules

- Version only `.beads/issues.jsonl` in git.
- Keep other `.beads/*` as local runtime state.
- Do not create TODOs in `AGENTS.md`; track work in `bd` issues instead.
