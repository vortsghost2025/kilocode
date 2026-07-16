---
name: evidence-handoff
description: Produce a bounded continuation record with verified state, claims, limitations, and next safe action.
---

# evidence-handoff

## Activation conditions

Use at phase boundaries, before context transfer, or after validated work that remains uncommitted or unpushed.

## Required inputs

Repository state, exact outputs, decisions, changed files, excluded claims, and remaining authorization.

## Allowed tools

Read-only state verification and concise documentation of already observed evidence.

## Prohibited actions

Invented results, secret values, unverified success claims, new edits, commit, or push.

## Stopping conditions

Stop when critical state cannot be verified or would expose credentials.

## Required evidence

Path, branch, full HEAD, status, hashes when relevant, tests, failures, claims, limits, and next action.

## When this skill must not be used

Do not use as a substitute for validation or as authorization for the next phase.
