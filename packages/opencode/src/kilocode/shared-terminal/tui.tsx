import { BoxRenderable, ScrollBoxRenderable, type KeyEvent, type PasteEvent, decodePasteBytes } from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack } from "solid-js"
import stripAnsi from "strip-ansi"
import { useTheme } from "@tui/context/theme"
import { SharedTerminalDebug } from "./debug"

export interface TuiTerminalInfo {
  sessionID: string
  terminalID: string
  generation: number
  attachmentID: string
  title: string
  status: string
  cols: number
  rows: number
}

export type TuiTerminalEvent =
  | {
      type: "output"
      sessionID: string
      terminalID: string
      generation: number
      attachmentID: string
      data: string
      next: number
      replay: boolean
    }
  | {
      type: "status"
      sessionID: string
      terminalID: string
      generation: number
      attachmentID: string
      status: string
    }
  | {
      type: "error"
      sessionID: string
      terminalID: string
      generation: number
      attachmentID: string
      message: string
    }

export interface TuiTerminalClient {
  open(input: {
    sessionID: string
    directory: string
    cursor: number
    cols: number
    rows: number
  }): Promise<TuiTerminalInfo>
  detach(input: { sessionID: string; attachmentID: string }): Promise<void>
  write(input: { sessionID: string; attachmentID: string; data: string }): Promise<TuiTerminalInfo>
  resize(input: { sessionID: string; attachmentID: string; cols: number; rows: number }): Promise<TuiTerminalInfo>
  terminate(input: { sessionID: string }): Promise<void>
  subscribe(handler: (event: TuiTerminalEvent) => void): () => void
}

export interface TuiTerminalState {
  visible: () => boolean
  attached: () => boolean
  inputActive: () => boolean
  attachmentID: () => string | undefined
  info: () => TuiTerminalInfo | undefined
  output: () => string
  status: () => string
  open(): Promise<TuiTerminalInfo>
  hide(): Promise<void>
  toggle(): Promise<void>
  run(command: string): Promise<void>
  write(data: string): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  terminate(): Promise<void>
  activate(): void
  deactivate(): void
}

export function terminalLabel(terminal: TuiTerminalState): string {
  if (terminal.attachmentID() && terminal.attached()) return "running/attached"
  return terminal.status()
}

export function renderTerminalOutput(value: string): string {
  return stripAnsi(value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]*\u0008/g, "")
}

export function terminalKey(event: KeyEvent): string | undefined {
  if (event.eventType === "release") return
  if (event.ctrl && event.name.toLowerCase() === "c") return "\x03"

  const name = event.name.toLowerCase()
  if (["enter", "return", "linefeed", "kpenter"].includes(name)) return "\r"
  if (["backspace", "backspace2"].includes(name)) {
    if (event.raw === "\x08" || event.raw === "\x7f") return event.raw
    if (event.sequence === "\x08" || event.sequence === "\x7f") return event.sequence
    return "\x7f"
  }
  if (["delete", "del", "kpdelete"].includes(name)) {
    if (event.source === "raw" && event.raw.startsWith("\x1b[") && event.raw.endsWith("~")) return event.raw
    return "\x1b[3~"
  }
  if (["left", "kpleft"].includes(name)) return event.source === "raw" ? event.raw || "\x1b[D" : "\x1b[D"
  if (["right", "kpright"].includes(name)) return event.source === "raw" ? event.raw || "\x1b[C" : "\x1b[C"
  if (["up", "kpup"].includes(name)) return event.source === "raw" ? event.raw || "\x1b[A" : "\x1b[A"
  if (["down", "kpdown"].includes(name)) return event.source === "raw" ? event.raw || "\x1b[B" : "\x1b[B"
  if (["home", "kphome"].includes(name)) return event.source === "raw" ? event.raw || "\x1b[H" : "\x1b[H"
  if (["end", "kpend"].includes(name)) return event.source === "raw" ? event.raw || "\x1b[F" : "\x1b[F"
  if (name === "tab") return "\t"
  if (event.ctrl && event.name.length === 1) return String.fromCharCode(event.name.toUpperCase().charCodeAt(0) - 64)

  if (event.source === "kitty") {
    if (!event.sequence || event.sequence.startsWith("\x1b[")) return
    return event.meta ? "\x1b" + event.sequence : event.sequence
  }
  return event.raw || event.sequence || undefined
}

export function terminalSpecialKey(event: KeyEvent): boolean {
  if (event.ctrl && event.name.toLowerCase() === "c") return true
  return [
    "enter",
    "return",
    "linefeed",
    "kpenter",
    "backspace",
    "backspace2",
    "delete",
    "del",
    "kpdelete",
    "left",
    "kpleft",
    "right",
    "kpright",
    "up",
    "kpup",
    "down",
    "kpdown",
    "home",
    "kphome",
    "end",
    "kpend",
    "tab",
    "escape",
  ].includes(event.name.toLowerCase())
}

export function dispatchActiveTerminalKey(event: KeyEvent, terminal: TuiTerminalState): boolean {
  if (!terminal.visible() || !terminal.inputActive() || !terminal.attached() || !terminal.attachmentID()) return false
  if (!terminalSpecialKey(event)) return false
  return dispatchTerminalKey(event, {
    hide: () => void terminal.hide().catch(() => {}),
    scroll: () => {},
    write: (data) => void terminal.write(data).catch(() => {}),
  })
}

export interface TerminalKeyActions {
  hide(): void
  scroll(lines: number): void
  write(data: string): void
}

export function dispatchTerminalKey(event: KeyEvent, actions: TerminalKeyActions): boolean {
  if (event.defaultPrevented) {
    SharedTerminalDebug.traceKey("dispatch_terminal_key", event, { errorCode: "default_prevented" })
    return false
  }
  if (event.eventType === "release") {
    SharedTerminalDebug.traceKey("dispatch_terminal_key", event, { errorCode: "release" })
    return false
  }
  if (event.name === "escape") {
    event.preventDefault()
    event.stopPropagation()
    actions.hide()
    return true
  }
  if (event.name === "pageup" || event.name === "pagedown") {
    event.preventDefault()
    event.stopPropagation()
    actions.scroll(event.name === "pageup" ? -1 : 1)
    return true
  }
  const data = terminalKey(event)
  if (data === undefined) {
    SharedTerminalDebug.traceKey("dispatch_terminal_key", event, { errorCode: "not_encoded" })
    return false
  }
  SharedTerminalDebug.traceKey("dispatch_terminal_key", event, { bytes: SharedTerminalDebug.submitBytes(data) })
  event.preventDefault()
  event.stopPropagation()
  actions.write(data)
  return true
}

export function createTuiTerminal(input: {
  client: TuiTerminalClient
  sessionID: string
  directory: () => string
  size: () => { cols: number; rows: number }
  focus: () => void
  error: (message: string) => void
}): TuiTerminalState {
  SharedTerminalDebug.count("createTuiTerminal") // kilocode_change
  const [visible, setVisible] = createSignal(false)
  const [attached, setAttached] = createSignal(false)
  const [inputActive, setInputActive] = createSignal(false)
  const [info, setInfo] = createSignal<TuiTerminalInfo>()
  const [output, setOutput] = createSignal("")
  const [status, setStatus] = createSignal("detached")
  const [cursor, setCursor] = createSignal(0)
  const decoder = new TextDecoder()
  const pending: { value?: Promise<TuiTerminalInfo> } = {}
  const operation = { epoch: 0 }
  const sizes = new Map<string, { cols: number; rows: number }>()
  const resizing: {
    active: boolean
    next?: { attachmentID: string; epoch: number; cols: number; rows: number }
    done?: ReturnType<typeof Promise.withResolvers<void>>
  } = { active: false }

  const report = (error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error)
    input.error(message)
    throw error
  }

  const unsubscribe = input.client.subscribe((event) => {
    if (event.sessionID !== input.sessionID) return
    const current = info()
    if (!current || !attached()) return
    if (
      event.terminalID !== current.terminalID ||
      event.generation !== current.generation ||
      event.attachmentID !== current.attachmentID
    )
      return
    if (event.type === "output") {
      const text = decoder.decode(Buffer.from(event.data, "base64"), { stream: true })
      setCursor(event.next)
      setOutput((value) => (value + text).slice(-262_144))
      return
    }
    if (event.type === "status") {
      if (event.status === "resize") {
        SharedTerminalDebug.trace("tui_status_event", {
          attachmentID: event.attachmentID,
          terminalID: event.terminalID,
          generation: event.generation,
          attached: attached(),
          status: status(),
          errorCode: "resize_ack_ignored",
        })
        return
      }
      SharedTerminalDebug.trace("tui_status_event", {
        attachmentID: event.attachmentID,
        terminalID: event.terminalID,
        generation: event.generation,
        attached: attached(),
        status: event.status,
      })
      setStatus(event.status)
      if (event.status === "exited" || event.status === "cleanup") {
        setAttached(false)
        setInputActive(false)
      }
      return
    }
    setStatus("error")
    input.error(event.message)
  })

  async function open() {
    const before = info()
    SharedTerminalDebug.trace("tui_open_invoked", {
      attachmentID: before?.attachmentID,
      terminalID: before?.terminalID,
      generation: before?.generation,
      attached: attached(),
      status: status(),
    })
    setVisible(true)
    if (attached() && info()) {
      SharedTerminalDebug.trace("tui_open_reused", {
        attachmentID: info()?.attachmentID,
        terminalID: info()?.terminalID,
        generation: info()?.generation,
        attached: attached(),
        status: status(),
      })
      setInputActive(true) // kilocode_change - establish input ownership on reuse
      return info()!
    }
    if (pending.value) return pending.value
    const epoch = ++operation.epoch
    const size = input.size()
    const task = input.client
      .open({
        sessionID: input.sessionID,
        directory: input.directory(),
        cursor: cursor(),
        cols: size.cols,
        rows: size.rows,
      })
      .then(
        (value) => {
          SharedTerminalDebug.trace("tui_open_rpc_success", {
            attachmentID: value.attachmentID,
            terminalID: value.terminalID,
            generation: value.generation,
            attached: attached(),
            status: value.status,
          })
          if (operation.epoch !== epoch) {
            void input.client.detach({ sessionID: input.sessionID, attachmentID: value.attachmentID }).catch(() => {})
            return value
          }
          setInfo(value)
          setAttached(true)
          setStatus(value.status === "running" ? "running" : value.status)
          setInputActive(true) // kilocode_change - establish input ownership on successful attach
          SharedTerminalDebug.trace("tui_open_state_applied", {
            attachmentID: value.attachmentID,
            terminalID: value.terminalID,
            generation: value.generation,
            attached: true,
            status: value.status === "running" ? "running" : value.status,
          })
          return value
        },
        (error) => {
          SharedTerminalDebug.trace("tui_open_rpc_error", {
            attached: attached(),
            status: status(),
            errorCode: SharedTerminalDebug.errorCode(error),
          })
          if (operation.epoch === epoch) {
            setVisible(false)
            setAttached(false)
          }
          return report(error)
        },
      )
      .finally(() => {
        pending.value = undefined
      })
    pending.value = task
    return task
  }

  async function hide() {
    const epoch = ++operation.epoch
    const current = info()
    SharedTerminalDebug.trace("tui_hide_invoked", {
      attachmentID: current?.attachmentID,
      terminalID: current?.terminalID,
      generation: current?.generation,
      attached: attached(),
      status: status(),
    })
    setVisible(false)
    setInputActive(false)
    const wasAttached = attached()
    setAttached(false)
    if (current) sizes.delete(current.attachmentID)
    resizing.next = undefined
    const task =
      wasAttached && current
        ? input.client.detach({ sessionID: input.sessionID, attachmentID: current.attachmentID }).catch(report)
        : Promise.resolve(undefined)
    await task.finally(() => {
      if (operation.epoch !== epoch) return
      setStatus("detached")
      SharedTerminalDebug.trace("tui_hide_state_applied", {
        attachmentID: current?.attachmentID,
        terminalID: current?.terminalID,
        generation: current?.generation,
        attached: false,
        status: "detached",
      })
      input.focus()
    })
  }

  async function toggle() {
    if (visible()) {
      await hide()
      return
    }
    await open()
  }

  async function write(data: string) {
    const current = info()
    SharedTerminalDebug.traceSubmit("tui_state_write_invoked", data, {
      attachmentID: current?.attachmentID,
      terminalID: current?.terminalID,
      generation: current?.generation,
      attached: attached(),
      status: status(),
    })
    const value = await open()
    if (!attached() || info()?.attachmentID !== value.attachmentID) {
      SharedTerminalDebug.traceSubmit("tui_state_write_result", data, {
        attachmentID: value.attachmentID,
        terminalID: value.terminalID,
        generation: value.generation,
        attached: attached(),
        status: status(),
        errorCode: "panel_did_not_attach",
      })
      throw new Error("shared-terminal: panel did not attach")
    }
    const next = await input.client
      .write({ sessionID: input.sessionID, attachmentID: value.attachmentID, data })
      .catch((error) => {
        SharedTerminalDebug.traceSubmit("tui_state_write_result", data, {
          attachmentID: value.attachmentID,
          terminalID: value.terminalID,
          generation: value.generation,
          attached: attached(),
          status: status(),
          errorCode: SharedTerminalDebug.errorCode(error),
        })
        return report(error)
      })
    SharedTerminalDebug.traceSubmit("tui_state_write_result", data, {
      attachmentID: next.attachmentID,
      terminalID: next.terminalID,
      generation: next.generation,
      attached: attached(),
      status: status(),
    })
    if (
      next.terminalID === value.terminalID &&
      next.generation === value.generation &&
      next.attachmentID === value.attachmentID
    )
      setInfo(next)
  }

  async function run(command: string) {
    if (!command) {
      await toggle()
      return
    }
    await write(command + "\r")
  }

  async function drainResize(): Promise<void> {
    const request = resizing.next
    if (!request) {
      resizing.active = false
      resizing.done?.resolve()
      resizing.done = undefined
      return
    }
    resizing.next = undefined
    const current = untrack(info)
    if (operation.epoch !== request.epoch || !untrack(attached) || current?.attachmentID !== request.attachmentID)
      return drainResize()
    const value = await input.client
      .resize({
        sessionID: input.sessionID,
        attachmentID: request.attachmentID,
        cols: request.cols,
        rows: request.rows,
      })
      .catch(report)
    const active = untrack(info)
    if (
      operation.epoch === request.epoch &&
      untrack(attached) &&
      active?.attachmentID === request.attachmentID &&
      value.attachmentID === request.attachmentID
    )
      setInfo(value)
    return drainResize()
  }

  function startResize() {
    if (resizing.active) return
    resizing.active = true
    void drainResize().catch((error) => {
      resizing.active = false
      resizing.done?.reject(error)
      resizing.done = undefined
    })
  }

  async function resize(cols: number, rows: number) {
    const current = untrack(info)
    if (!untrack(attached) || !current) return
    const last = sizes.get(current.attachmentID)
    if (last?.cols === cols && last.rows === rows) return resizing.done?.promise
    sizes.set(current.attachmentID, { cols, rows })
    resizing.next = { attachmentID: current.attachmentID, epoch: operation.epoch, cols, rows }
    resizing.done ??= Promise.withResolvers<void>()
    startResize()
    return resizing.done.promise
  }

  async function terminate() {
    operation.epoch++
    await input.client.terminate({ sessionID: input.sessionID }).catch(report)
    setVisible(false)
    setAttached(false)
    setInputActive(false)
    sizes.clear()
    resizing.next = undefined
    setInfo(undefined)
    setOutput("")
    setCursor(0)
    setStatus("terminated")
    input.focus()
  }

  onCleanup(() => {
    setInputActive(false)
    unsubscribe()
    const current = info()
    if (attached() && current)
      void input.client.detach({ sessionID: input.sessionID, attachmentID: current.attachmentID })
  })

  return {
    visible,
    attached,
    inputActive,
    attachmentID: () => info()?.attachmentID,
    info,
    output,
    status,
    open,
    hide,
    toggle,
    run,
    write,
    resize,
    terminate,
    activate: () => {
      if (!visible() || !attached() || !info()?.attachmentID) return
      setInputActive(true)
    },
    deactivate: () => setInputActive(false),
  }
}

export function SharedTerminalPanel(props: { terminal: TuiTerminalState; height: number; cols: number; rows: number }) {
  const { theme } = useTheme()
  const rendered = createMemo(() => renderTerminalOutput(props.terminal.output()))
  const refs: { root?: BoxRenderable; scroll?: ScrollBoxRenderable } = {}

  onMount(() => {
    setTimeout(() => {
      refs.root?.focus()
      props.terminal.activate() // kilocode_change - own terminal input without depending on synchronous focus
    }, 0)
  })

  onCleanup(() => props.terminal.deactivate())

  createEffect(() => {
    rendered()
    setTimeout(() => refs.scroll?.scrollTo(refs.scroll.scrollHeight), 0)
  })

  createEffect(() => {
    const attached = props.terminal.attached()
    const cols = Math.max(1, props.cols)
    const rows = Math.max(1, props.rows)
    if (!attached) return
    untrack(() => void props.terminal.resize(cols, rows).catch(() => {}))
  })

  const keydown = (event: KeyEvent) => {
    const current = props.terminal.info()
    SharedTerminalDebug.traceKey("terminal_panel_handler", event, {
      attachmentID: current?.attachmentID,
      terminalID: current?.terminalID,
      generation: current?.generation,
      attached: props.terminal.attached(),
      status: props.terminal.status(),
    })
    return dispatchTerminalKey(event, {
      hide: () => void props.terminal.hide().catch(() => {}),
      scroll: (direction) => refs.scroll?.scrollBy(direction * Math.max(1, props.height - 3)),
      write: (data) => void props.terminal.write(data).catch(() => {}),
    })
  }

  const paste = (event: PasteEvent) => {
    event.preventDefault()
    event.stopPropagation()
    void props.terminal.write(decodePasteBytes(event.bytes)).catch(() => {})
  }

  return (
    <box
      ref={(value) => (refs.root = value)}
      height={props.height}
      flexShrink={0}
      focusable={true}
      border={["top"]}
      borderColor={props.terminal.attached() ? theme.primary : theme.border}
      backgroundColor={theme.backgroundPanel}
      onKeyDown={keydown}
      onPaste={paste}
      onMouseDown={() => {
        refs.root?.focus()
        props.terminal.activate()
      }}
    >
      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={theme.textMuted}>
          Terminal
          <Show when={props.terminal.info()}>
            {(value) => ` ${value().terminalID} · gen ${value().generation} · ${terminalLabel(props.terminal)}`}
          </Show>
        </text>
        <box flexDirection="row" gap={2}>
          <text fg={theme.text} onMouseUp={() => void props.terminal.hide().catch(() => {})}>
            enter run · esc hide
          </text>
          <text fg={theme.error} onMouseUp={() => void props.terminal.terminate().catch(() => {})}>
            terminate
          </text>
        </box>
      </box>
      <scrollbox ref={(value) => (refs.scroll = value)} flexGrow={1} stickyScroll={true} stickyStart="bottom">
        <text fg={theme.text} selectable={true}>
          {rendered() || "Starting shell..."}
        </text>
      </scrollbox>
    </box>
  )
}
