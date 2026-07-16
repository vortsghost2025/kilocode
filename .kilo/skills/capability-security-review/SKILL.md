---
name: capability-security-review
description: Assess manifests, skills, MCPs, plugins, credentials, leases, and global bleed before capability enablement.
---

# capability-security-review

## Activation conditions

Use before enabling any external tool, MCP server, plugin, credential reference, write grant, or lease mechanism.

## Required inputs

Manifest, config provenance, tool list, scope, risk class, credential references, process model, and cleanup design.

## Allowed tools

Read-only schema/config inspection, redacted health metadata, and secret-path reporting without values.

## Prohibited actions

Starting services, authentication, OAuth, reading secret values, global config changes, or granting capabilities.

## Stopping conditions

Stop on committed secrets, unknown provenance, excessive scope, missing timeout/cleanup, or unresolved global bleed.

## Required evidence

Risk class, source scope, grants/denials, tool/context count, health, conflicts, secret paths, and enable/deny decision.

## When this skill must not be used

Do not use after enablement as a substitute for runtime enforcement or audit logs.
