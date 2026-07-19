---
name: planning
description: Maintain bounded project and phase context across sessions with evidence-gated state transitions.
---

# Planning Artifacts

Use this skill to preserve project intent, phase scope, decisions, and verified state across context compaction and runtime sessions.

## Activation

Load this skill when:

- the user invokes `/planning`;
- `.planning/PROJECT.md` already exists and work is being resumed;
- a project spans multiple phases or sessions;
- a phase needs an explicit plan, handoff, or verification record.

Do not initialize planning artifacts for a trivial, single-step task.

## Artifact Layout

```text
.planning/
├── PROJECT.md
├── REQUIREMENTS.md
├── ROADMAP.md
├── STATE.md
├── phases/
│   └── <phase>/
│       ├── CONTEXT.md
│       ├── PLAN.md
│       └── VERIFICATION.md
└── decisions/
    └── <number>-<slug>.md
```

Read only the artifact templates needed for the requested action from `templates/`.

## Ownership and Permissions

- The Orchestrator owns artifact meaning, phase transitions, and requirement status.
- The Orchestrator may edit only `.planning/**`. It must not edit source through this workflow.
- Subagents receive only the current phase's relevant context, plan steps, requirement IDs, allowed file scope, and evidence contract.
- Subagents return evidence to the Orchestrator; they do not mark phases complete or rewrite project-level artifacts.
- Planning artifacts are context and audit records, not authorization for source edits, dependency installation, Git writes, network access, or permission bypass.

## Workflow

### Initialize

1. Verify that `.planning/PROJECT.md` does not already exist.
2. Establish the outcome, users, constraints, non-goals, and measurable success criteria.
3. Give every accepted requirement a stable `REQ-###` identifier.
4. Divide work into dependency-ordered phases with explicit goals and requirement coverage.
5. Create STATE.md with the exact branch, last verified implementation commit, current phase, blockers, and next safe action when available.

### Validate State

Validation is read-only. Compare recorded planning state with the live repository and report:

1. recorded branch versus live branch;
2. last verified implementation commit versus live HEAD;
3. missing PROJECT.md, REQUIREMENTS.md, ROADMAP.md, STATE.md, current-phase CONTEXT.md, PLAN.md, or VERIFICATION.md files;
4. current phase and status disagreements between ROADMAP.md and STATE.md;
5. requirements marked delivered without a verified phase, or phase requirement IDs missing from REQUIREMENTS.md;
6. phase directories not represented in ROADMAP.md;
7. blockers and the smallest safe correction.

Do not rewrite, synchronize, create, delete, or repair artifacts during validation. A recorded implementation commit may legitimately differ from live HEAD; report the difference rather than treating every difference as corruption.

### Plan a Phase

1. Read PROJECT.md, REQUIREMENTS.md, ROADMAP.md, STATE.md, and only the selected phase directory.
2. Resolve material ambiguity with the user before writing PLAN.md.
3. Record fixed decisions and unknowns in CONTEXT.md.
4. Write small, ordered plan steps with owners, allowed files, validation commands, stop conditions, and evidence requirements.
5. Keep unrelated future-phase details out of the subagent context.

### Execute and Handoff

1. Delegate one foreground implementation step at a time unless separate parallel safety has been proven.
2. Include only the relevant plan step and context in each delegation prompt.
3. Require the subagent to report changed files, exact validation, failures, limitations, and next action.
4. Update STATE.md at meaningful boundaries, before compaction, and before ending an incomplete session.

### Verify

1. Compare implementation evidence with the phase acceptance criteria and requirement IDs.
2. Record commands and outcomes; do not claim a check ran if no output was observed.
3. Write VERIFICATION.md with `passed`, `failed`, or `blocked` status.
4. Mark roadmap phases and requirements delivered only after verification passes.
5. If verification fails or is incomplete, record gaps and the smallest safe remediation step.

### Record Decisions

Create a decision record when a choice changes architecture, security boundaries, persisted data, public behavior, provider/runtime assumptions, or future phase scope. Include alternatives and evidence. Never include credentials or secret values.

## State Invariants

- PROJECT.md states durable intent; it is not a session log.
- REQUIREMENTS.md uses stable IDs and explicit acceptance criteria.
- ROADMAP.md records dependency order and phase status.
- STATE.md is concise, current, sufficient to resume safely, and records the last implementation commit that was actually verified rather than claiming its own future commit hash.
- CONTEXT.md records user decisions, known facts, unknowns, and exclusions.
- PLAN.md defines executable steps and their evidence contracts.
- VERIFICATION.md distinguishes observed evidence from assumptions.
- Decision records are append-only; supersede rather than silently rewriting history.

## Safety Rules

- Never bypass prompts or broaden permissions to make a plan easier to execute.
- Never place tokens, credentials, personal paths, raw environment values, or private configuration in planning artifacts.
- Never copy full transcripts into STATE.md; summarize decisions and link evidence by file, command, or commit.
- Never mark a phase complete based only on a subagent's assertion.
- Stop and ask for clarification when project goals, phase boundaries, or acceptance criteria conflict.

## Output

After every action, report:

- ACTION
- ARTIFACTS READ
- ARTIFACTS CHANGED
- CURRENT PHASE
- VERIFIED EVIDENCE
- BLOCKERS
- NEXT SAFE ACTION
