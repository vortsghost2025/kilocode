---
name: orchestrator-delegation
description: Plan bounded delegation across distinct specialists with explicit ownership, capability limits, and completion evidence.
---

# orchestrator-delegation

## Activation conditions

Use before non-trivial delegation, parallel specialist work, or creating a child task.

## Required inputs

Goal, target agent identity, source roots, allowed actions, timeout, and expected evidence.

## Allowed tools

Read-only repository inspection, task delegation when authorized, and status/result/cancel controls.

## Prohibited actions

Implicit parent capability inheritance, duplicate agent types in one batch, credential sharing, unbounded nesting, commit, or push.

## Stopping conditions

Stop when no bounded owner exists, required capability is denied, the lease expires, or task ownership is ambiguous.

## Required evidence

Delegation owner, child task/session ID, manifest reference, granted categories, timeout, and final result or cancellation state.

## When this skill must not be used

Do not use for a trivial direct action or to bypass a tool or permission denial.
