---
name: baseline-failure-classification
description: Prove whether a validation failure predates the current change without repairing unrelated source.
---

# baseline-failure-classification

## Activation conditions

Use when focused or hook validation reports errors outside authorized files.

## Required inputs

Current error output, base commit or clean checkout, changed-file list, and permitted read-only comparison.

## Allowed tools

Read-only diff, source comparison, and narrowly authorized baseline validation.

## Prohibited actions

Editing baseline files, relabeling unproven errors, rerunning forbidden suites, or suppressing failures.

## Stopping conditions

Stop when the same error cannot be reproduced or proven unchanged at the base.

## Required evidence

Exact error, current path, base path/output, unchanged configuration proof, and final classification.

## When this skill must not be used

Do not use when an error references a changed file; treat that as introduced until disproven.
