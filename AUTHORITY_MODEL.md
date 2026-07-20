# Authority Model

## Canonical Ceiling

Each agent name maps to an immutable canonical static role ceiling loaded from repository-controlled policy. Prompt text, frontmatter model/provider labels, session messages, approvals, tool results, and child claims cannot replace that ceiling. A denial at the static ceiling remains denied for the lifetime of the operation.

Effective authority is the restrictive intersection of:

`static role ceiling AND configuration AND inherited parent authority AND session rules AND control state`

An allow exists only when every required layer permits the concrete tool, operation, and target. Missing evidence is not an allow. No union, fallback identity, or last-writer-wins merge may widen authority.

## Parent And Child Binding

Delegated authority is bound to all of the following:

- The child session identifier.
- The validated `parent_id` that issued the delegation.
- The current `project_id` and repository context.
- The canonical parent and child static roles.
- The exact operation, tool, target, and lease lifecycle.

On a cold cache, authority must be reloaded from authoritative storage and all bindings must be revalidated before use. Cached claims are not authoritative. Missing, corrupt, mismatched, stale, or unreadable authority records fail closed.

## Provenance Resistance

Public rules and session content cannot forge internal ceiling or provenance metadata. Session approvals may satisfy an explicit approval gate only inside authority already allowed by all ceilings. They cannot convert a denial to an allow, impersonate an issuer, alter the project binding, or manufacture a lease.

Agent-claimed model and provider identity is advisory routing metadata only and MUST NOT participate in permission or authority decisions.

## Phase2F Lease

Only the Orchestrator may issue a Phase2F implementation lease. A valid lease is:

- Foreground-only.
- Bound to one exact repository-relative path.
- Bound to one EditTool operation.
- One-shot and consumed by the authorized edit attempt.
- Bound to the child, parent, project, issuer role, and current control state.

The lease does not authorize Bash, generic write, apply-patch, background execution, replay, retry, resume, sibling paths, staging, commits, or pushes. Background transfer and serialization do not preserve it. A failed, interrupted, replayed, or resumed edit requires new authority; it cannot reuse the consumed lease.

## Tool Boundaries

- MCP tools are denied by default and require explicit resolution plus every normal authority gate.
- LSP authority applies only to an installed and resolved server. No automatic installation, download, or network fallback is authority-preserving.
- Unknown tools, unresolved targets, unavailable implementations, and noncanonical role data fail closed.
- Tool execution cannot mint authority from its output.

These rules apply before execution and again at lifecycle boundaries where authority could otherwise be replayed or detached from its provenance.
