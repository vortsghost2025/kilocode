# Deterministic System Map

This is the canonical entry point for the repository capability and authority map.

## Required Preflight

Run these steps in order from the repository root:

1. `git rev-parse HEAD`
2. Read `system-manifest.json` (`cat system-manifest.json` in a shell).
3. `bun run verify:wave-1a`

No implementation work should proceed until `bun run verify:wave-1a` returns `WAVE 1A: PASS`. A nonzero exit means the repository is not in a verified Wave 1A state and must be treated as fail-closed.

## Reading Order

1. [System Index](SYSTEM_INDEX.md)
2. [System Flow](SYSTEM_FLOW.md)
3. [Agent Registry](AGENT_REGISTRY.md)
4. [Authority Model](AUTHORITY_MODEL.md)
5. [Test Matrix](TEST_MATRIX.md)
6. [Change Protocol](CHANGE_PROTOCOL.md)
7. [Machine Manifest](system-manifest.json)

Document integrity values live only in `system-manifest.json`.
