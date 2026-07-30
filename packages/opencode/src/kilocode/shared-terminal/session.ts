import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Shell } from "@/shell/shell"
import { SharedTerminalSchema as S } from "./schema"
import { sharedTerminalRuntime } from "./runtime"
import { SharedTerminalService } from "./service"
import { SharedTerminalDebug } from "./debug"

export namespace SessionTerminal {
  export interface Handle {
    sessionID: string
    terminalID: string
    generation: number
    ref: SharedTerminalService.TerminalRef
    info: S.Info
  }

  export interface EnsureInput {
    sessionID: string
    projectID: string
    directory: string
    worktree: string
    actor: S.Actor
    title: string
    cols: number
    rows: number
  }

  export interface OpenInput extends EnsureInput {
    cursor: number
    callbacks: SharedTerminalService.AttachCallbacks
  }

  export interface View extends Handle {
    attachmentID: string
  }

  interface Entry {
    terminalID: string
    generation: number
    ref: SharedTerminalService.TerminalRef
    attachmentID?: string
  }

  const state = Instance.state(
    () => {
      const runtime = sharedTerminalRuntime()
      const entries = new Map<string, Entry>()
      const pending = new Map<string, Promise<Handle>>()
      const opening = new Map<string, Promise<View>>()
      const cleanup = async (sessionID: string) => {
        const entry = entries.get(sessionID)
        if (!entry) return
        entries.delete(sessionID)
        if (entry.attachmentID) await runtime.svc.detach(entry.terminalID, entry.attachmentID)
        await runtime.svc.disposeTerminal(entry.terminalID)
      }
      const unsub = Bus.subscribeAll((event) => {
        if (event.type !== "session.deleted") return
        void cleanup(event.properties.sessionID)
      })
      return { runtime, entries, pending, opening, cleanup, unsub }
    },
    async (value) => {
      value.unsub()
      value.entries.clear()
      value.pending.clear()
      value.opening.clear()
    },
  )

  function handle(sessionID: string): Handle | undefined {
    const value = state()
    const entry = value.entries.get(sessionID)
    if (!entry) return
    const info = value.runtime.svc.info(entry.terminalID)
    if (
      !info ||
      info.generation !== entry.generation ||
      info.pid !== entry.ref.rootPID ||
      info.lifecycle !== "running" ||
      info.scope.projectID !== Instance.project.id ||
      !info.access.sessions.includes(sessionID) ||
      info.access.agent === "none"
    ) {
      value.entries.delete(sessionID)
      return
    }
    return { sessionID, terminalID: info.id, generation: info.generation, ref: entry.ref, info }
  }

  export function current(sessionID: string): Handle | undefined {
    return handle(sessionID)
  }

  export async function ensure(input: EnsureInput): Promise<Handle> {
    if (input.projectID !== Instance.project.id) throw new Error("shared-terminal: project mismatch")
    if (input.directory !== Instance.directory) throw new Error("shared-terminal: directory mismatch")
    const current = handle(input.sessionID)
    if (current) return current
    const value = state()
    const pending = value.pending.get(input.sessionID)
    if (pending) return pending
    const task = (async () => {
      const shell = await Shell.preferred()
      const result = await value.runtime.svc.create({
        file: shell,
        args: [],
        scope: { projectID: input.projectID, directory: input.directory, worktree: input.worktree },
        createdBy: input.actor,
        title: input.title,
        cols: input.cols,
        rows: input.rows,
        accessSessions: [input.sessionID],
      })
      const entry: Entry = {
        terminalID: result.info.id,
        generation: result.info.generation,
        ref: result.ref,
      }
      value.entries.set(input.sessionID, entry)
      return {
        sessionID: input.sessionID,
        terminalID: result.info.id,
        generation: result.info.generation,
        ref: result.ref,
        info: result.info,
      }
    })().finally(() => value.pending.delete(input.sessionID))
    value.pending.set(input.sessionID, task)
    return task
  }

  export async function open(input: OpenInput): Promise<View> {
    const value = state()
    const current = handle(input.sessionID)
    const attached = current && value.entries.get(input.sessionID)?.attachmentID
    SharedTerminalDebug.trace("session_open_received", {
      attachmentID: attached || undefined,
      terminalID: current?.terminalID,
      generation: current?.generation,
      attached: !!attached,
      status: current?.info.lifecycle,
    })
    if (current && attached) {
      SharedTerminalDebug.trace("session_open_reused", {
        attachmentID: attached,
        terminalID: current.terminalID,
        generation: current.generation,
        attached: true,
        status: current.info.lifecycle,
      })
      return { ...current, attachmentID: attached }
    }
    const opening = value.opening.get(input.sessionID)
    if (opening) return opening
    const task = (async () => {
      const terminal = await ensure(input)
      const entry = value.entries.get(input.sessionID)
      if (!entry) throw new Error("shared-terminal: session terminal disappeared")
      if (entry.attachmentID) return { ...terminal, attachmentID: entry.attachmentID }
      const ticket = value.runtime.tickets.issue({
        terminalID: terminal.terminalID,
        generation: terminal.generation,
        projectID: terminal.info.scope.projectID,
        mode: "write",
        now: Date.now(),
      })
      const attachment = await value.runtime.svc.attachWithTicket(terminal.terminalID, {
        rawTicket: ticket.raw,
        cursor: input.cursor,
        callbacks: input.callbacks,
      })
      entry.attachmentID = attachment.attachmentID
      SharedTerminalDebug.trace("session_open_attached", {
        attachmentID: attachment.attachmentID,
        terminalID: terminal.terminalID,
        generation: terminal.generation,
        attached: true,
        status: terminal.info.lifecycle,
      })
      return { ...terminal, attachmentID: attachment.attachmentID }
    })().finally(() => value.opening.delete(input.sessionID))
    value.opening.set(input.sessionID, task)
    return task
  }

  export async function detach(sessionID: string, expected?: string): Promise<void> {
    const value = state()
    const entry = value.entries.get(sessionID)
    if (!entry?.attachmentID) return
    if (expected && entry.attachmentID !== expected) return
    const attachmentID = entry.attachmentID
    entry.attachmentID = undefined
    await value.runtime.svc.detach(entry.terminalID, attachmentID)
  }

  export async function write(sessionID: string, data: string, expected?: string): Promise<View> {
    const terminal = handle(sessionID)
    const entry = state().entries.get(sessionID)
    SharedTerminalDebug.traceSubmit("session_terminal_write_received", data, {
      attachmentID: entry?.attachmentID,
      terminalID: terminal?.terminalID,
      generation: terminal?.generation,
      attached: !!entry?.attachmentID,
      status: terminal?.info.lifecycle,
    })
    if (!terminal || !entry?.attachmentID) {
      SharedTerminalDebug.traceSubmit("session_terminal_write_result", data, {
        attachmentID: entry?.attachmentID,
        terminalID: terminal?.terminalID,
        generation: terminal?.generation,
        attached: false,
        status: terminal?.info.lifecycle,
        errorCode: "panel_not_attached",
      })
      throw new Error("shared-terminal: panel is not attached")
    }
    if (expected && entry.attachmentID !== expected) {
      SharedTerminalDebug.traceSubmit("session_terminal_write_result", data, {
        attachmentID: entry.attachmentID,
        terminalID: terminal.terminalID,
        generation: terminal.generation,
        attached: true,
        status: terminal.info.lifecycle,
        errorCode: "stale_panel_attachment",
      })
      throw new Error("shared-terminal: stale panel attachment")
    }
    await state()
      .runtime.svc.submitHuman(terminal.terminalID, entry.attachmentID, data, Date.now())
      .then(
        () => {
          SharedTerminalDebug.traceSubmit("session_terminal_write_result", data, {
            attachmentID: entry.attachmentID,
            terminalID: terminal.terminalID,
            generation: terminal.generation,
            attached: true,
            status: terminal.info.lifecycle,
          })
        },
        (error) => {
          SharedTerminalDebug.traceSubmit("session_terminal_write_result", data, {
            attachmentID: entry.attachmentID,
            terminalID: terminal.terminalID,
            generation: terminal.generation,
            attached: true,
            status: terminal.info.lifecycle,
            errorCode: SharedTerminalDebug.errorCode(error),
          })
          throw error
        },
      )
    return { ...terminal, attachmentID: entry.attachmentID }
  }

  export async function resize(sessionID: string, cols: number, rows: number, expected?: string): Promise<View> {
    const terminal = handle(sessionID)
    const entry = state().entries.get(sessionID)
    if (!terminal || !entry?.attachmentID) throw new Error("shared-terminal: panel is not attached")
    if (expected && entry.attachmentID !== expected) throw new Error("shared-terminal: stale panel attachment")
    await state().runtime.svc.resizeAttachment(terminal.terminalID, entry.attachmentID, cols, rows)
    const info = state().runtime.svc.info(terminal.terminalID)
    if (!info) throw new Error("shared-terminal: terminal disappeared after resize")
    return { ...terminal, info, attachmentID: entry.attachmentID }
  }

  export async function terminate(sessionID: string): Promise<void> {
    const value = state()
    const terminal = handle(sessionID)
    if (!terminal) {
      value.entries.delete(sessionID)
      return
    }
    value.entries.delete(sessionID)
    await value.runtime.svc.terminate(terminal.terminalID, terminal.ref)
  }

  export async function dispose(sessionID: string): Promise<void> {
    await state().cleanup(sessionID)
  }

  export function forget(sessionID: string, terminalID: string, generation: number): void {
    const value = state()
    const entry = value.entries.get(sessionID)
    if (!entry) return
    if (entry.terminalID !== terminalID || entry.generation !== generation) return
    value.entries.delete(sessionID)
  }
}
