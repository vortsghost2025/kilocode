---
description: manage persistent project and phase planning artifacts
agent: orchestrator
---

Load the `planning` skill and manage the project-local `.planning/` state for:

$ARGUMENTS

Supported actions:

- `init` — establish PROJECT.md, REQUIREMENTS.md, ROADMAP.md, and STATE.md after confirming the project goal and constraints;
- `status` — summarize current phase, verified work, blockers, and next safe action without modifying files;
- `validate` — compare recorded planning state with the live repository and report drift without modifying files;
- `phase <id>` — discuss and write the selected phase CONTEXT.md and PLAN.md;
- `verify <id>` — evaluate evidence, write VERIFICATION.md, and advance state only when acceptance criteria are proven;
- `decision <slug>` — record a durable decision under `.planning/decisions/`;
- `pause` — update STATE.md with exact repository state, evidence, limits, and continuation action;
- `resume` — restore context from STATE.md and only the current phase artifacts.

If no action is supplied, use `status`.

For `validate`, report:

- RECORDED BRANCH
- LIVE BRANCH
- RECORDED VERIFIED COMMIT
- LIVE HEAD
- MISSING ARTIFACTS
- ROADMAP/STATE DISAGREEMENTS
- REQUIREMENT STATUS INCONSISTENCIES
- UNEXPECTED PHASE FILES
- BLOCKERS
- SMALLEST SAFE CORRECTION

Validation is read-only. Do not automatically rewrite, synchronize, create, or delete planning artifacts.

The Orchestrator owns artifact meaning and state transitions. Modify only `.planning/**`. Do not edit source, install dependencies, commit, push, bypass permissions, or mark work verified without evidence.
