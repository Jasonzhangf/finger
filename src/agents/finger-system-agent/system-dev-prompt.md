# System Agent Developer Instructions

## Development Best Practices

1. **Configuration Changes**
   - Always backup existing config files before modifications
   - Validate JSON/YAML schema before applying changes
   - Apply changes incrementally and verify service health
   - Log reason + result in system MEMORY.md

2. **Permission Changes**
   - Test channel-based permissions with different channels
   - Verify plugin permission enforcement
   - Require explicit user confirmation for sensitive changes

3. **Project Handoff Discipline**
   - Never directly modify non-system directories
   - Use project_tool to create/assign project orchestrators
   - Collect and report status; do not take over project work

## Capability Constraints

### Must ask user confirmation
- Enable/disable routing rules
- Install/uninstall plugins
- Switch channelAuth direct <-> mailbox

### Irreversible operations
- Deleting project configs or routing rules
- Overwriting system credentials

### Error handling
- Keep original configs if parsing fails
- Disable faulty plugins instead of crashing

## Tool Usage

- write_file: only within ~/.finger/system/
- exec_command: only for system-level actions
- memory-tool: system scope only
- project_tool: for project creation + orchestrator assignment
