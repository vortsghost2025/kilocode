// kilocode_change - new file
import { createSignal, onMount, Show } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { DialogSelect } from "@tui/ui/dialog-select"
import { indexingEnabledPatch, indexingProviderPatch, getProviderOptions } from "@/kilocode/indexing-settings"

const providerOptions = getProviderOptions()

function providerTitle(v: string): string {
  if (v === "openai-compatible") return "OpenAI Compatible"
  return v.charAt(0).toUpperCase() + v.slice(1)
}

export function DialogIndexing() {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  const toast = useToast()

  const [enabled, setEnabled] = createSignal(false)
  const [provider, setProvider] = createSignal<string>("openai")
  const [active, setActive] = createSignal<"enabled" | "provider">("enabled")
  const [loaded, setLoaded] = createSignal(false)
  const [saving, setSaving] = createSignal(false)

  onMount(async () => {
    dialog.setSize("medium")
    // global.config.get persists to the active XDG profile so settings survive restart.
    const res = await sdk.client.global.config.get()
    if (res.data) {
      const idx = (res.data as any).indexing ?? {}
      setEnabled(!!idx.enabled)
      if (typeof idx.provider === "string") setProvider(idx.provider)
    }
    setLoaded(true)
  })

  async function persistEnabled(next: boolean): Promise<boolean> {
    if (saving()) return false
    setSaving(true)
    try {
      const result = await sdk.client.global.config.update({ config: indexingEnabledPatch(next) as any })
      if (result.error) {
        toast.show({ variant: "error", message: "Failed to save indexing setting" })
        return false
      }
      setEnabled(next)
      return true
    } finally {
      setSaving(false)
    }
  }

  async function persistProvider(next: string): Promise<boolean> {
    if (saving()) return false
    setSaving(true)
    try {
      const result = await sdk.client.global.config.update({ config: indexingProviderPatch(next) as any })
      if (result.error) {
        toast.show({ variant: "error", message: "Failed to save indexing provider" })
        return false
      }
      setProvider(next)
      return true
    } finally {
      setSaving(false)
    }
  }

  async function toggleEnabled() {
    if (saving()) return
    await persistEnabled(!enabled())
  }

  function openProviderSelect() {
    if (saving()) return
    dialog.replace(() => (
      <DialogSelect
        title="Indexing provider"
        options={providerOptions}
        current={provider()}
        onSelect={(opt) => {
          opt.onSelect?.(dialog)
          void persistProvider(opt.value).then((ok) => {
            if (ok) dialog.replace(() => <DialogIndexing />)
          })
        }}
      />
    ))
  }

  useKeyboard((evt) => {
    if (evt.name === "tab") {
      setActive((prev) => (prev === "enabled" ? "provider" : "enabled"))
      evt.preventDefault()
      return
    }
    if (evt.name === "space" || evt.name === " ") {
      if (active() === "enabled") void toggleEnabled()
      evt.preventDefault()
      return
    }
    if (evt.name === "return") {
      if (active() === "provider") openProviderSelect()
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
            onMouseUp={() => {
              setActive("enabled")
              void toggleEnabled()
            }}
          >
            <text fg={active() === "enabled" ? theme.primary : theme.textMuted}>{enabled() ? "[x]" : "[ ]"}</text>
            <text fg={active() === "enabled" ? theme.primary : theme.text}>Enabled</text>
          </box>
          <box
            flexDirection="row"
            gap={2}
            paddingLeft={1}
            backgroundColor={active() === "provider" ? theme.backgroundElement : undefined}
            onMouseUp={() => {
              setActive("provider")
              openProviderSelect()
            }}
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
