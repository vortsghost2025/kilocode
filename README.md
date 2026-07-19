<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=kilocode.Kilo-Code"><img src="https://raster.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace" height="20"></a>
  <a href="https://x.com/kilocode"><img src="https://raster.shields.io/badge/kilocode-000000?style=flat&logo=x&logoColor=white" alt="X (Twitter)" height="20"></a>
  <a href="https://blog.kilo.ai"><img src="https://raster.shields.io/badge/Blog-555?style=flat&logo=substack&logoColor=white" alt="Substack Blog" height="20"></a>
  <a href="https://kilo.ai/discord"><img src="https://raster.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Discord" height="20"></a>
  <a href="https://www.reddit.com/r/kilocode/"><img src="https://raster.shields.io/badge/Join%20r%2Fkilocode-D84315?style=flat&logo=reddit&logoColor=white" alt="Reddit" height="20"></a>
</p>

# Kilo Code — Sean's Agent Runtime Fork

> This repository is a customized fork of [Kilo Code](https://github.com/Kilo-Org/kilocode), itself a fork of [OpenCode](https://github.com/anomalyco/opencode). The original upstream projects are the foundation — this fork adds reliable, auditable multi-agent orchestration with strict role boundaries and evidence-based validation.

## Purpose

The fork focuses on making multi-agent software development more predictable and verifiable. It provides:

- Deterministic delegation from a primary orchestrator to specialized subagents
- Strict read-only enforcement for review and analysis roles
- Foreground and background task lifecycle management with ownership-safe cancellation
- Capability isolation with allow-list enforcement at every boundary
- Persistent project memory with prompt-injection hardening
- A library of composable skills for standard development workflows

## What This Fork Adds

### Planning-First Orchestration

A dedicated Orchestrator primary agent coordinates complex work by delegating to specialized subagents. Leading `@agent` mentions route deterministically through the task tool, preserving the full delegated prompt. The orchestrator handles failure fallback and produces structured evidence handoffs between stages. Each subagent has role-specific model and permission policies — read-only agents cannot edit files, implementation agents receive explicitly scoped permissions appropriate to their assigned role, and the orchestrator itself cannot use tools that bypass delegation.

### Custom Agent Team

| Agent                                 | Role                                                                |
| ------------------------------------- | ------------------------------------------------------------------- |
| **Orchestrator**                      | Primary coordinator — delegates, tracks progress, collects results  |
| **Reviewer**                          | Read-only code review of diffs, commits, tests, and regression risk |
| **Repository Architecture Explainer** | Read-only codebase exploration and architectural analysis           |
| **Command Check**                     | Read-only command/output runner for verification tasks              |
| **Failing Test Triage**               | Read-only test failure diagnosis                                    |
| **Git Operations**                    | Safe git workflow specialist for branch management                  |
| **Phase 2F Implementer**              | Scoped implementation agent supervised by the orchestrator          |
| **Freeprobe**                         | Temporary test agent for evaluating model/tool behavior             |
| **Translator**                        | Translation agent (migrated from upstream `.opencode/` location)    |

### Foreground and Background Task Runtime

Subagent sessions run under a managed lifecycle:

- **Foreground child lifecycle** — ownership-tracked sessions with reactive interruption. The currently proven operational workflow uses one foreground subagent sequentially per delegation step.
- **Background task registry** — task control tracks `prepared`, `starting`, `running`, `completed`, `failed`, and `cancelled` execution states; the public background-task view exposes `queued`, `running`, `completed`, `failed`, and `cancelled` statuses. Tasks are tracked by handle for exact lifecycle control.
- **Exact start acknowledgement** — a background task is not reported as running until the child process confirms readiness.
- **Completion tracking** — results and errors are captured per task handle.
- **Ownership-safe cancellation** — task handles and ownership claims prevent unrelated sessions from controlling another task.
- **Interrupt queue, gate, resume, and cleanup** — foreground subagents can be interrupted, queued, and resumed through a deterministic state machine.
- **Provider-failure cleanup** — tasks that fail due to upstream provider errors are cleaned up without leaking child sessions.
- **Duplicate-dispatch protection** — the same agent cannot be dispatched to the same task in parallel.

### Capability and Permission Enforcement

Every agent action is scoped by a capability system:

- **Capability manifests, loader, and registry** — capabilities are declared in manifests, loaded from the project, and registered before use.
- **Role-scoped skill policies** — each agent role has an allow-list of skills it may invoke.
- **Production tool-resolution boundaries** — tools are resolved against the active capability set before execution.
- **Nested batch enforcement** — batch tool operations respect individual capability boundaries per sub-operation.
- **MCP allow-list enforcement** — only explicitly permitted MCP servers can be initialized. Client initialization is serialized to prevent races and properly cleaned up on interruption.
- **Fail-closed behavior** — if capability resolution fails, the operation is denied; there is no default-allow fallback.

### Persistent Memory and MCP Isolation

- **Durable project memory** — key-value storage with recall and remember commands (`/remember`, `/recall`) and corresponding tools (`kilo_local_remember`, `kilo_local_recall`). Data persists across sessions in filesystem-based JSON storage.
- **Prompt-injection hardening** — memory content is sanitized on both read and write to prevent injection into agent prompts.
- **MCP isolation** — runtime configuration can enable Context7 (remote) and persistent memory (local `@modelcontextprotocol/server-memory`) MCP services. These are activated through external profile configuration, not committed source. A `kilo mcp doctor` command provides redacted diagnostics without leaking connection details.

### Skills and Commands

A library of composable skills covers standard development workflows:

- **Fork hygiene preflight** — validates kilocode_change annotations, source links, formatting, and upstream compatibility before committing.
- **OpenCode patterns** — reference for the eight key TypeScript patterns used throughout the codebase.
- **Testing** — focused test selection, bun test patterns, fixture setup, and sanitization-test conventions.
- **Debugging** — reproduce, read stack bottom-up, bisect, confirm before fixing.
- **Filesystem safety** — safe file operations in this source build.
- **Code review** — checklist covering security, correctness, tests, upstream hygiene.
- **Repository-state verification** — worktree, branch, commit, status, remotes verification.
- **Provider/model routing** — provider and model selection without exposing secret values.
- **Capability security review** — assess manifests, skills, MCPs, plugins, and credentials before capability enablement.
- **Baseline-failure classification** — prove whether a validation failure predates the current change without repairing unrelated source.

Custom commands: `/remember` (store project facts), `/recall` (search past sessions), `/capability-doctor` (diagnose capability system state).

### Review and Validation

The `/review` command routes through the read-only Reviewer subagent for structured diff and commit review. Focused test selection identifies the smallest tests that directly validate changed behavior. Baseline-failure classification separates pre-existing failures from regressions introduced by current changes. New fork-specific changes in shared upstream paths are required to use `kilocode_change` markers for review and merge tracking. Local and remote Git hashes are verified after pushes, and push safeguards prevent accidental pushes to `main`.

### Prompt Cache Visibility

The TUI sidebar displays prompt-cache metrics for the latest completed assistant response:

- **Cache-read tokens** — tokens served from the provider's cache
- **Cache-write tokens** — tokens written to the provider's cache
- **Cached-input share** — proportion of the current prompt served from cache
- **Estimated cache-read savings** — approximate cost reduction from cached reads

These metrics use provider-published pricing tables to estimate savings. The display is accessible via sidebar labels and is hidden when no cache activity is present. The formatting logic is tested in isolation with focused pure tests.

## Current Development Status

**Development branch:** `sean/subagent-runtime-a6d1`

- The `main` branch remains at the upstream fork point and is intentionally unchanged by this work.
- All customizations are developed and validated on the dedicated development branch.
- Some capability specifications exist as design documents only and are not yet runtime-enabled.
- The background task runtime supports the current delegation model; unrestricted parallel execution across multiple foreground subagents is not yet the operational default.

## Safety and Development Policy

This fork follows an EDIT → TEST → COMMIT → PUSH DEVELOPMENT BRANCH → VERIFY REMOTE HASH cycle:

- All changes are pushed to the development branch, never to `main`.
- Force pushes are never used.
- No secrets, credentials, or personal paths are committed.
- Read-only agents are enforcement-gated to remain read-only at the permission level.
- Runtime MCP services require explicit external configuration — they are not activated by committed source alone.

## Quick Links

- [VS Code Marketplace](https://kilo.ai/vscode-marketplace?utm_source=Readme)
- Install CLI: `npm install -g @kilocode/cli`
- [Official Kilo.ai Home page](https://kilo.ai)

## Get Started with the CLI

```bash
# npm
npm install -g @kilocode/cli

# Or run directly with npx
npx @kilocode/cli
```

Then run `kilo` in any project directory to start.

<!-- kilocode_change start -->

### npm Install Note: Hidden `.kilo` File

On some systems and npm versions, installing `@kilocode/cli` can create a hidden `.kilo` file near the installed `kilo` command (for example in a global npm bin directory). This file is an npm-generated launcher helper, not project data.

- Why it exists: npm may create helper artifacts while wiring CLI executables.
- Size caveat: size can vary by platform, npm version, and install mode (symlink vs copied launcher), so a strict fixed size is not guaranteed.
- Safety: it is safe to leave in place. Do not edit it manually. Use your package manager's uninstall (`npm uninstall -g @kilocode/cli`) to remove install artifacts cleanly.

<!-- kilocode_change end -->

### Install from GitHub Releases (Optional)

Download the latest binary or source code from the [Releases page](https://github.com/Kilo-Org/kilocode/releases), use this quick guide:

- `kilo-<os>-<arch>.zip` is the CLI binary for your OS and CPU architecture on Windows and macOS. (`kilo-linux-<arch>.tar.gz` for Linux)
- `darwin` means macOS.
- `x64` is standard 64-bit Intel/AMD CPUs.
- `x64-baseline` is a compatibility build for older x64 CPUs(do not support AVX Instruction).
- `arm64` is ARM-based Linux/MacOS.
- `musl` is statically linked Linux build for Alpine/minimal Docker without glibc. Alpine/minimal Docker users should prefer the matching \*-musl asset.
- `kilo-vscode-*.vsix` is the VS Code extension package and not the CLI binary.
- `Source code` releases are for building from source, not normal installation.

For most users:

- **Windows (most PCs):** `kilo-windows-x64.zip`
- **macOS Apple Silicon:** `kilo-darwin-arm64.zip`
- **macOS Intel:** `kilo-darwin-x64.zip`
- **Linux x64:** `kilo-linux-x64.tar.gz`
- **Linux on ARM:** `kilo-linux-arm64.tar.gz`

### Autonomous Mode (CI/CD)

Use the `--auto` flag with `kilo run` to enable fully autonomous operation without user interaction. This is ideal for CI/CD pipelines and automated workflows:

```bash
kilo run --auto "run tests and fix any failures"
```

**Important:** The `--auto` flag disables all permission prompts and allows the agent to execute any action without confirmation. Only use this in trusted environments like CI/CD pipelines.

## Upstream Attribution

Kilo Code is a fork of [OpenCode](https://github.com/anomalyco/opencode), enhanced to work within the Kilo agentic engineering platform. This fork builds on both projects. All original license terms apply.

## Contributing

We welcome contributions from developers, writers, and enthusiasts!
To get started, please read our [Contributing Guide](/CONTRIBUTING.md). It includes details on setting up your environment, coding standards, types of contribution and how to submit pull requests.

See [RELEASING.md](RELEASING.md) for the release process.

## Code of Conduct

Our community is built on respect, inclusivity, and collaboration. Please review our [Code of Conduct](/CODE_OF_CONDUCT.md) to understand the expectations for all contributors and community members.

## License

This project is licensed under the MIT License.
You are free to use, modify, and distribute this code, including for commercial purposes as long as you include proper attribution and license notices. See [License](/LICENSE).
