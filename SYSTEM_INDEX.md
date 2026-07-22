# System Index

## Map Version 1

The following files are authoritative for this map. Integrity values are stored only in `system-manifest.json`; this document does not reproduce them.

| Name                     | Relative path                          | Role                                                                      | Representation   |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------- | ---------------- |
| Start Here               | `START_HERE.md`                        | Canonical entry point and required preflight                              | Human-readable   |
| System Index             | `SYSTEM_INDEX.md`                      | Inventory of map authorities                                              | Human-readable   |
| System Flow              | `SYSTEM_FLOW.md`                       | Runtime request and authority flow                                        | Human-readable   |
| Agent Registry           | `AGENT_REGISTRY.md`                    | Static agent roles and delegation boundaries                              | Human-readable   |
| Authority Model          | `AUTHORITY_MODEL.md`                   | Restrictive authority semantics and failure rules                         | Human-readable   |
| Test Matrix              | `TEST_MATRIX.md`                       | Historical evidence and live regression thresholds                        | Human-readable   |
| Change Protocol          | `CHANGE_PROTOCOL.md`                   | Scope, integrity, and repository mutation rules                           | Human-readable   |
| System Manifest          | `system-manifest.json`                 | Map version, document hashes, scope index, and pinned validation metadata | Machine-readable |
| Wave 1A Scope            | `.kilo/scopes/wave-1a.json`            | Historical Wave 1A commit delta and validation contract                   | Machine-readable |
| System Map V1 Scope      | `.kilo/scopes/system-map-v1.json`      | Exact path set for this map implementation                                | Machine-readable |
| Capability Bundles Scope | `.kilo/scopes/capability-bundles.json` | Capability bundle progressive-disclosure path set for Phase 2C            | Machine-readable |
| Protected Paths          | `.kilo/protected-paths.json`           | Exact and prefix protections that override every scope                    | Machine-readable |

The JSON files are strict JSON: comments, trailing commas, malformed fields, and unknown schema fields fail validation.
