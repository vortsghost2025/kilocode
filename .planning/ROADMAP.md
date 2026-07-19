# Roadmap

| Phase                  | Goal                                                                                 | Requirements     | Dependencies           | Status  |
| ---------------------- | ------------------------------------------------------------------------------------ | ---------------- | ---------------------- | ------- |
| 01-persistent-planning | Add safe, resumable planning artifacts owned by the Orchestrator.                    | REQ-001          | none                   | active  |
| 02-capability-bundles  | Introduce progressive-disclosure capability bundles.                                 | REQ-002, REQ-005 | 01-persistent-planning | pending |
| 03-accessibility-ui    | Add accessibility styling and user-intent-aware streaming scroll behavior.           | REQ-003          | 01-persistent-planning | pending |
| 04-tool-protocol-audit | Audit XML/native tool protocol fallback for inconsistent providers and local models. | REQ-004          | 01-persistent-planning | pending |
| 05-worktree-ui-audit   | Evaluate worktree-isolated session UI patterns.                                      | REQ-006          | 01-persistent-planning | pending |
| 06-specialist-skills   | Select and add only specialist skills that do not duplicate current agents.          | REQ-007          | 02-capability-bundles  | pending |

## Status Values

- `pending`
- `active`
- `blocked`
- `verified`

Phases advance to `verified` only when their VERIFICATION.md records passing evidence.

Phases 02 through 06 are proposals only. They require Sean's explicit approval before planning or implementation begins.
