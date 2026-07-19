# Requirements

| ID      | Requirement                                                                                       | Priority | Acceptance                                                                                                                                | Status   |
| ------- | ------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| REQ-001 | Persist project, requirement, roadmap, phase, decision, and verification context across sessions. | must     | After a genuine Kilo restart, `/planning` appears once, loads the planning skill, writes only `.planning/**`, and supports status/resume. | accepted |
| REQ-002 | Load capability bundles progressively.                                                            | must     | Agents see only role-relevant capability entry points; exposure and token cost are measured.                                              | proposed |
| REQ-003 | Improve accessibility and preserve user scroll intent.                                            | should   | An accessibility stylesheet and streaming auto-scroll behavior pass focused visual and interaction checks.                                | proposed |
| REQ-004 | Evaluate XML/native tool-protocol fallback.                                                       | should   | A read-only architecture audit identifies compatible seams, provider risks, and a bounded implementation recommendation.                  | proposed |
| REQ-005 | Budget the exposed skill and command surface.                                                     | must     | Eager entries and estimated context cost are reported; a bounded router design is validated.                                              | proposed |
| REQ-006 | Evaluate worktree-isolated session UI patterns.                                                   | should   | An audit compares official Agent Manager patterns with this fork's ownership and capability boundaries.                                   | proposed |
| REQ-007 | Add only non-duplicative specialist capabilities.                                                 | could    | Candidate accessibility, security, context, memory, instruction, and performance skills are mapped to existing agents before adoption.    | proposed |

## Status Values

- `proposed`
- `accepted`
- `delivered`
- `deferred`

Requirement IDs are stable. Add new IDs instead of renumbering existing requirements.
