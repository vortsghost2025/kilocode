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
        const evidence =
          req.metadata && typeof req.metadata.evidenceRecall === "object" && req.metadata.evidenceRecall !== null
            ? (req.metadata.evidenceRecall as DelegatedEdit.EvidenceRecall)
            : undefined
        try {
          const delegated = DelegatedEdit.authorize({
            sessionID: input.sessionID,
            operation: input.operation,
            permission: req.permission,
            patterns: req.patterns,
            session: input.session,
            evidence,
          })
          if (delegated) return
        } catch (err) {
          // Lease exhaustion must propagate so the error message reaches the
          // tool part and the test can assert the deterministic message.
          if (err instanceof DelegatedEdit.LeaseExhaustedError) throw err
          // EvidenceFailedError is caught here and re-thrown as a
          // Permission.DeniedError (using the input ruleset) because the AI SDK
          // does not include non-provider-executed tool-errors in subsequent
          // LLM requests, which causes the LLM loop to stall. Permission.DeniedError
          // is handled correctly by the SDK as a tool-error that continues the loop.
          // The consumed flag was not touched (evidence check happens before
          // consumption), so the grant can be consumed on a subsequent retry.
          throw new Permission.DeniedError({ ruleset: input.session })
        }
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
