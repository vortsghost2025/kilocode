---
name: strict-code-review
description: Review an exact diff for demonstrated correctness, lifecycle, security, cleanup, typing, and evidence defects.
---

# strict-code-review

## Activation conditions

Use for a commit gate, high-risk diff, lifecycle change, permission boundary, or test-validity review.

## Required inputs

Exact diff range or files, expected state, review questions, known baselines, and permitted validation.

## Allowed tools

Read-only diff/source inspection and explicitly permitted focused checks.

## Prohibited actions

Edits, staging, commits, pushes, unrelated historical review, or hypothetical blocker claims without an execution path.

## Stopping conditions

Stop when repository state differs, review scope is unavailable, or required evidence cannot be accessed safely.

## Required evidence

File:line, execution path, proven defect versus risk, test coverage, reproduction design, and blocker/follow-up decision.

## When this skill must not be used

Do not use to broaden into unrelated architecture or to approve work without checking the exact diff.
