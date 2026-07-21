// kilocode_change - new file
import { Permission } from "@/permission"
import { CapabilityAuthority } from "@/kilocode/capability/authority"

export function filterResolvedTools<T>(input: {
  tools: Record<string, T>
  role?: Permission.Ruleset
  agent: Permission.Ruleset
  session?: Permission.Ruleset
  sessionID?: import("@/session/schema").SessionID
  user?: Record<string, boolean>
  delegatedEdit?: import("@/kilocode/delegated-edit").DelegatedEdit.Scope
}) {
  const disabled = CapabilityAuthority.disabled({
    tools: Object.keys(input.tools),
    role: input.role,
    agent: input.agent,
    session: input.session,
    sessionID: input.sessionID,
  })
  const tools = { ...input.tools }
  for (const id of Object.keys(tools)) {
    const leased = id === input.delegatedEdit?.operation
    if (input.user?.[id] === false || (disabled.has(id) && !leased)) delete tools[id]
  }
  return tools
}
