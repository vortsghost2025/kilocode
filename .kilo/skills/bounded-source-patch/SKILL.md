---
name: bounded-source-patch
description: Apply a narrowly authorized source patch while preserving file scope, behavior boundaries, and upstream hygiene.
---

# bounded-source-patch

## Activation conditions

Use only after exact writable files, intended behavior, exclusions, and validation are specified.

## Required inputs

Authorized paths, base state, required invariant, forbidden files, and focused validation commands.

## Allowed tools

Read dependencies and edit only authorized paths using repository conventions.

## Prohibited actions

Scope expansion, unrelated refactors, dependency installation, manifest changes, hidden casts, commit, or push.

## Stopping conditions

Stop when the fix requires an unauthorized file, changes an excluded invariant, or cannot be validated narrowly.

## Required evidence

Changed-file list, line-specific summary, invariant reasoning, focused test results, and final status.

## When this skill must not be used

Do not use for open-ended refactoring or when write authorization is absent.
