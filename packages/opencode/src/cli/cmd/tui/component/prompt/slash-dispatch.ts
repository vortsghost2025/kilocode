// kilocode_change - new file
// Production slash command dispatch coordinator.
// Single entry point for all slash-like input from Prompt.submit().

import { iife } from "@/util/iife"

export interface SlashInfo {
  display: string
  aliases?: string[]
  onSelect: () => void | Promise<void>
}

export interface SlashDispatchCallbacks {
  clearInput(): void
  invokeLocal(slash: SlashInfo): void | Promise<void>
  reportLocalError(err: unknown): void
  invokeServerCommand(cmd: string, args: string): void
  invokeProviderPrompt(inputText: string): void
}

export interface SlashDispatchOptions {
  inputText: string
  localSlashes: SlashInfo[]
  serverCommandNames: ReadonlySet<string>
  callbacks: SlashDispatchCallbacks
}

export interface LocalInputOptions {
  inputText: string
  shellMode: boolean
  localSlashes: SlashInfo[]
  bang?: (command: string) => void | Promise<void>
  callbacks: Pick<SlashDispatchCallbacks, "clearInput" | "invokeLocal" | "reportLocalError">
}

function normalizeSlash(text: string): { slash: string; rest: string } | null {
  const firstLineEnd = text.indexOf("\n")
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd)
  const trimmed = firstLine.trim()
  if (!trimmed.startsWith("/")) return null
  const parts = trimmed.split(/\s+/)
  const token = parts[0]
  if (token.length <= 1) return null
  const slash = token.slice(1)
  const firstLineArgs = parts.slice(1).join(" ")
  const restOfInput = firstLineEnd === -1 ? "" : text.slice(firstLineEnd + 1)
  const rest = firstLineArgs + (restOfInput ? "\n" + restOfInput : "")
  return { slash, rest }
}

function findLocalSlash(slashes: SlashInfo[], token: string): SlashInfo | null {
  for (const s of slashes) {
    const name = s.display.startsWith("/") ? s.display.slice(1) : s.display
    if (name === token) return s
    if (s.aliases?.includes("/" + token) || s.aliases?.includes(token)) return s
  }
  return null
}

export function dispatchLocalInput(opts: LocalInputOptions): boolean {
  const bang = opts.bang && (opts.shellMode || opts.inputText.startsWith("!"))
  if (bang) {
    const command = opts.shellMode ? opts.inputText : opts.inputText.slice(1)
    opts.callbacks.clearInput()
    Promise.resolve()
      .then(() => opts.bang!(command))
      .catch((err) => opts.callbacks.reportLocalError(err))
    return true
  }

  const normalized = normalizeSlash(opts.inputText)
  if (!normalized) return false
  const slash = findLocalSlash(opts.localSlashes, normalized.slash)
  if (!slash) return false
  opts.callbacks.clearInput()
  Promise.resolve()
    .then(() => opts.callbacks.invokeLocal(slash))
    .catch((err) => opts.callbacks.reportLocalError(err))
  return true
}

export function dispatchSlashCommand(opts: SlashDispatchOptions): void {
  const { inputText, localSlashes, serverCommandNames, callbacks } = opts

  const normalized = normalizeSlash(inputText)
  if (!normalized) {
    callbacks.invokeProviderPrompt(inputText)
    return
  }

  const { slash, rest } = normalized

  // Resolve local slash from command registry (includes aliases)
  const local = iife(() => findLocalSlash(localSlashes, slash))

  if (local) {
    callbacks.clearInput()
    Promise.resolve()
      .then(() => {
        try {
          return callbacks.invokeLocal(local)
        } catch (err) {
          return Promise.reject(err)
        }
      })
      .catch((err) => callbacks.reportLocalError(err))
    return
  }

  // Server command
  if (serverCommandNames.has(slash)) {
    callbacks.invokeServerCommand(slash, rest)
    return
  }

  // Unknown slash - falls through to provider prompt (existing product behavior)
  callbacks.invokeProviderPrompt(inputText)
}
