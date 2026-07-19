---
name: opencode-patterns
description: Reference for the eight key TypeScript patterns used throughout packages/opencode — namespace modules, fn(), Instance.state(), Tool.define(), BusEvent, NamedError, iife(), and Log.create. Each entry includes the definition location and a real usage example with file:line anchors.
---

# Skill: opencode-patterns

Reference for the eight key TypeScript patterns used throughout
`packages/opencode/src/`. Each entry includes definition location, signature,
real in-repo example, and constraints.

## 1. Namespace modules

One namespace per module file, no classes. Contains Zod schemas, types, and
functions.

```ts
export namespace Session {
  export const Info = z.object({ ... })
  export type Info = z.infer<typeof Info>
  export const create = fn(z.object({ ... }), async (input) => { ... })
}
```

Real example: `src/session/message-v2.ts:41` (export namespace MessageV2).

Constraints: flat namespace (no nesting), no default exports, name matches the
module concept (e.g. `Tool`, `Bus`, `Session`).

## 2. `fn(schema, callback)` — Zod-validated function wrapper

Definition: `src/util/fn.ts:3`

```ts
export function fn<T extends z.ZodType, Result>(schema: T, cb: (input: z.infer<T>) => Result) { ... }
```

Validates input via `schema.parse` before calling `cb`. The returned function
has `.force(input)` (bypass validation) and `.schema` (the Zod schema).

Callers: `src/storage/storage.ts` (`export const read = fn(...)`),
`src/session/message.ts`. Callback may be async; only ZodError is formatted
before rethrow.

## 3. `Instance.state(init, dispose?)` — Per-project lazy singleton

Definition: `src/project/instance.ts:117`

```ts
state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S
```

```ts
const state = Instance.state(async () => { return { ... } })
const s = await state()
s.someValue
```

Cached per `Instance.directory` via AsyncLocalStorage. `dispose` runs on
`Instance.dispose()`. Do NOT call outside an active Instance context. The
Effect-based `InstanceState.make` variant at `src/effect/instance-state.ts:12`
is for modules using Effect DI; `src/bus/index.ts:49` shows a real usage.

## 4. `Tool.define(id, init)` — Tool definition

Definition: `src/tool/tool.ts:49`

```ts
export function define<Parameters extends z.ZodType, Result extends Metadata>(
  id: string,
  init: Info<Parameters, Result>["init"] | Awaited<ReturnType<...>>,
): Info<Parameters, Result>
```

The `init` arg is either a factory `(ctx?) => Promise<{description, parameters,
execute}>` or a static object. The execute wrapper auto-validates args,
optionally calls `formatValidationError`, and truncates output via
`Truncate.output` (unless `result.metadata.truncated` is already set).

Real example: `src/tool/glob.ts:10`

```ts
export const GlobTool = Tool.define("glob", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The glob pattern to match files against"),
    path: z.string().optional().describe(...),
  }),
  async execute(params, ctx) {
    await ctx.ask({ permission: "glob", ... })
    return { title: "Glob results", metadata: {}, output: ... }
  },
})
```

The `ctx` in execute provides `sessionID`, `messageID`, `agent`, `abort`,
`ask()`, and `metadata()`. Tool IDs must be unique (registered in
`ToolRegistry`, `src/tool/registry.ts:40`). All tools live in `src/tool/*.ts`.

## 5. `BusEvent.define(type, schema)` + `Bus.publish()` — In-process pub/sub

Definition (event type): `src/bus/bus-event.ts:9`

```ts
export function define<Type extends string, Properties extends ZodType>(type: Type, properties: Properties)
```

Definition (publish/subscribe): `src/bus/index.ts:10`

```ts
export namespace Bus {
  async function publish<D extends BusEvent.Definition>(def: D, properties: z.output<D["properties"]>)
  function subscribe<D extends BusEvent.Definition>(def: D, callback: (event) => unknown)
  function subscribeAll(callback: (event) => unknown)
}
```

Real example: `src/bus/index.ts:13` (`InstanceDisposed` event definition) and
`src/bus/index.ts:83-98` (publish implementation — writes to typed + wildcard
PubSub, plus GlobalBus.emit).

Constraints: all events must be defined via `BusEvent.define` so the
`payloads()` discriminated union stays accurate. `Bus.publish` is async.
`Bus.subscribe` returns a sync unsubscribe function. For Effect subscribers use
`Bus.Service` methods returning `Stream.Stream`.

## 6. `NamedError.create(name, schema)` — Structured errors

Definition: `packages/util/src/error.ts:7`

```ts
static create<Name extends string, Data extends z.core.$ZodType>(name: Name, data: Data)
```

Prefer over throwing raw `Error`. The returned class extends `NamedError` and
has `.Schema`, `.isInstance(input)`, `.toObject()`, and `.data` properties.

Real examples: `src/session/message-v2.ts:46` (OutputLengthError, AuthError,
APIError), `src/storage/storage.ts:18` (NotFoundError), `src/provider/provider.ts:1635`
(ModelNotFoundError), `src/worktree/index.ts:87` (NotGitError).

Constraints: PascalCase name with descriptive suffix (e.g. `NotFoundError`).
Narrow schema preferred (`z.object({...})` over `z.any()`). Call at module top
level (it's a class factory).

## 7. `iife(fn)` — Immediately-invoked function expression

Definition: `src/util/iife.ts:1`

```ts
export function iife<T>(fn: () => T) {
  return fn()
}
```

Avoids `let` (prohibited by style guide) when const needs conditional
initialization.

Real example: `src/project/instance.ts:36`

```ts
function boot(input) {
  return iife(async () => {
    const ctx = input.project && input.worktree
      ? { directory: input.directory, ... }
      : await Project.fromDirectory(input.directory).then(...)
    return ctx
  })
}
```

Prefer ternary or `||` when possible; `iife` is for when the init contains
statements (try/catch, loops, await in a sync-looking path). Prefer extracting
a named function if the body exceeds ~10 lines.

## 8. `Log.create({ service: "name" })` — Logging

Definition (usage convention):

```ts
export namespace Log {
  export const create = (opts: { service: string }) => { ... }
}
```

Real example: `src/bus/index.ts:11` (`const log = Log.create({ service: "bus" })`).
Provides `info`, `warn`, `error`, `debug` methods. Do NOT use `console.log`
directly. Log structured data as the second argument (object), not string
interpolation. Do NOT log secrets at `info` level (use `debug`).
