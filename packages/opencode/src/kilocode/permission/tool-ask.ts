// kilocode_change - new file
import { Permission } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { DelegatedEdit } from "@/kilocode/delegated-edit"
import { CapabilityAuthority } from "@/kilocode/capability/authority"
import { OwnershipAudit } from "./ownership-audit"

export namespace ToolAsk {
  export function build(input: {
    sessionID: SessionID
    messageID: MessageID
    callID: string
    agentID?: string
    operation?: string
    role?: Permission.Ruleset
    agent: Permission.Ruleset
    session: Permission.Ruleset
  }): {
    ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) => Promise<void>
  } {
    return {
      async ask(req) {
        const correlationID = Permission.correlation({
          sessionID: input.sessionID,
          messageID: input.messageID,
          callID: input.callID,
        })
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
          if (delegated) {
            for (const pattern of req.patterns) {
              Permission.trace(CapabilityAuthority.delegated({ permission: req.permission, pattern, correlationID }))
            }
            return
          }
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
        if (input.agentID) {
          await OwnershipAudit.record({
            role: input.agentID,
            sessionID: input.sessionID,
            permission: req.permission,
            patterns: req.patterns,
          })
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
