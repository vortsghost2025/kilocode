# Decision 0001: Bound Persistent Planning to `.planning/`

Status: accepted
Date: 2026-07-19

## Context

Long-running and multi-session work needs durable context, but importing a large workflow framework would add commands, agents, automation, and permission assumptions that conflict with this fork's safety model.

## Decision

Use a small `.planning/` artifact set managed by one `/planning` router. The Orchestrator owns artifact meaning and may edit only `.planning/**`. Source changes remain delegated to explicitly scoped implementation agents. Phase completion requires recorded evidence.

## Evidence

- Kilo project commands and skills are discovered from `.kilo/` without runtime source changes.
- File edit tools enforce repository-relative paths through the `edit` permission.
- Focused tests prove the permission rules evaluate `.planning/**` as allowed while source and README paths evaluate as denied; actual tool operations require a post-restart smoke.

## Alternatives

- Import full GSD: rejected because its broad command surface and automation exceed current requirements.
- Add a planning-writer agent: rejected because it increases routing ambiguity and separates ownership from the Orchestrator.
- Store state only in memory: rejected because it does not survive compaction or new sessions.
- Give the Orchestrator general write access: rejected because it weakens role boundaries.

## Consequences

- Planning survives session boundaries in reviewable Markdown.
- The Orchestrator permission policy is intended to permit planning-file maintenance without source-write authority; runtime proof remains pending.
- Planning state must be kept concise and manually evidence-gated.
- Progressive skill-surface budgeting remains separate Phase 02 work.

## Supersedes

None.
