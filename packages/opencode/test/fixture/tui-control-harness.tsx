import { mock } from "bun:test"
import { engine, RGBA, SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/solid"
import type { Event, Session, ToolPart } from "@kilocode/sdk/v2"
import { PassThrough, Readable } from "node:stream"
import { onMount, type ParentProps } from "solid-js"
import { ForegroundTask } from "../../src/kilocode/foreground-task"
import { SessionID } from "../../src/session/schema"

const color = RGBA.fromInts(220, 220, 220)
const passthrough = (props: ParentProps) => props.children
const agent = { name: "orchestrator", displayName: "Orchestrator" }
const local = {
  agent: {
    list: () => [agent],
    current: () => agent,
    set: (_name: string) => {},
    color: (_name: string) => color,
  },
  model: {
    current: () => undefined,
    set: (_model: { providerID: string; modelID: string }) => {},
    parsed: () => ({ provider: "Test", model: "Test", reasoning: false }),
    variant: {
      set: (_variant?: string) => {},
      current: () => undefined,
      list: () => [],
    },
  },
}

let currentSyntax: SyntaxStyle | undefined
const theme = new Proxy({} as Record<string, RGBA>, { get: () => color })

mock.module("@tui/context/theme", () => ({
  ThemeProvider: passthrough,
  useTheme: () => ({
    theme,
    syntax: () => {
      if (!currentSyntax) throw new Error("test syntax is unavailable")
      return currentSyntax
    },
  }),
  selectedForeground: () => color,
  tint: () => color,
}))
mock.module("@tui/context/local", () => ({
  LocalProvider: passthrough,
  useLocal: () => local,
}))

type Input = {
  parentID: SessionID
  childID: SessionID
  siblingID: SessionID
  matchingMetadata: boolean
  runtimeOwnership: boolean
}

type Listener = (event: Event) => void

type Host = typeof globalThis & {
  window?: { requestAnimationFrame?: typeof requestAnimationFrame }
}

type Evidence = {
  childParentID: string | undefined
  status: string | undefined
  messages: string[]
  parts: ToolPart[]
}

function session(id: string, parentID?: string): Session {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: process.cwd(),
    parentID,
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
  }
}

export async function mountPromptControl(input: Input) {
  const host = globalThis as Host
  const syntax = SyntaxStyle.fromStyles({
    "extmark.file": { fg: color },
    "extmark.agent": { fg: color },
    "extmark.paste": { fg: color },
  })
  currentSyntax = syntax
  const original = {
    date: Date.now,
    timeout: globalThis.setTimeout,
    clear: globalThis.clearTimeout,
    env: process.env.OTUI_USE_CONSOLE,
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
    window: host.window,
    hasWindow: Object.prototype.hasOwnProperty.call(host, "window"),
    windowRaf: host.window?.requestAnimationFrame,
    hasWindowRaf: !!host.window && Object.prototype.hasOwnProperty.call(host.window, "requestAnimationFrame"),
    sighup: new Set(process.listeners("SIGHUP")),
  }
  const stdin = new Readable({ read() {} })
  const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: false })
  const listeners = new Set<Listener>()
  const requests: Array<{ method: string; path: string }> = []
  const abortSessionIDs: string[] = []
  const sessions = [session(input.parentID), session(input.childID, input.parentID), session(input.siblingID, input.parentID)].toSorted(
    (a, b) => a.id.localeCompare(b.id),
  )
  const messageID = `msg_${input.parentID}`
  const message = {
    id: messageID,
    sessionID: input.parentID,
    role: "assistant" as const,
    time: { created: 1 },
    parentID: "msg_user",
    modelID: "model",
    providerID: "provider",
    mode: "primary",
    agent: "orchestrator",
    path: { cwd: process.cwd(), root: process.cwd() },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const part: ToolPart = {
    id: "part_task",
    sessionID: input.parentID,
    messageID,
    type: "tool" as const,
    callID: "call_task",
    tool: "task",
    state: {
      status: "running" as const,
      input: {},
      metadata: { sessionId: input.childID },
      time: { start: 1 },
    },
  }
  const primary = {
    name: "orchestrator",
    displayName: "Orchestrator",
    mode: "primary",
    permission: [],
    options: {},
  }
  const events = {
    on(listener: Listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(event: Event) {
      for (const listener of listeners) listener(event)
    },
    setWorkspace(_workspaceID?: string) {},
  }
  const data = (pathname: string, method: string): unknown => {
    const abort = pathname.match(/^\/session\/([^/]+)\/abort$/)
    if (abort && method === "POST") {
      abortSessionIDs.push(decodeURIComponent(abort[1]))
      return true
    }
    const detail = pathname.match(/^\/session\/([^/]+)$/)
    if (detail && method === "GET") return sessions.find((item) => item.id === decodeURIComponent(detail[1]))
    const messages = pathname.match(/^\/session\/([^/]+)\/message$/)
    if (messages && method === "GET") {
      const id = decodeURIComponent(messages[1])
      if (id !== input.parentID || !input.matchingMetadata) return []
      return [{ info: message, parts: [part] }]
    }
    if (/^\/session\/[^/]+\/todo$/.test(pathname)) return []
    if (/^\/session\/[^/]+\/diff$/.test(pathname)) return []
    if (pathname === "/config/providers") return { providers: [], default: {} }
    if (pathname === "/provider") return { all: [], default: {}, connected: [] }
    if (pathname === "/agent") return [primary]
    if (pathname === "/config") return {}
    if (pathname === "/session") return sessions
    if (pathname === "/command") return []
    if (pathname === "/lsp") return []
    if (pathname === "/mcp") return {}
    if (pathname === "/experimental/resource") return {}
    if (pathname === "/formatter") return []
    if (pathname === "/network") return []
    if (pathname === "/session/status") return {}
    if (pathname === "/provider/auth") return {}
    if (pathname === "/vcs") return { branch: "main" }
    if (pathname === "/path") return { state: "", config: "", worktree: "", directory: process.cwd() }
    if (pathname === "/experimental/workspace") return []
    if (pathname === "/config/warnings") return []
    throw new Error(`Unexpected SDK request: ${method} ${pathname}`)
  }
  let pending = 0
  const transport = async (value: string | URL | Request, init?: RequestInit) => {
    pending += 1
    try {
      const request = new Request(value, init)
      const url = new URL(request.url)
      requests.push({ method: request.method, path: url.pathname })
      return new Response(JSON.stringify(data(url.pathname, request.method)), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    } finally {
      pending -= 1
    }
  }
  const destroyed = Promise.withResolvers<void>()
  const commandReady = Promise.withResolvers<unknown>()
  const commandState = {
    registered: false,
    enabled: undefined as boolean | undefined,
    selected: 0,
    status: undefined as string | undefined,
  }
  let syncStatus = () => undefined as string | undefined
  let syncParent = async () => {}
  let syncEvidence: () => Evidence = () => ({
    childParentID: undefined,
    status: undefined,
    messages: [],
    parts: [],
  })
  let trigger = (_name: string) => {}
  const disposers = new Set<() => void>()
  const register = (sessionID: SessionID) => {
    const dispose = ForegroundTask.register(sessionID, { interrupt() {} })
    const state = { done: false }
    const tracked = () => {
      if (state.done) return
      state.done = true
      dispose()
      disposers.delete(tracked)
    }
    disposers.add(tracked)
    return tracked
  }
  if (input.runtimeOwnership) register(input.childID)
  const modules = await Promise.all([
    import("../../src/cli/cmd/tui/context/args"),
    import("../../src/cli/cmd/tui/context/exit"),
    import("../../src/cli/cmd/tui/context/kv"),
    import("../../src/cli/cmd/tui/ui/toast"),
    import("../../src/cli/cmd/tui/context/route"),
    import("../../src/cli/cmd/tui/context/tui-config"),
    import("../../src/cli/cmd/tui/context/sdk"),
    import("../../src/cli/cmd/tui/context/sync"),
    import("../../src/cli/cmd/tui/context/keybind"),
    import("../../src/cli/cmd/tui/component/prompt/stash"),
    import("../../src/cli/cmd/tui/ui/dialog"),
    import("../../src/cli/cmd/tui/component/dialog-command"),
    import("../../src/cli/cmd/tui/component/prompt/frecency"),
    import("../../src/cli/cmd/tui/component/prompt/history"),
    import("../../src/cli/cmd/tui/component/prompt"),
  ])
  const ArgsProvider = modules[0].ArgsProvider
  const ExitProvider = modules[1].ExitProvider
  const KVProvider = modules[2].KVProvider
  const ToastProvider = modules[3].ToastProvider
  const RouteProvider = modules[4].RouteProvider
  const TuiConfigProvider = modules[5].TuiConfigProvider
  const SDKProvider = modules[6].SDKProvider
  const SyncProvider = modules[7].SyncProvider
  const useSync = modules[7].useSync
  const KeybindProvider = modules[8].KeybindProvider
  const PromptStashProvider = modules[9].PromptStashProvider
  const DialogProvider = modules[10].DialogProvider
  const CommandProvider = modules[11].CommandProvider
  const useCommandDialog = modules[11].useCommandDialog
  const FrecencyProvider = modules[12].FrecencyProvider
  const PromptHistoryProvider = modules[13].PromptHistoryProvider
  const Prompt = modules[14].Prompt

  function Capture(props: ParentProps) {
    const command = useCommandDialog()
    const sync = useSync()
    trigger = command.trigger
    syncStatus = () => sync.data.session_status[input.childID]?.type
    syncParent = () => sync.session.sync(input.parentID)
    syncEvidence = () => {
      const messages = sync.data.message[input.parentID] ?? []
      const parts = messages.flatMap((item) => sync.data.part[item.id] ?? [])
      return {
        childParentID: sync.session.get(input.childID)?.parentID,
        status: sync.data.session_status[input.childID]?.type,
        messages: messages.map((item) => item.id),
        parts: parts.filter((item) => item.type === "tool"),
      }
    }
    const register = command.register
    command.register = (cb) =>
      register(() =>
        cb().map((option) => {
          if (option.value !== "session.interrupt") return option
          commandState.registered = true
          const onSelect = option.onSelect
          const wrapped = Object.create(Object.getPrototypeOf(option), Object.getOwnPropertyDescriptors(option)) as typeof option
          Object.defineProperty(wrapped, "enabled", {
            enumerable: true,
            configurable: true,
            get() {
              const enabled = option.enabled !== false
              commandState.enabled = enabled
              commandState.status = syncStatus()
              return enabled
            },
          })
          Object.defineProperty(wrapped, "onSelect", {
            enumerable: true,
            configurable: true,
            value(dialog: Parameters<NonNullable<typeof onSelect>>[0]) {
              commandState.selected += 1
              return onSelect?.(dialog)
            },
          })
          return wrapped
        }),
      )
    onMount(() => commandReady.resolve(command))
    return props.children
  }

  const setup = await testRender(
    () => (
      <ArgsProvider continue={true}>
        <ExitProvider onBeforeExit={async () => {}} onExit={async () => {}}>
          <KVProvider>
            <ToastProvider>
              <RouteProvider>
                <TuiConfigProvider config={{ keybinds: { session_interrupt: "escape" } }}>
                  <SDKProvider
                    url="http://kilo.test"
                    directory={process.cwd()}
                    fetch={transport as unknown as typeof fetch}
                    events={events}
                  >
                    <SyncProvider>
                      <KeybindProvider>
                        <PromptStashProvider>
                          <DialogProvider>
                            <CommandProvider>
                              <Capture>
                                <FrecencyProvider>
                                  <PromptHistoryProvider>
                                    <Prompt sessionID={input.childID} visible={false} showPlaceholder={false} />
                                  </PromptHistoryProvider>
                                </FrecencyProvider>
                              </Capture>
                            </CommandProvider>
                          </DialogProvider>
                        </PromptStashProvider>
                      </KeybindProvider>
                    </SyncProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </RouteProvider>
            </ToastProvider>
          </KVProvider>
        </ExitProvider>
      </ArgsProvider>
    ),
    {
      width: 80,
      height: 24,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      useThread: false,
      exitOnCtrlC: false,
      exitSignals: [],
      useMouse: false,
      useAlternateScreen: false,
      useConsole: false,
      memorySnapshotInterval: 0,
      onDestroy: destroyed.resolve,
    },
  )
  await commandReady.promise
  await syncParent()
  await setup.renderOnce()

  let now = 1_000
  const timers = new Set<ReturnType<typeof setTimeout>>()
  Date.now = () => now
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = original.timeout(...args)
    timers.add(handle)
    return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    timers.delete(handle)
    return original.clear(handle)
  }) as typeof clearTimeout

  let disposed = false
  return {
    renderer: setup.renderer,
    mockInput: setup.mockInput,
    renderOnce: setup.renderOnce,
    requests,
    abortSessionIDs,
    commandState,
    syncStatus: () => syncStatus(),
    syncEvidence: () => syncEvidence(),
    trigger(name: string) {
      trigger(name)
    },
    active: (sessionID = input.childID) => ForegroundTask.has(sessionID),
    registerRuntime(sessionID = input.childID) {
      return register(sessionID)
    },
    interruptRuntime(sessionID = input.childID) {
      return ForegroundTask.interrupt(sessionID)
    },
    pending: () => pending,
    listeners: () => listeners.size,
    advance(ms: number) {
      now += ms
    },
    async dispose() {
      if (disposed) return
      disposed = true
      Date.now = original.date
      globalThis.setTimeout = original.timeout
      globalThis.clearTimeout = original.clear
      for (const timer of timers) original.clear(timer)
      for (const dispose of [...disposers]) dispose()
      setup.renderer.stop()
      await setup.renderer.idle()
      engine.detach()
      setup.renderer.destroy()
      await destroyed.promise
      syntax.destroy()
      currentSyntax = undefined
      if (original.env === undefined) Reflect.deleteProperty(process.env, "OTUI_USE_CONSOLE")
      if (original.env !== undefined) process.env.OTUI_USE_CONSOLE = original.env
      globalThis.requestAnimationFrame = original.raf
      globalThis.cancelAnimationFrame = original.caf
      if (!original.hasWindow) Reflect.deleteProperty(host, "window")
      if (original.hasWindow) {
        host.window = original.window
        if (host.window && original.hasWindowRaf) host.window.requestAnimationFrame = original.windowRaf
        if (host.window && !original.hasWindowRaf) Reflect.deleteProperty(host.window, "requestAnimationFrame")
      }
      for (const listener of process.listeners("SIGHUP")) {
        if (!original.sighup.has(listener)) process.removeListener("SIGHUP", listener)
      }
      stdin.destroy()
      stdout.destroy()
      if (!setup.renderer.isDestroyed) throw new Error("renderer was not destroyed")
      if (ForegroundTask.has(input.childID)) throw new Error("child foreground registration remains")
      if (ForegroundTask.has(input.siblingID)) throw new Error("sibling foreground registration remains")
      if (listeners.size !== 0) throw new Error(`event listeners remain: ${listeners.size}`)
      if (pending !== 0) throw new Error(`SDK requests remain: ${pending}`)
    },
  }
}
