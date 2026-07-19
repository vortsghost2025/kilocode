# Phase Plan: 01-persistent-planning

Status: implementation-complete, verification-blocked

## Goal

Add a bounded persistent planning layer and initialize this fork's adoption roadmap.

## Scope

- Allowed files: `.planning/**`, `.kilo/agent/orchestrator.md`, `.kilo/command/planning.md`, `.kilo/skill/planning/**`, README.md, and a focused test under `test/kilocode/`.
- Excluded files: runtime source, external active configuration, `USER_ADDED_INVENTORY.md`, and `.kilo/capability-specs/`.
- Required capabilities: repository reads, bounded documentation edits, focused tests, and formatting checks.

## Steps

1. **Define the artifact contract**
   - Owner: Orchestrator
   - Inputs: Current agent permissions, command/skill conventions, and selected GSD concepts.
   - Changes: Define project, requirements, roadmap, state, phase, verification, and decision templates.
   - Validation: Review required headings and state invariants.
   - Stop conditions: The design requires permission bypass or source-wide changes.
   - Evidence returned: Artifact schema and safety constraints.
2. **Add bounded planning access**
   - Owner: implementation session
   - Inputs: Orchestrator agent definition and permission evaluator behavior.
   - Changes: Add `/planning`, the same-named planning skill, templates, and `.planning/**`-only edit permission.
   - Validation: Evaluate allowed planning paths and denied source paths.
   - Stop conditions: Any source path becomes writable by the Orchestrator.
   - Evidence returned: Focused permission assertions.
3. **Validate discovery and formatting**
   - Owner: implementation session
   - Inputs: Real Command, Skill, Agent, and Permission services.
   - Changes: Add focused discovery and template tests.
   - Validation: Run focused tests, existing Orchestrator test, Prettier, and diff checks.
   - Stop conditions: Command/skill discovery fails or a source path is allowed.
   - Evidence returned: Exact test and formatting outcomes.

## Acceptance

- [x] Static command discovery routes `/planning` to the Orchestrator and discovers the same-named planning skill.
- [x] Permission rules evaluate `.planning/**` as allowed and source/README paths as denied.
- [x] The complete artifact template set is present.
- [x] This fork has initialized project, roadmap, state, phase, decision, and verification artifacts.
- [x] Focused tests and formatting checks pass.
- [ ] A genuine post-restart smoke proves command visibility, skill loading, real planning writes, source denial, status, and resume.

## Risks

- Planning files can become stale; STATE.md must be updated only at meaningful boundaries.
- Artifact volume can consume context; Phase 02 will measure and reduce eager surface cost.
- Permission rules restrict file paths but cannot prove artifact correctness; evidence-gated verification remains necessary.
