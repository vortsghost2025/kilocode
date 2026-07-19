# Project

## Outcome

Evolve this Kilo Code fork into a reliable, auditable multi-agent development runtime that preserves strict role boundaries, deterministic delegation, resumable context, and evidence-based validation.

## Users

- The fork maintainer operating long-running coding sessions.
- Reviewers auditing delegated work and repository state.
- Implementers working within explicit file, tool, and Git boundaries.

## Constraints

- Preserve attribution to Kilo Code and OpenCode.
- Keep `main` unchanged; develop on dedicated branches.
- Prefer Kilo-specific paths and minimize shared OpenCode edits.
- Require `kilocode_change` annotations for new fork-specific changes in shared OpenCode paths.
- Do not commit secrets, credentials, personal paths, or private runtime configuration.
- Read-only agents remain read-only; implementation permissions remain explicitly scoped.
- One sequential foreground subagent is the currently proven operating model.
- Runtime MCP services require explicit external configuration.
- Design-only capability specifications are not runtime authorization.

## Non-Goals

- Replacing or claiming authorship of the original Kilo platform.
- Importing the full GSD framework or its permission-bypass defaults.
- Importing large agent rosters that duplicate existing roles.
- Enabling unrestricted parallel foreground execution.
- Adopting commercial provider layers or unrelated product rebrands.

## Success Criteria

- [ ] After a genuine Kilo restart, project intent, requirements, roadmap, phase context, decisions, and verification evidence persist and `/planning` operates within its file boundary.
- [ ] Capability bundles use progressive disclosure instead of eagerly exposing the full skill surface.
- [ ] Accessibility improvements support larger, higher-contrast UI and user-intent-aware auto-scroll.
- [ ] XML/native tool-protocol fallback feasibility is audited against current provider routing.
- [ ] Skill and command exposure has a measured context budget.
- [ ] Worktree-isolated session UI patterns are evaluated against the existing task ownership model.
- [ ] Only non-duplicative specialist skills are selected for adoption.

Future roadmap requirements remain proposed and require Sean's explicit approval before a later phase begins.

## Durable Decisions

- [Decision 0001: Bound persistent planning to `.planning/`](decisions/0001-bound-persistent-planning.md)
