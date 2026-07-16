# A4A Capability Groundwork

Status: design and read-only scaffolding only. No MCP server, plugin package, credential, lease enforcement, or global configuration is enabled by this work.

## Source inventory

| Concern | Current source | Runtime behavior | Capability gap |
| --- | --- | --- | --- |
| Agent definitions | `packages/opencode/src/agent/agent.ts:30-55, 75-137, 257-290` | Native and configured agents resolve model, prompt, options, and permission rules. | No manifest binding skills, MCP servers, plugins, roots, network, or credential references to an agent. |
| Foreground delegation | `packages/opencode/src/tool/task.ts:43-83, 106-180, 210-241` | Filters targets, creates a child, inherits edit/bash/MCP restrictions, selects a model, and starts the prompt. | Inheritance is category-specific and implicit; no lease or revocation record. |
| Background delegation | `src/kilocode/background-task-tool.ts:185-263`; `background-subagent-start.ts:10-19`; `subagent-spawn.ts:31-82` | Creates an owned child with model, permissions, and tool overrides under background task ownership. | No capability snapshot or context budget attached to the task. |
| Session ownership | `packages/opencode/src/session/index.ts:382-408, 446-490`; `src/kilocode/background-subagent-control.ts:19-58` | Child sessions store `parentID` and permissions; background handles verify parent ownership. | Sessions do not identify the manifest or lease that created them. |
| Provider/model identity | `src/agent/agent.ts:41-46, 363-369`; `src/tool/task.ts:171-180`; `background-task-tool.ts:213-255` | Agent model wins, otherwise the parent message model is inherited. | Credential identity is resolved later and not independently bound to the child decision. |
| Credentials/environment | `src/auth/index.ts:11-37, 59-91`; `provider/provider.ts`; `config/config.ts:1429-1496, 1621-1643` | Secrets live in global auth data, provider config, environment, well-known config, or account config. | No opaque per-agent credential reference or denial of parent credential inheritance. |
| Built-in tools | `src/tool/registry.ts:118-150, 168-205`; `src/session/prompt.ts:850-932` | Registry assembles built-ins/plugin tools and initializes them for the selected agent. | Most tools remain visible until execution permissions deny them. |
| Permission evaluation | `src/permission/index.ts:155-237`; `src/session/prompt.ts:877-883, 957-964` | Agent/session rules merge; deny rejects, ask waits, allow executes. | Permission is an execution gate, not a discovery filter or lease. |
| Skill discovery/loading | `src/skill/index.ts:23-31, 142-199, 220-240`; `src/tool/skill.ts:9-56, 77-121` | Scans global/project roots including `.kilo/{skill,skills}` and filters by `skill` permission. | No explicit source allowlist or per-agent context budget. |
| MCP configuration | `src/config/config.ts:498-559, 1076-1089`; `src/config/paths.ts:22-43` | Local/remote definitions merge through global, project, environment, account, and managed layers. | Project entries do not replace the global MCP map; global bleed must be diagnosed and denied by name. |
| MCP startup/discovery | `src/mcp/index.ts:280-460, 503-560, 634-667` | Starts STDIO or HTTP/SSE clients, applies timeouts, discovers tools, and namespaces them. | Connected clients contribute tools instance-wide; no per-agent discovery filter. |
| MCP permissions | `src/session/prompt.ts:934-975` | Every MCP tool receives plugin hooks and a namespaced permission check. | Denied tools still consume discovery/context unless filtered earlier. |
| MCP shutdown | `src/mcp/index.ts:540-560, 567-632` | Finalizers close clients and attempt descendant termination; disconnect closes one client. | No task lease, startup owner, revocation deadline, or orphan audit record. |
| Plugin boot | `src/plugin/index.ts:226-317`; `src/project/bootstrap.ts:16-24` | Internal/external plugins load at instance bootstrap and can alter config, tools, events, and hooks. | Plugins are trusted instance-wide code, not safely leaseable per agent. |
| Config precedence | `src/config/config.ts:1379-1660`; `src/config/paths.ts:11-43` | Legacy/org, global, custom, project, directories, inline env, account, and managed layers merge. | Effective config lacks sufficient retained provenance for a doctor. |
| Cancellation/cleanup | `src/session/prompt.ts:73-92, 256-298`; `src/tool/task.ts:188-258`; `background-task-runtime.ts:10-68` | Abort controllers, foreground handles, task claims, and finalizers terminate work. | Revocation is not coupled to completion, cancel, timeout, or shutdown. |
| Parent inheritance | `src/tool/task.ts:106-165`; `background-task-tool.ts:203-250` | Edit, bash, and configured MCP restrictions inherit from parent agent/session rules. | Skills, plugins, roots, network, credentials, and budgets do not inherit restrictively. |
| Per-agent visibility | `src/tool/registry.ts:168-205`; `src/skill/index.ts:235-240`; `src/session/prompt.ts:887-975` | Skills filter by agent permission; built-ins/MCP definitions are otherwise broadly assembled. | A broker must filter before descriptions enter model context. |

## Current-versus-upstream comparison

The local `origin/main` inspected during A4A was `0ab18c2bd49b98f476931d326b28afa1c2a8bf87`. The current branch differs in all primary capability seams and adds Kilo background task/ownership modules absent or materially different upstream. No merge was performed. Future implementation should stay under `src/kilocode/capability/` with narrow adapters into shared seams.

## Capability flow

```text
orchestrator identity
  -> task/background_task delegation request
  -> target agent lookup and task permission
  -> capability manifest selection
  -> restrictive parent intersection
  -> opaque provider/model/credential reference selection
  -> bounded capability lease creation
  -> child session with parentID + permission snapshot + lease ID
  -> pre-context skill allow/deny filtering
  -> pre-context MCP server/tool filtering
  -> built-in tool visibility filtering
  -> execution-time permission evaluation
  -> tool execution and audit event
  -> completion/cancel/error/timeout
  -> lease revocation
  -> MCP/task/process cleanup and orphan check
```

Current code implements agent lookup, child ownership, model selection, partial permission inheritance, execution gates, cancellation, and instance cleanup. Manifest selection, complete restrictive intersection, lease records, pre-context MCP filtering, and revocation auditing remain future work.

## Manifest schema

The executable draft is `packages/opencode/src/kilocode/capability/manifest.ts`. Version 1 requires:

- agent ID and orchestrator/subagent role;
- provider ID, model ID, and a reference-shaped credential locator: `env:VARIABLE_NAME` or a bounded lowercase conventional `auth:`, `account:`, or `profile:` identifier;
- risk and read/write/admin classification;
- skill, MCP server/tool, and plugin allow/deny sets;
- per-built-in allow/ask/deny rules;
- read and write roots;
- shell, Git, and network boundaries;
- context/tool budgets, timeout, and concurrency limits;
- restrictive or no parent inheritance;
- task/session/duration lease lifetime and revocation events.

The schema rejects contradictory grants, structurally malformed credential locators, recognizable serialized credential formats, empty non-denied boundaries, and risk underclassification for the categories explicitly reviewed below. It does not provide runtime enforcement or infer semantics that are absent from version 1.

Credential validation proves only that a locator has an accepted shape. It does not prove that the locator exists or that a backing credential is authorized. A future credential broker must resolve the exact locator against an approved store, fail closed when it is unresolved, and treat the locator only as a lookup key—never as credential material itself.

Default-deny semantics are explicit:

- skill, plugin, and MCP server names are exact identifiers; `*` is invalid;
- an empty general allow list grants nothing;
- every allowed MCP server requires a tool-grant entry;
- MCP tool allow contains exact names or equals exactly `["*"]` for all discovered tools on that server;
- MCP tool deny contains exact names only and removes exact tools even from wildcard allow;
- every current untyped MCP server grant fails closed as Class 4/write until trusted server/tool capability metadata exists.

For Git boundaries with action `allow` or `ask`, only the exact command names `status`, `diff`, `log`, `show`, and `rev-parse` remain read authority. Exact `add`, `commit`, `merge`, `rebase`, `reset`, `tag`, `restore`, `checkout`, `switch`, `cherry-pick`, `revert`, `stash`, `clean`, `worktree`, `config`, and `pull` are Class 3 local-write authority. Exact `push` is Class 4 remote-write authority. Every other pattern—including wildcards, arguments, prefixes, command chains, compound strings, and unknown names—fails closed as Class 4 because it cannot prove push authority is excluded. Git action `deny` grants no authority. Shell `ask` or `allow` remains Class 3 independently of Git.

Version 1 network patterns are unstructured and cannot prove a read-only HTTP method or RPC operation. Every non-denied network boundary therefore requires Class 4/write. A future structured schema may admit reviewed GET/HEAD-only Class 2 rules. Non-denied shell, Git, and network boundaries with empty pattern lists are invalid.

Reviewed built-in IDs come from `packages/opencode/src/tool/registry.ts` and `packages/opencode/src/kilocode/background-task-tool.ts`:

- Class 0 instruction: `invalid`, `question`;
- Class 1 local read: `read`, `glob`, `grep`, `skill`, `kilo_local_recall`;
- Class 2 remote read: `webfetch`, `websearch`, `codesearch`;
- Class 3 local write/control: `bash`, `edit`, `write`, `apply_patch`, `todowrite`, `kilo_local_remember`, `plan_exit`, `lsp`;
- Class 4 remote upload: `codebase_search`;
- Class 5/admin delegation or privileged execution: `task`, `background_task`, `batch`;
- unknown non-denied built-ins: Class 5/admin.

`background_task` combines start, status, result, and cancel under one current tool ID, so version 1 assigns the highest Class 5/admin floor. Future operation-specific capabilities may lower status/result after review; cancellation remains state-mutating control. Runtime plugins are instance-wide Class 5/admin code and are not dynamically leaseable. No MCP or plugin is installed or enabled here.

## Risk classes

| Class | Meaning | Examples | Default posture |
| --- | --- | --- | --- |
| 0 | Instructions only | Skill text, templates, static policy | Explicit selection. |
| 1 | Read-only local | Repository reads, status/diff, local metadata | Restrict roots; no shell writes. |
| 2 | Read-only remote | Reviewed `webfetch`, `websearch`, and `codesearch` built-ins | Exact reviewed tool ID; no untyped MCP or unstructured network grant. |
| 3 | Local write | Source edits, tests, local Git writes | Bounded roots, lease, review before commit. |
| 4 | Remote write | Issue/PR mutations, uploads | Explicit ask, narrow API tools, audit trail. |
| 5 | Administrative/deployment | Secrets, org settings, releases, production | Deny by default; separate human approval. |

## Initial agent capability matrix

These are proposals, not active grants.

| Agent | Identity reference | Class | Built-ins | Skills | MCP | Writes/network | Lease |
| --- | --- | --- | --- | --- | --- | --- | --- |
| orchestrator | `profile:orchestrator` | 2 default | read, grep, glob, question; shell denied; Git status/diff/log/show/rev-parse only | orchestrator-delegation, evidence-handoff, capability-security-review, provider-model-routing | none | no source writes; unstructured network denied; delegation start requires separate Class 5/admin authority | session |
| source-researcher | `profile:source-researcher` | 2 | read, grep, glob, reviewed remote-read built-ins | repo-state-verification, evidence-handoff, provider-model-routing | none until a typed descriptor or broker-reviewed declaration proves Class 2 semantics | read roots; shell and unstructured network denied | task |
| repository-auditor | `profile:repository-auditor` | 1 | read, grep, glob; read-only Git | repo-state-verification, strict-code-review, baseline-failure-classification | none | repository read only; network denied | task |
| focused-test-runner | `profile:focused-test-runner` | 3 | constrained shell plus read | focused-test-validation, baseline-failure-classification, evidence-handoff | none | test command allowlist; Git writes/network denied | task/duration |
| strict-reviewer | `profile:strict-reviewer` | 1 | read, grep, glob; diff/log | strict-code-review, capability-security-review, evidence-handoff | none | read-only roots; shell/network denied | task |

Each final manifest must name a distinct provider/model/credential reference. No parent credential is inherited merely because a model matches.

## Capability Doctor design

The pure scaffold is `packages/opencode/src/kilocode/capability/doctor.ts`. It operates only on already-collected, redacted input. It is not a live config collector, MCP health client, process inspector, or runtime broker. It reports:

- config source path, scope, and committed state;
- selected agent, provider/model IDs, and credential reference names only;
- enabled skills, plugins, MCP servers, and exposed namespaced MCP tools;
- built-in permission rules, tool count, and estimated context tokens;
- server health and startup time;
- active leases;
- duplicate project/global names, missing selected servers, and global MCP bleed;
- orphaned process IDs;
- likely committed-secret object paths without secret values.

The project-local `/capability-doctor` draft command is read-only. A future adapter must collect effective provenance without printing environment values, headers, OAuth data, API keys, auth records, or raw commands containing secrets.

## Secret handling invariants

- Manifests store reference-shaped locators, never credential values. Environment references use `[A-Z_][A-Z0-9_]{0,63}`; auth/account/profile references use bounded lowercase conventional identifiers matching `[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*`.
- Doctor output may include environment variable and credential reference names, never values.
- Secret scanning reports object paths only.
- Remote headers, MCP environment maps, `auth.json`, and process environment values are always redacted.
- Committed direct tokens are Class 5 findings and block enablement.

## Synthetic MCP plan

A later, separately authorized fixture will be project-local, disabled by default, and contain no network or machine access.

| Tool | Behavior |
| --- | --- |
| `health` | Returns protocol and fixture version. |
| `echo` | Returns bounded caller text. |
| `fixed-result` | Returns a deterministic object. |
| `timeout` | Waits beyond a deadline and supports cancellation. |
| `known-error` | Returns a deterministic MCP error. |

Required later tests:

1. startup acknowledgement and measured startup time;
2. tool discovery and namespace sanitization;
3. server and individual-tool permission denial;
4. visibility to one leased specialist and invisibility to orchestrator/siblings;
5. request timeout and abort propagation;
6. cancellation while a request is pending;
7. client close and process shutdown on lease/session disposal;
8. orphan detection after abnormal termination;
9. sibling session isolation;
10. tool count and context-token accounting;
11. no global config or environment bleed;
12. restart behavior after known error or disappearance.

No fixture is installed, configured, or started in A4A.

## Narrow future seams

1. Keep schema, broker, leases, and doctor under `src/kilocode/capability/`.
2. Add a task adapter immediately before child `Session.create` to select/intersect manifests.
3. Store only manifest ID/version and lease ID on future Kilo task/session metadata unless persistence is separately designed.
4. Filter skills before `Skill.available` descriptions are built.
5. Filter MCP definitions before `session/prompt.ts` adds them to model context; execution permission remains a second gate.
6. Filter built-ins at ToolRegistry output through a narrow Kilo predicate rather than restructuring the shared registry.
7. Treat runtime plugins as instance-wide Class 5/admin code; do not lease them dynamically.
8. Revoke leases from foreground/background completion, cancel, timeout, and instance finalizers.

## Decisions still required

- Whether manifests live only in `.kilo/capabilities/` or become a validated `kilo.json` field.
- Whether child sessions persist manifest/lease IDs or the first broker is in-memory.
- Whether provider credentials may be shared by explicit reference or must always be unique.
- The MCP schema/description context-token estimation method.
- Whether process health belongs in the CLI doctor, server API, or both.
- Whether global MCP neutralization uses disabled stubs or a new disable-global mechanism.
