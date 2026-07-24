// kilocode_change - new file
import { createSignal, onMount, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { DialogSelect } from "@tui/ui/dialog-select"
import { IndexingConfig } from "@kilocode/kilo-indexing/config"

function getProviderOptions() {
  const field = IndexingConfig.shape.provider
  const innerType = (field as any)._def.innerType ?? field
  const values = (innerType._def.values ?? []) as string[]
  return values.map((v) => ({
    title: v === "openai-compatible" ? "OpenAI Compatible" : v.charAt(0).toUpperCase() + v.slice(1),
    value: v,
  }))
}

const providerOptions = getProviderOptions()

function providerTitle(v: string): string {
  if (v === "openai-compatible") return "OpenAI Compatible"
  return v.charAt(0).toUpperCase() + v.slice(1)
}

export function DialogIndexing() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  const toast = useToast()

  const [enabled, setEnabled] = createSignal(false)
  const [provider, setProvider] = createSignal<string>("openai")
  const [active, setActive] = createSignal<"enabled" | "provider">("enabled")
  const [loaded, setLoaded] = createSignal(false)

  onMount(async () => {
    dialog.setSize("medium")
    const res = await sdk.client.config.get()
    if (res.data) {
      const idx = (res.data as any).indexing ?? {}
      setEnabled(!!idx.enabled)
      if (typeof idx.provider === "string") setProvider(idx.provider)
    }
    setLoaded(true)
  })

  async function persistEnabled(next: boolean) {
    const res = await sdk.client.config.get()
    const current = res.data as any
    const result = await sdk.client.config.update({
      config: {
        ...current,
        indexing: {
          ...(current?.indexing ?? {}),
          enabled: next,
        },
      } as any,
    })
    if (result.error) {
      toast.show({ variant: "error", message: "Failed to save indexing setting" })
      return
    }
    setEnabled(next)
  }

  async function persistProvider(next: string) {
    const res = await sdk.client.config.get()
    const current = res.data as any
    const result = await sdk.client.config.update({
      config: {
        ...current,
        indexing: {
          ...(current?.indexing ?? {}),
          provider: next,
        },
      } as any,
    })
    if (result.error) {
      toast.show({ variant: "error", message: "Failed to save indexing provider" })
      return
    }
    setProvider(next)
  }

  useKeyboard((evt) => {
    if (evt.name === "tab") {
      setActive((prev) => (prev === "enabled" ? "provider" : "enabled"))
      evt.preventDefault()
    }
    if (evt.name === "space" || evt.name === " ") {
      if (active() === "enabled") {
        persistEnabled(!enabled())
      }
      evt.preventDefault()
    }
    if (evt.name === "return") {
      if (active() === "provider") {
        dialog.replace(() => (
          <DialogSelect
            title="Indexing provider"
            options={providerOptions}
            current={provider()}
            onSelect={(opt) => {
              persistProvider(opt.value)
              dialog.replace(() => <DialogIndexing />)
            }}
          />
        ))
      }
      evt.preventDefault()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Codebase Indexing
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.textMuted}>Builds a local semantic index of the current codebase for semantic search.</text>
      <Show when={loaded()}>
        <box flexDirection="column" gap={1} paddingTop={1}>
          <box
            flexDirection="row"
            gap={2}
            paddingLeft={1}
            backgroundColor={active() === "enabled" ? theme.backgroundElement : undefined}
            onMouseUp={() => setActive("enabled")}
          >
            <text fg={active() === "enabled" ? theme.primary : theme.textMuted}>{enabled() ? "[x]" : "[ ]"}</text>
            <text fg={active() === "enabled" ? theme.primary : theme.text}>Enabled</text>
          </box>
          <box
            flexDirection="row"
            gap={2}
            paddingLeft={1}
            backgroundColor={active() === "provider" ? theme.backgroundElement : undefined}
            onMouseUp={() => setActive("provider")}
          >
            <text fg={active() === "provider" ? theme.primary : theme.textMuted}>{`\u2192`}</text>
            <text fg={active() === "provider" ? theme.primary : theme.text}>Provider: {providerTitle(provider())}</text>
          </box>
        </box>
        <text fg={theme.textMuted} paddingTop={1}>
          Press space to toggle, tab to switch field, return to open provider list
        </text>
      </Show>
    </box>
  )
}
