---
name: repo-state-verification
description: Verify worktree, branch, commit, status, remotes, and file scope before repository-sensitive work.
---

# repo-state-verification

## Activation conditions

Use before edits, commits, pushes, worktree creation, baseline comparisons, or destructive Git-adjacent operations.

## Required inputs

Expected repository path, branch, HEAD, clean/dirty state, allowed files, and remote expectations.

## Allowed tools

Read-only Git status, log, diff, rev-parse, worktree list, hashes, and remote-reference inspection.

## Prohibited actions

Checkout, reset, clean, stash, commit, push, branch mutation, or file modification unless separately authorized.

## Stopping conditions

Stop immediately when path, branch, HEAD, staging, untracked state, or remote state differs from expectations.

## Required evidence

Resolved root, branch, full HEAD, status, staged/untracked lists, hashes when requested, and remote branch state.

## When this skill must not be used

Do not use as permission to repair mismatches or alter repository state.
