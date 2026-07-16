---
name: focused-test-validation
description: Select and run the smallest tests that directly validate changed behavior and classify unrelated failures.
---

# focused-test-validation

## Activation conditions

Use after a bounded implementation or when a specific regression requires deterministic validation.

## Required inputs

Changed files, required commands, pinned runtime if any, expected counts, and known baseline failures.

## Allowed tools

Focused tests, diff checks, narrowly relevant static checks, and read-only failure comparison.

## Prohibited actions

Full-suite execution without authorization, changing tests to hide failures, package installation, or baseline repair.

## Stopping conditions

Stop on a changed-file error, unexpected runner version, unauthorized test discovery, or ambiguous baseline classification.

## Required evidence

Exact command, runtime banner, pass/fail/expectation counts, error paths, and baseline proof.

## When this skill must not be used

Do not use to claim end-to-end coverage from a unit or synthetic boundary test.
