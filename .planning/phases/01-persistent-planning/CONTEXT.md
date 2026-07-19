# Phase Context: 01-persistent-planning

## Goal

Preserve project and phase state across compaction and runtime sessions without importing GSD's automation or permission-bypass behavior.

## Requirement IDs

- REQ-001

## Fixed Decisions

- Use one `/planning` router rather than many eagerly exposed commands.
- Keep the Orchestrator as the semantic owner of planning artifacts.
- Permit Orchestrator edits only under `.planning/**`; source edits remain denied.
- Subagents receive only relevant phase context and return evidence to the Orchestrator.
- Verification evidence is required before phase or requirement completion.

## Known Facts

- Project commands load from `.kilo/command/`.
- Project skills load from `.kilo/skill/` and `.kilo/skills/`.
- Edit, write, and apply-patch tools enforce file changes through the `edit` permission and repository-relative paths.
- The existing Orchestrator can delegate but cannot use background tasks.

## Unknowns

- Post-restart `/planning` discovery, skill loading, real file-operation behavior, status, and resume remain unproven.
- Long-term artifact compaction thresholds need usage data.
- Progressive capability loading is deferred to Phase 02.

## Out of Scope

- Runtime database storage for planning state.
- Automatic Git commits or pushes.
- Dependency installation.
- Parallel foreground execution.
- Full GSD command compatibility.
