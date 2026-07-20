// kilocode_change - new file
import { Permission } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { DelegatedEdit } from "@/kilocode/delegated-edit"

export namespace ToolAsk {
  export function build(input: {
    sessionID: SessionID
    messageID: MessageID
    callID: string
    operation?: string
    role?: Permission.Ruleset
    agent: Permission.Ruleset
    session: Permission.Ruleset
  }): {
    ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) => Promise<void>
  } {
    return {
      async ask(req) {
        const delegated = DelegatedEdit.authorize({
          sessionID: input.sessionID,
          operation: input.operation,
          permission: req.permission,
          patterns: req.patterns,
          session: input.session,
        })
        if (delegated) return
        await Permission.ask(
          {
            ...req,
            sessionID: input.sessionID,
            tool: { messageID: input.messageID, callID: input.callID },
            ruleset: input.agent,
            narrow: input.session,
          },
          input.role,
        )
      },
    }
  }
}
