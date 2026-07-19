import type { AssistantMessage } from "@kilocode/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@kilocode/plugin/tui"
import { createMemo, Show } from "solid-js"
// kilocode_change
import { formatCacheMetrics } from "@/kilocode/tui/cache-visibility"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const cost = createMemo(() => msg().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0))

  // kilocode_change start
  const cache = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last || (last.tokens.cache.read === 0 && last.tokens.cache.write === 0)) return

    const model = props.api.state.provider.find((x) => x.id === last.providerID)?.models[last.modelID]
    return {
      read: last.tokens.cache.read,
      write: last.tokens.cache.write,
      metrics: formatCacheMetrics(last.tokens.input, last.tokens.cache.read, last.tokens.cache.write, model?.cost),
    }
  })
  // kilocode_change end

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
      {/* kilocode_change start */}
      <Show when={cache()}>
        {(c) => (
          <>
            <text fg={theme().textMuted}>Cache read: {c().read.toLocaleString()}</text>
            <text fg={theme().textMuted}>Cache write: {c().write.toLocaleString()}</text>
            <Show when={c().metrics.share}>
              <text fg={theme().textMuted}>Cached input share: {c().metrics.share}</text>
            </Show>
            <Show when={c().metrics.savings}>
              <text fg={theme().textMuted}>Estimated cache-read savings: {money.format(c().metrics.savings!)}</text>
            </Show>
          </>
        )}
      </Show>
      {/* kilocode_change end */}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
