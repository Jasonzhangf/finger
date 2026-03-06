# Agent prompt override chain

- Task: make agent prompt loading default to system prompts and save overrides under ~/.finger.
- Runtime now carries agent.json prompts into runtime config and finger role modules resolve prompt paths per-agent.
- API /api/v1/agents/configs/:agentId/prompts now reads agent override paths under ~/.finger/runtime/agents/<agent>/prompts and falls back to repo default prompts when missing.
- Saving prompts writes to ~/.finger override files and updates ~/.finger/runtime/agents/<agent>/agent.json prompts paths.
- Verified with build, unit test, live API checks, and camo UI screenshot showing drawer source/editablePath under ~/.finger.
