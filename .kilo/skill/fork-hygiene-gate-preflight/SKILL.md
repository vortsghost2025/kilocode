---
name: fork-hygiene-gate-preflight
description: Determine the exact validation gates this fork enforces BEFORE committing or pushing — kilocode_change annotations, source-links, knip, formatting, focused tests, typecheck, exemption rules, repo state checks, and commit/push safety. Read-only analysis plus locally-runnable verification commands.
---

# Skill: fork-hygiene-gate-preflight

# fork hygiene preflight

Determine the exact validation gates this fork enforces BEFORE committing or
pushing, so a change does not fail CI or pollute the upstream merge diff.

## Purpose

Predict, from current tracked repository sources only, which CI gates apply to a
proposed change and which commands an agent must run locally to validate the
change pre-commit. No speculative commands. No stale notes.

## When to use

- Before staging changes that touch any tracked source file under
  `packages/opencode/`, `packages/kilo-vscode/`, `packages/kilo-ui/`,
  `packages/app/`, `packages/sdk/`, `packages/ui/`, or any script the CI invokes.
- Before invoking `git commit` or `git push` on a fork branch.
- When asked to "preflight", "verify before commit", "check CI locally", or
  "validate the change".
- When the user requests evidence that a change is ready for review.

Do NOT use this skill as a license to mutate repository state. It is read-only
analysis plus locally-runnable verification commands.

## Required repository-state checks

Resolve and confirm these before running any gate. Stop on first mismatch.

1. Worktree root is the expected repository path. Confirm with
   `git rev-parse --show-toplevel`.
2. Current branch matches the user's expected branch. Confirm with
   `git branch --show-current`.
3. Starting HEAD matches the user's expected HEAD when one is provided. Confirm
   with `git rev-parse HEAD`.
4. Working tree status matches the user's expectation (clean or known-dirty).
   Confirm with `git status --short`.
5. No untracked files exist that should have been part of the change.
6. Live remote branch hash matches local HEAD after any push. Confirm with
   `git ls-remote <remote> refs/heads/<branch>` and compare the SHA to
   `git rev-parse HEAD`.

Any mismatch is a stop condition. Do not repair; surface the mismatch and stop.

## How to select focused validation

Run only the gates that correspond to the changed paths. Use the table below.
A change that touches multiple packages must run every applicable gate.

| Changed path                                                                                                                                   | Gate to run                          | Exact command                                                                         | Cited source                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Any `*.ts`/`*.tsx`/`*.js`/`*.jsx` anywhere                                                                                                     | Typecheck                            | `bun turbo typecheck` (run from repo root)                                            | `package.json` scripts.typecheck; `.github/workflows/typecheck.yml`; `turbo.json` tasks.typecheck                                        |
| `packages/opencode/**` test files                                                                                                              | Focused tests                        | `bun test test/<path>.test.ts` (run from `packages/opencode/`)                        | `packages/opencode/package.json` scripts.test; `packages/opencode/AGENTS.md`; `.github/workflows/test.yml`                               |
| `packages/opencode/**` non-kilocode shared source                                                                                              | kilocode_change annotation check     | `bun run script/check-opencode-annotations.ts --base <base-ref>` (run from repo root) | `script/check-opencode-annotations.ts`; `.github/workflows/check-opencode-annotations.yml`; `AGENTS.md`                                  |
| `packages/kilo-vscode/**`, `packages/kilo-ui/**`                                                                                               | kilocode_change marker absence check | `bun run check-kilocode-change` (run from `packages/kilo-vscode/`)                    | `packages/kilo-vscode/package.json` scripts.check-kilocode-change; `.github/workflows/test-vscode.yml`; `packages/kilo-vscode/AGENTS.md` |
| `packages/kilo-vscode/**`                                                                                                                      | ESLint                               | `bun run lint` (run from `packages/kilo-vscode/`)                                     | `packages/kilo-vscode/package.json` scripts.lint; `.github/workflows/test-vscode.yml`                                                    |
| `packages/kilo-vscode/**`                                                                                                                      | Prettier check                       | `bun run format:check` (run from `packages/kilo-vscode/`)                             | `packages/kilo-vscode/package.json` scripts.format:check; `.github/workflows/test-vscode.yml`                                            |
| `packages/kilo-vscode/**`                                                                                                                      | Knip (unused-code)                   | `bun run knip` (run from `packages/kilo-vscode/`)                                     | `packages/kilo-vscode/package.json` scripts.knip; `.github/workflows/test-vscode.yml`; `AGENTS.md`                                       |
| `packages/kilo-vscode/**`                                                                                                                      | Unit tests                           | `bun run test:unit` (run from `packages/kilo-vscode/`)                                | `packages/kilo-vscode/package.json` scripts.test:unit; `.github/workflows/test-vscode.yml`                                               |
| `packages/kilo-vscode/{src,webview-ui}/**`, `packages/opencode/src/**`, `packages/kilo-docs/source-links.md`, `script/extract-source-links.ts` | Source-link freshness                | `bun run script/extract-source-links.ts --check` (run from repo root)                 | `script/extract-source-links.ts`; `.github/workflows/source-check-links.yml`; `AGENTS.md`                                                |

Notes:

- The root `bun test` command is intentionally blocked (`package.json`
  scripts.test prints "do not run tests from root" and exits 1). Always run
  tests from the specific package directory.
- `packages/opencode` tests: run from `packages/opencode/`, never from root.
  Single file: `bun test test/<path>.test.ts` (see `packages/opencode/AGENTS.md`
  and `packages/opencode/package.json` scripts.test = `bun test --timeout 30000`).
- `turbo test` (`.github/workflows/test.yml`) is the CI test entry; local
  preflight normally uses the focused single-file form to stay fast.
- The annotation checker diffs against `origin/main` by default; on a fork
  branch with no `origin/main`, pass `--base <ref>` with a real reachable ref
  (typically `upstream/main` or the stored base SHA provided by the user).

## Verified CI gates and exact commands

The CI gates enforced on pull requests and on pushes to `main` are exactly
those below. Every command is sourced from a tracked file; no command here is
invented.

### 1. kilocode_change annotation requirement (shared `packages/opencode/**`)

Trigger: a pull request modifies any path under `packages/opencode/**` (see
`.github/workflows/check-opencode-annotations.yml` path filter). Also runs on
the matching workflow file or `script/check-opencode-annotations.ts`.

Rule: every Kilo-specific added line in a shared `packages/opencode/` source
file (`.ts`, `.tsx`, `.js`, `.jsx`) must be covered by a `kilocode_change`
marker in one of these forms (from `script/check-opencode-annotations.ts`):

- Inline: `// kilocode_change` (or `{/* kilocode_change */}` in JSX).
- Block: `// kilocode_change start` ... `// kilocode_change end`
  (or the JSX `{/* kilocode_change start */}` form).
- Whole file: first non-empty line is `// kilocode_change - new file`.

Local command (from repo root):
`bun run script/check-opencode-annotations.ts --base <base-ref>`

The script auto-skips when it detects an upstream opencode merge commit
(subject starting with `merge: upstream ` or `resolve merge conflict`), and
auto-passes when no shared opencode source files changed.

### 2. Source-link freshness

Trigger: a pull request modifies any of
`packages/kilo-vscode/src/**`, `packages/kilo-vscode/webview-ui/**`,
`packages/opencode/src/**`, `packages/kilo-docs/source-links.md`, or
`script/extract-source-links.ts` (see
`.github/workflows/source-check-links.yml` path filter).

Rule: `packages/kilo-docs/source-links.md` must be in sync with the URLs
embedded in the listed source trees. The workflow gates with `--check`.

Local command (from repo root):
`bun run script/extract-source-links.ts --check`

To repair (only when explicitly authorized to modify code):
`bun run script/extract-source-links.ts` (no `--check`).

### 3. knip (unused-code) for `packages/kilo-vscode/`

Trigger: any change under `packages/kilo-vscode/**`, `packages/ui/**`, or
`packages/kilo-ui/**` (see `.github/workflows/test-vscode.yml` path filter).

Rule: every exported type/function in `packages/kilo-vscode/` must be imported
somewhere. CI fails on unused exports. Remove or unexport the offending symbol
rather than widening knip config.

Local command (from `packages/kilo-vscode/`):
`bun run knip`

### 4. Formatting (Prettier) for `packages/kilo-vscode/`

Trigger: same path filter as knip.

Rule: Prettier check (`--check`) passes. `.prettierignore` in
`packages/kilo-vscode/` excludes `node_modules`, `dist`, `out`, and `*.md`; the
root `.prettierignore` excludes `packages/desktop/src/bindings.ts`. Markdown
tables in docs are excluded from Prettier specifically to avoid spurious
padding diffs (see `packages/kilo-vscode/AGENTS.md`).

Local command (from `packages/kilo-vscode/`):
`bun run format:check` (verify) or `bun run format` (repair, only when
authorized to modify code).

### 5. ESLint for `packages/kilo-vscode/`

Trigger: same path filter as knip.

Local command (from `packages/kilo-vscode/`):
`bun run lint` (lints `src` and `webview-ui`).

### 6. Unit tests

For `packages/kilo-vscode/` (triggered by changes under
`packages/kilo-vscode/**`, `packages/ui/**`, or `packages/kilo-ui/**`):
`bun run test:unit` (from `packages/kilo-vscode/`; runs `bun test tests/unit/`).

For `packages/opencode/` (triggered by changes anywhere via `bun turbo test` in
CI): use the focused form `bun test test/<path>.test.ts` from
`packages/opencode/`. Do not run from repo root (blocked by
`package.json` scripts.test).

### 7. Typecheck

Monorepo-wide typecheck is run in CI as `bun typecheck`
(`.github/workflows/typecheck.yml`), which resolves via the root
`package.json` to `bun turbo typecheck`. Each package's `typecheck` script uses
`tsgo --noEmit` (or `tsgo -b` for `packages/app/`, `packages/desktop/`,
`packages/desktop-electron/`). The Kilo VS Code package runs its own multi-step
typecheck (`bun run check-types:extension && bun run check-types:webview`).

Local command (from repo root): `bun turbo typecheck`.
Per-package (faster, focused): run the package's own `typecheck` script from
its directory.

## Exemptions and limits

`kilocode_change` markers are NOT required (per
`script/check-opencode-annotations.ts` `isExempt` and `AGENTS.md`):

- `packages/opencode/src/kilocode/**`
- `packages/opencode/test/kilocode/**`
- Any path containing `kilocode` in any directory or file name component
  (case-insensitive).
- Any path with a directory that starts with `kilo-` (for example `kilo-sessions/`).

`kilocode_change` markers MUST NOT appear in:

- `packages/kilo-vscode/**` (entirely Kilo additions; the
  `check-kilocode-change` script fails if any marker is present there outside
  of `package.json` and `*.md`).
- `packages/kilo-ui/**` (same reason).

The `check-kilocode-change` script (in `packages/kilo-vscode/package.json`)
excludes `package.json`, `*.md`, `node_modules`, and `dist` from its grep, so
markers in those files are tolerated; anywhere else is a CI failure.

Limits:

- This skill covers pre-commit gates only. It does not cover release, docs
  site build, Storybook, visual regression, container, Nix, triage, or
  PR-management workflows.
- The annotation checker and source-link checker are skipped automatically on
  upstream opencode merges (annotation checker prints "Skipping opencode
  annotation check — upstream opencode merge detected." and exits 0).

## Commit and push safety

Before `git commit`:

1. Re-run every applicable gate from the selection table above.
2. For `packages/kilo-vscode/` changes, also run `bun run format` (not just
   `format:check`) before staging so commits do not contain styling-only diffs
   (see `packages/kilo-vscode/AGENTS.md` "Committing" section). Then re-stage
   and re-run `format:check`.
3. Confirm `git status --short` shows only the intended files staged.
4. Confirm no `kilocode_change` marker leaked into `packages/kilo-vscode/` or
   `packages/kilo-ui/`.

Before `git push <remote> <branch>`:

1. Confirm branch and remote match the user's expectation.
2. After a successful push, run
   `git ls-remote <remote> refs/heads/<branch>` and compare the reported SHA
   to local `git rev-parse HEAD`. They must match exactly. This is the
   canonical evidence that the push landed.

Never amend or force-push unless the user explicitly authorizes it. Never
mutate `main`. The expected `main` HEAD is whatever the user provided; if the
user did not provide one, do not assume.

Commit message style (from `AGENTS.md`): Conventional Commits, with scope
matching the package: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`
followed by `(<scope>):` where scope is one of `vscode`, `cli`,
`agent-manager`, `sdk`, `ui`, `i18n`, `kilo-docs`, `gateway`, `telemetry`,
`desktop`. Omit scope when the change spans multiple packages.

## Required final evidence format

Before reporting "ready to commit/push", produce this evidence block. Every
line is required; replace each placeholder with the actual observed value.

```
PREFLIGHT:
REPOSITORY ROOT: <git rev-parse --show-toplevel>
BRANCH: <git branch --show-current>
HEAD: <git rev-parse HEAD>
STATUS: <git status --short output, or "clean">
GATES RUN:
  - <gate name>: <PASS|FAIL> (<command run>)
  ...
MARKER AUDIT:
  - SHARED OPENCODE CHANGES: <count> files; <covered|uncovered> by markers
  - KILO-VSCODE/KILO-UI MARKER LEAK: <none|list>
KNIP: <PASS|FAIL|N/A>
FORMAT:CHECK: <PASS|FAIL|N/A>
LINT: <PASS|FAIL|N/A>
TYPECHECK: <PASS|FAIL|N/A>
FOCUSED TESTS: <PASS|FAIL|N/A> (<files run>)
SOURCE-LINKS: <PASS|FAIL|N/A>
REMOTE HASH: <sha from git ls-remote, or "not pushed">
LOCAL HEAD: <git rev-parse HEAD>
REMOTE HASH MATCH: <yes|no|not pushed>
VERDICT: <READY TO COMMIT|READY TO PUSH|BLOCKED - <reason>>
```

## Stop conditions

Stop immediately, surface the condition, and do not proceed if:

- The worktree root, branch, or HEAD differs from the user's expectation.
- `git status --short` shows files the user did not mention (unexpected
  untracked or modified files).
- Any gate returns FAIL. Do not auto-repair; report the failing gate and the
  exact command output.
- A push was requested and `git ls-remote` cannot resolve the remote branch, or
  the remote hash differs from local HEAD after push.
- The user has not authorized the specific commit or push action.
- A required command's cited source has been removed or renamed in the tracked
  repository (re-audit before retrying; do not substitute an invented
  command).

## Out of scope

- Writing or modifying any source file (this skill is read-only analysis plus
  locally-runnable verification commands).
- Repairing gates that fail. Repair requires a separate, separately-authorized
  code change.
- Estimating PR merge time, reviewer availability, or CI queue depth.
- Anything outside the fork-hygiene gate set listed above.
