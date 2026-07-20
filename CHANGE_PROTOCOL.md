# Change Protocol

## Wave Scope

Every implementation wave has one strict JSON scope manifest under `.kilo/scopes/`. The scope lists the complete approved path set. Index validation requires exact equality: no missing, extra, protected, or duplicate path may pass. Commit validation uses the recorded parent-to-commit delta, not the cumulative repository tree.

The scope manifest must include itself when it governs its own implementation. A scope cannot override `.kilo/protected-paths.json`; exact and directory-prefix protections always take precedence and cause loading to fail closed.

## Manifest Updates

1. Change only paths explicitly authorized for the wave.
2. Update the applicable scope manifest when its contract changes.
3. Recompute the SHA-256 value for every changed authoritative root document.
4. Update `system-manifest.json` with those lowercase hashes and no hash cycle.
5. Run `bun run verify:wave-1a`.
6. Under separate staging authorization, stage only the wave paths and run `bun run verify:staged-scope -- <wave-id>`.

Strict JSON is mandatory. Missing, malformed, unreadable, mismatched, duplicate, or protected entries fail closed.

## Repository Mutation Boundary

Implementation and verification do not auto-stage, commit, install, download, or push. A local commit may be created only after a separate authorization and a passing exact staged-scope gate. Push always requires separate explicit user authorization. Verification commands must leave `git status --short` unchanged.

The temporary Plan-mode artifact `.kilo/plans/1784567275991-quiet-lagoon.md` is outside `system-map-v1` and must not be staged, committed, modified, or deleted by this wave.

## Repairing The Blocklisted Mixed Commit

The commit `aadd82aaba5c71cdca3ab06173dad8adcd6b7bf9` mixed protected paths into a wave and must never be an ancestor of an accepted history. Repair is a separately authorized Git operation:

1. Identify and verify the protected good `HEAD`.
2. Use a mixed reset to that protected `HEAD` so working-tree content is preserved while the index is cleared.
3. Re-stage only the exact scope paths.
4. Run the staged-scope gate and verify ancestry and the blocklist.
5. Create one local replacement commit only after every gate passes.

Never perform this repair automatically. Never clean, restore, stash, checkout, install, push, or discard unrelated working-tree content as part of it.
