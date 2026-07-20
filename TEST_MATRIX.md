# Test Matrix

## Wave 1A Identity

- Commit: `d5ea7d9eb7a5cc1f76ba4abd4c6e137cd66f4eb1`
- Parent: `6961a8db884c732c766eb2bfac00616f5570606f`

## Evidence Contract

Historical Wave 1A evidence is immutable:

```text
historicalExpected:
  pass: 199
  fail: 0
```

The live regression threshold is:

```text
liveMinimum:
  pass: 199 or more
  fail: 0
```

The live matrix passes only when the failure count is exactly zero and the pass count is at least 199. Additional passing tests do not invalidate the historical milestone. Historical evidence records what was proven at Wave 1A; live regression results describe the current execution.

## Test Files

| #   | Path                                                         |
| --- | ------------------------------------------------------------ |
| 1   | `test/kilocode/capability/kernel.test.ts`                    |
| 2   | `test/kilocode/capability/lsp-installed-only.test.ts`        |
| 3   | `test/kilocode/capability/production-resolution.test.ts`     |
| 4   | `test/kilocode/capability/production-resolution-2.test.ts`   |
| 5   | `test/kilocode/capability/production-resolution-mcp.test.ts` |
| 6   | `test/kilocode/capability/enforcement.test.ts`               |
| 7   | `test/kilocode/delegated-edit.test.ts`                       |
| 8   | `test/kilocode/background-task-tool.test.ts`                 |
| 9   | `test/kilocode/foreground-task-deadlock.test.ts`             |
| 10  | `test/kilocode/subagent-interrupt-resume.test.ts`            |

Run the matrix from `packages/opencode/`. `bun run verify:wave-1a` performs this run and evaluates both evidence sections separately.

## Typecheck Baseline

Command: `cd packages/opencode && bun run typecheck`

The only accepted diagnostics are:

- `src/storage/db.node.ts(1,30)`
- `test/tool/remember.test.ts(49,32)`
- `test/tool/remember.test.ts(149,32)`

Any additional diagnostic fails the gate. The pinned formatter is Prettier `3.6.2`; no network or install fallback is permitted.
