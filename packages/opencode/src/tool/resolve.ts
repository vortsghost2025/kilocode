// kilocode_change - new file
import { Permission } from "@/permission"

export function filterResolvedTools<T>(input: {
  tools: Record<string, T>
  agent: Permission.Ruleset
  session?: Permission.Ruleset
  user?: Record<string, boolean>
}) {
  const disabled = Permission.disabled(Object.keys(input.tools), Permission.merge(input.agent, input.session ?? []))
  const tools = { ...input.tools }
  for (const id of Object.keys(tools)) {
    if (input.user?.[id] === false || disabled.has(id)) delete tools[id]
  }
  return tools
}
