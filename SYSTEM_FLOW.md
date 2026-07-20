# System Flow

Runtime requests pass through the following ordered authority flow:

`user request -> agent role/static ceiling -> configuration narrowing -> inherited parent authority -> session/control narrowing -> tool resolution -> permission gate -> tool execution -> result`

| Stage                      | Operation                                                                           | Boundary                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| User request               | Parse the requested action without treating request text as authority.              | Fail closed when the action or target is ambiguous.                                 |
| Agent role/static ceiling  | Load the immutable canonical policy for the selected role.                          | Restrictive intersection; no later layer can reopen a denial.                       |
| Configuration narrowing    | Apply repository and runtime configuration only as a reduction of the role ceiling. | Restrictive intersection; configuration cannot widen authority.                     |
| Inherited parent authority | Bind child authority to the validated parent and project.                           | Restrictive intersection and fail closed on missing or mismatched provenance.       |
| Session/control narrowing  | Apply session rules, approvals, control state, and active leases.                   | Restrictive intersection; approval cannot forge or replace a static allow.          |
| Tool resolution            | Resolve only tools permitted by every preceding layer.                              | Fail closed for unknown, unavailable, MCP-default-denied, or uninstalled LSP tools. |
| Permission gate            | Evaluate the concrete tool, operation, target, and lease state.                     | Restrictive intersection; any denial wins.                                          |
| Tool execution             | Execute only the exact authorized operation and consume one-shot authority.         | Fail closed on path, tool, foreground, replay, or lifecycle mismatch.               |
| Result                     | Return output and evidence without increasing authority.                            | Results never become authority for a later request.                                 |

Every restrictive stage computes an intersection, never a union. Every unresolved authority input is a denial. See [Authority Model](AUTHORITY_MODEL.md) for the formal rules.
