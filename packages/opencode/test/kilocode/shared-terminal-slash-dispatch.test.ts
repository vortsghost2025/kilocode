// kilocode_change - new file
// Real dispatch tests for slash-dispatch coordinator.
// Exercises the exact production coordinator used by Prompt.submit().

import { test, expect, describe, mock } from "bun:test"
import { dispatchSlashCommand, type SlashInfo } from "../../src/cli/cmd/tui/component/prompt/slash-dispatch"

function makeSlashes<T extends SlashInfo>(input: T[]) {
  return input
}

describe("slash-dispatch coordinator", () => {
  test("local slash command is intercepted and input cleared", async () => {
    const localCalled = mock()
    const callbacks = {
      clearInput: mock(),
      invokeLocal: (slash: { display: string; onSelect: () => void }) => slash.onSelect(),
      reportLocalError: mock(),
      invokeServerCommand: mock(),
      invokeProviderPrompt: mock(),
    }

    dispatchSlashCommand({
      inputText: "/shared-terminal",
      localSlashes: makeSlashes([{ display: "/shared-terminal", onSelect: localCalled, aliases: [] }]),
      serverCommandNames: new Set(["init", "review"]),
      callbacks,
    })

    await Promise.resolve()

    expect(callbacks.clearInput).toHaveBeenCalledTimes(1)
    expect(localCalled).toHaveBeenCalledTimes(1)
    expect(callbacks.invokeServerCommand).toHaveBeenCalledTimes(0)
    expect(callbacks.invokeProviderPrompt).toHaveBeenCalledTimes(0)
    expect(callbacks.reportLocalError).toHaveBeenCalledTimes(0)
  })

  test("local slash with alias invokes same handler", async () => {
    const localCalled = mock()
    const callbacks = {
      clearInput: mock(),
      invokeLocal: async (slash: { display: string; onSelect: () => void | Promise<void> }) => slash.onSelect(),
      reportLocalError: mock(),
      invokeServerCommand: mock(),
      invokeProviderPrompt: mock(),
    }

    dispatchSlashCommand({
      inputText: "/st",
      localSlashes: makeSlashes([{ display: "/shared-terminal", onSelect: localCalled, aliases: ["/st"] }]),
      serverCommandNames: new Set(),
      callbacks,
    })

    await Promise.resolve()

    expect(localCalled).toHaveBeenCalledTimes(1)
  })

  test("local handler failure surfaces locally, no provider fallback", async () => {
    const error = new Error("boom")
    let failed = false
    const onSelect = () => {
      failed = true
      throw error
    }
    const callbacks = {
      clearInput: mock(),
      invokeLocal: async (slash: { display: string; onSelect: () => void | Promise<void> }) => {
        try {
          await slash.onSelect()
        } catch (e) {
          callbacks.reportLocalError(e)
        }
      },
      reportLocalError: mock(),
      invokeServerCommand: mock(),
      invokeProviderPrompt: mock(),
    }

    dispatchSlashCommand({
      inputText: "/shared-terminal",
      localSlashes: makeSlashes([{ display: "/shared-terminal", onSelect, aliases: [] }]),
      serverCommandNames: new Set(),
      callbacks,
    })

    await Promise.resolve()

    expect(failed).toBe(true)
    expect(callbacks.reportLocalError).toHaveBeenCalledWith(error)
    expect(callbacks.invokeServerCommand).toHaveBeenCalledTimes(0)
    expect(callbacks.invokeProviderPrompt).toHaveBeenCalledTimes(0)
  })

  test("existing server command goes through server path", async () => {
    const callbacks = {
      clearInput: mock(),
      invokeLocal: mock(),
      reportLocalError: mock(),
      invokeServerCommand: mock(),
      invokeProviderPrompt: mock(),
    }

    dispatchSlashCommand({
      inputText: "/init",
      localSlashes: [],
      serverCommandNames: new Set(["init", "review"]),
      callbacks,
    })

    expect(callbacks.invokeServerCommand).toHaveBeenCalledWith("init", "")
    expect(callbacks.invokeLocal).toHaveBeenCalledTimes(0)
    expect(callbacks.invokeProviderPrompt).toHaveBeenCalledTimes(0)
  })

  test("ordinary text goes to provider prompt", async () => {
    const callbacks = {
      clearInput: mock(),
      invokeLocal: mock(),
      reportLocalError: mock(),
      invokeServerCommand: mock(),
      invokeProviderPrompt: mock(),
    }

    dispatchSlashCommand({
      inputText: "hello world",
      localSlashes: [],
      serverCommandNames: new Set(["init"]),
      callbacks,
    })

    expect(callbacks.invokeProviderPrompt).toHaveBeenCalledWith("hello world")
    expect(callbacks.invokeLocal).toHaveBeenCalledTimes(0)
    expect(callbacks.invokeServerCommand).toHaveBeenCalledTimes(0)
  })

  test("unknown slash falls through to provider prompt", async () => {
    const callbacks = {
      clearInput: mock(),
      invokeLocal: mock(),
      reportLocalError: mock(),
      invokeServerCommand: mock(),
      invokeProviderPrompt: mock(),
    }

    dispatchSlashCommand({
      inputText: "/unknown-command",
      localSlashes: [],
      serverCommandNames: new Set(["init", "review"]),
      callbacks,
    })

    expect(callbacks.invokeProviderPrompt).toHaveBeenCalledWith("/unknown-command")
    expect(callbacks.invokeLocal).toHaveBeenCalledTimes(0)
    expect(callbacks.invokeServerCommand).toHaveBeenCalledTimes(0)
  })

  test("empty slash token falls through to provider", async () => {
    const callbacks = {
      clearInput: mock(),
      invokeLocal: mock(),
      reportLocalError: mock(),
      invokeServerCommand: mock(),
      invokeProviderPrompt: mock(),
    }

    dispatchSlashCommand({
      inputText: "/",
      localSlashes: [],
      serverCommandNames: new Set(),
      callbacks,
    })

    expect(callbacks.invokeProviderPrompt).toHaveBeenCalledWith("/")
  })

  test("whitespace-only after slash falls through", async () => {
    const callbacks = {
      clearInput: mock(),
      invokeLocal: mock(),
      reportLocalError: mock(),
      invokeServerCommand: mock(),
      invokeProviderPrompt: mock(),
    }

    dispatchSlashCommand({
      inputText: "/   ",
      localSlashes: [],
      serverCommandNames: new Set(),
      callbacks,
    })

    expect(callbacks.invokeProviderPrompt).toHaveBeenCalledWith("/   ")
  })

  test("server command with args preserves multiline args", async () => {
    const callbacks = {
      clearInput: mock(),
      invokeLocal: mock(),
      reportLocalError: mock(),
      invokeServerCommand: mock(),
      invokeProviderPrompt: mock(),
    }

    dispatchSlashCommand({
      inputText: "/review arg1\nline2\nline3",
      localSlashes: [],
      serverCommandNames: new Set(["review"]),
      callbacks,
    })

    expect(callbacks.invokeServerCommand).toHaveBeenCalledWith("review", "arg1\nline2\nline3")
  })

  test("server command takes precedence over unknown local", async () => {
    const callbacks = {
      clearInput: mock(),
      invokeLocal: mock(),
      reportLocalError: mock(),
      invokeServerCommand: mock(),
      invokeProviderPrompt: mock(),
    }

    dispatchSlashCommand({
      inputText: "/init",
      localSlashes: makeSlashes([{ display: "/shared-terminal", onSelect: mock(), aliases: [] }]),
      serverCommandNames: new Set(["init"]),
      callbacks,
    })

    expect(callbacks.invokeServerCommand).toHaveBeenCalledWith("init", "")
    expect(callbacks.invokeLocal).toHaveBeenCalledTimes(0)
  })
})

describe("slash-dispatch with realistic registration context", () => {
  test("dispatch logic for shared-terminal registration", async () => {
    const localCalled = mock()
    const slashes = makeSlashes([
      { display: "/shared-terminal", onSelect: localCalled, aliases: [], description: "Open shared terminal" },
    ])

    const callbacks = {
      clearInput: mock(),
      invokeLocal: (slash: { display: string; onSelect: () => void }) => slash.onSelect(),
      reportLocalError: mock(),
      invokeServerCommand: mock(),
      invokeProviderPrompt: mock(),
    }

    dispatchSlashCommand({
      inputText: "/shared-terminal",
      localSlashes: slashes,
      serverCommandNames: new Set(["init", "review"]),
      callbacks,
    })

    await Promise.resolve()

    expect(localCalled).toHaveBeenCalledTimes(1)
    expect(callbacks.invokeServerCommand).toHaveBeenCalledTimes(0)
    expect(callbacks.invokeProviderPrompt).toHaveBeenCalledTimes(0)
  })
})
