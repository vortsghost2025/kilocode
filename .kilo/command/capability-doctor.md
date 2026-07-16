---
description: inspect project capability groundwork without enabling services
---

Perform a read-only capability review using `.kilo/capabilities/A4A.md` and only already-collected, redacted inventory supplied for this run.

This instruction-only command is not a live configuration collector, live MCP health check, process inspector, credential reader, or runtime capability broker. Report unavailable fields as unavailable rather than probing them.

Report:

- configuration sources and project/global scope;
- proposed agent/provider/model identity and credential reference names only;
- discovered project skills;
- supplied MCP server names and enabled state without discovering, starting, or connecting them;
- namespaced permission rules and proposed agent assignments;
- tool counts and estimated context cost when already available;
- active leases when a future lease registry exists;
- conflicts, global bleed, and orphan evidence;
- committed configuration paths that appear to contain direct secrets, never their values.

Rules:

- Do not start, connect, authenticate, install, enable, or modify any MCP server or plugin.
- Do not read or print auth values, environment values, headers, OAuth data, passwords, tokens, or API keys.
- Do not modify project or global configuration.
- Stop if reporting would require exposing a secret value.
- Return sections: SOURCES, ASSIGNMENTS, EXPOSURE, HEALTH, CONFLICTS, SECRET PATHS, DECISION.

$ARGUMENTS
