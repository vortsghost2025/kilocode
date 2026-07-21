import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { Permission } from "@/permission"
import { ForegroundTask } from "@/kilocode/foreground-task" // kilocode_change
import { Log } from "@/util/log" // kilocode_change
import { DelegatedEdit } from "@/kilocode/delegated-edit" // kilocode_change
import { CapabilityAuthority } from "@/kilocode/capability/authority" // kilocode_change
import { AuthorityStore } from "@/kilocode/capability/authority-store" // kilocode_change

// kilocode_change start
const inFlight = new Map<string, Set<string>>()
const log = Log.create({ service: "tool.task" })
// kilocode_change end

// kilocode_change start - express optional call metadata as exact variants so
// schema normalizers cannot promote every declared property to required.
const shape = {
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
}
const resume = z
  .string()
  .describe(
    "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  )
const command = z.string().describe("The command that triggered this task")
const parameters = z
  .union([
    z.object(shape).strict(),
    z.object({ ...shape, task_id: resume }).strict(),
    z.object({ ...shape, command }).strict(),
    z.object({ ...shape, task_id: resume, command }).strict(),
  ])
  .meta({ type: "object" })
type Params = z.infer<typeof parameters> & { authorization?: DelegatedEdit.Authorization }
// kilocode_change end

// kilocode_change start
type ForegroundOutcome =
  | {
      type: "completed"
      message: MessageV2.WithParts
    }
  | {
      type: "interrupted"
    }
  | {
      type: "timed_out"
    }
// kilocode_change end

// kilocode_change - public task and private delegated-edit launch share execution, not schemas
async function build(ctx?: Tool.InitContext) {
  // kilocode_change
  // kilocode_change start
  const agents = await Agent.list().then((x) =>
    x.filter((a) => a.mode !== "primary" && a.name !== "phase2f-implementer"),
  )
  // kilocode_change end

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  // kilocode_change start - inherited task ceilings also constrain the agent
  // names serialized into the TaskTool description.
  const accessibleAgents = caller
    ? agents.filter(
        (a) =>
          CapabilityAuthority.evaluate({
            permission: "task",
            pattern: a.name,
            role: ctx.role,
            agent: caller.permission,
            session: ctx.permission,
            sessionID: ctx.sessionID,
          }).action !== "deny",
      )
    : agents
  // kilocode_change end
  const list = accessibleAgents.toSorted((a, b) => a.name.localeCompare(b.name))

  const description = DESCRIPTION.replace(
    "{agents}",
    list
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    async execute(params: Params, ctx: Tool.Context) {
      const config = await Config.get()
      const phase = params.subagent_type === "phase2f-implementer" // kilocode_change
      const resume = "task_id" in params ? params.task_id : undefined // kilocode_change
      const grant = "authorization" in params ? params.authorization : undefined // kilocode_change

      // kilocode_change start - Phase2F is reachable only through the typed
      // delegate_edit tool, which creates this private authorization object.
      if (phase && !grant) {
        throw DelegatedEdit.invalid("use the delegate_edit tool; task cannot issue edit leases")
      }
      if (grant && !phase) {
        throw new DelegatedEdit.AuthorizationError({
          operation: grant.operation,
          path: grant.path,
          reason: "authorization is restricted to Phase2F implementation tasks",
        })
      }
      if (phase && ctx.agent !== "orchestrator") {
        throw new DelegatedEdit.AuthorizationError({
          operation: grant!.operation,
          path: grant!.path,
          reason: "only Orchestrator may authorize Phase2F implementation tasks",
        })
      }
      if (grant && resume) {
        throw new DelegatedEdit.AuthorizationError({
          operation: grant.operation,
          path: grant.path,
          reason: "delegated edit authorization cannot resume an existing task",
        })
      }
      if (grant && !ctx.callID) {
        throw new DelegatedEdit.AuthorizationError({
          operation: grant.operation,
          path: grant.path,
          reason: "delegated edit authorization requires a tool call ID",
        })
      }
      // kilocode_change end

      // kilocode_change start - preserve the real caller identity and all
      // persisted narrowing layers at both invocation and child construction.
      const caller = await Agent.get(ctx.agent)
      const policy = await Agent.policy(ctx.agent)
      const callerRole = policy.length > 0 ? policy : (caller?.permission ?? [])
      const callerSession = await Session.get(ctx.sessionID)
      await AuthorityStore.load(ctx.sessionID)
      // kilocode_change end

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
      const selectedPolicy = await Agent.policy(agent.name) // kilocode_change
      const selectedRole = selectedPolicy.length > 0 ? selectedPolicy : agent.permission // kilocode_change
      // kilocode_change start — reject primary agents; only subagent/all modes allowed
      if (agent.mode === "primary")
        throw new Error(`Agent "${params.subagent_type}" is a primary agent and cannot be used as a subagent`)
      // kilocode_change end

      // kilocode_change start — canonicalize and validate delegated authority
      // before permission prompts, child creation, or worker request launch.
      const authorization = grant
        ? (() => {
            const scope = DelegatedEdit.scope(grant)
            if (
              CapabilityAuthority.evaluate({
                permission: "edit",
                pattern: scope.path,
                role: selectedRole,
                agent: agent.permission,
              }).action !== "allow"
            ) {
              throw new DelegatedEdit.AuthorizationError({
                operation: scope.operation,
                path: scope.path,
                reason: `agent "${agent.name}" does not allow delegated edits`,
              })
            }
            return scope
          })()
        : undefined
      const reservation = authorization
        ? DelegatedEdit.reserve({ parent: ctx.sessionID, call: ctx.callID!, scope: authorization })
        : undefined
      using _reservation = reservation ? defer(() => DelegatedEdit.release(reservation)) : undefined
      // kilocode_change end

      // Skip permission check when user explicitly invoked via @ or command subtask
      // kilocode_change start
      if (authorization) {
        await ctx.ask({
          permission: "delegate_edit",
          patterns: [agent.name],
          always: [],
          metadata: {
            description: params.description,
            subagent_type: agent.name,
            operation: authorization.operation,
            path: authorization.path,
          },
        })
      } else if (ctx.extra?.bypassAgentCheck) {
        // A direct user mention may satisfy an ask, but
        // it is not authority to cross the caller's static or inherited deny.
        const rule = CapabilityAuthority.evaluate({
          permission: "task",
          pattern: params.subagent_type,
          role: callerRole,
          agent: caller?.permission ?? [],
          session: callerSession.permission,
          sessionID: ctx.sessionID,
        })
        if (rule.action === "deny") {
          throw new Permission.DeniedError({
            ruleset: Permission.merge(caller?.permission ?? [], callerSession.permission ?? []),
          })
        }
      } else {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }
      // kilocode_change end

      // kilocode_change start
      const sessionKey = ctx.sessionID
      const seen = inFlight.get(sessionKey) ?? new Set<string>()
      if (seen.has(params.subagent_type)) {
        throw new Error(
          `Routing bug: subagent "${params.subagent_type}" was already dispatched in this session ` +
            `(${sessionKey}). Parallel batches must use distinct agent types.`,
        )
      }
      seen.add(params.subagent_type)
      inFlight.set(sessionKey, seen)

      using _inflight = defer(() => {
        const current = inFlight.get(sessionKey)
        if (current) {
          current.delete(params.subagent_type)
          if (current.size === 0) inFlight.delete(sessionKey)
        }
      })
      // kilocode_change end

      // kilocode_change start - persist every parent authority layer as a
      // restrictive ceiling. The selected child policy remains its own static
      // ceiling, and verified delegated-edit leases stay outside this ordinary
      // intersection so only their exact EditTool call can cross it.
      const inherited = CapabilityAuthority.inherit({
        role: callerRole,
        agent: caller?.permission ?? [],
        session: callerSession.permission,
        source: ctx.sessionID,
      })
      // kilocode_change end
      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
      const hasTodoWritePermission = agent.permission.some((rule) => rule.permission === "todowrite")
      // kilocode_change start - control rules and parent ceilings are applied
      // identically to new and resumed child sessions.
      const restrictions: Permission.Ruleset = [
        ...(hasTodoWritePermission ? [] : [{ permission: "todowrite", pattern: "*", action: "deny" as const }]),
        ...(hasTaskPermission ? [] : [{ permission: "task", pattern: "*", action: "deny" as const }]),
        { permission: "task", pattern: "*", action: "deny" as const },
        { permission: "background_task", pattern: "*", action: "deny" as const },
        ...(config.experimental?.primary_tools?.map((tool) => ({
          pattern: "*",
          action: "allow" as const,
          permission: tool,
        })) ?? []),
      ]
      const controlRules: Permission.Ruleset = []
      if (!hasTodoWritePermission) {
        controlRules.push({ permission: "todowrite", pattern: "*", action: "deny" })
      }
      if (!hasTaskPermission) {
        controlRules.push({ permission: "task", pattern: "*", action: "deny" })
      }
      controlRules.push({ permission: "task", pattern: "*", action: "deny" })
      controlRules.push({ permission: "background_task", pattern: "*", action: "deny" })
      const layers: AuthorityStore.Layer[] = [
        ...inherited,
        { kind: "control", sourceSessionID: ctx.sessionID, rules: controlRules },
      ]
      // kilocode_change end

      const session = await iife(async () => {
        // kilocode_change start
        if (resume) {
          const found = await Session.get(SessionID.make(resume)).catch(() => undefined)
          if (found) {
            if (found.parentID !== ctx.sessionID) throw new Error("Cannot resume a task outside its parent session")
            const permission = Permission.merge(found.permission ?? [], restrictions)
            found.permission = permission
            await Session.setPermission({ sessionID: found.id, permission })
            await AuthorityStore.narrow({
              childSessionID: found.id,
              parentSessionID: ctx.sessionID,
              layers,
            })
            return found
          }
        }
        // kilocode_change end

        // kilocode_change start
        const child = await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: restrictions, // kilocode_change - selected policy without ceiling tags
        })
        await AuthorityStore.create({
          childSessionID: child.id,
          parentSessionID: ctx.sessionID,
          layers: [
            ...layers,
            { kind: "role", sourceSessionID: child.id, rules: selectedRole },
            { kind: "config", sourceSessionID: child.id, rules: agent.permission },
          ],
        })
        return child
        // kilocode_change end
      })
      // kilocode_change start — bind and persist the edit lease before the child prompt starts
      const binding = reservation ? DelegatedEdit.bind(reservation, session.id) : undefined
      using _authorization = binding ? defer(binding.release) : undefined
      if (binding) {
        const permission = Permission.merge(session.permission ?? [], DelegatedEdit.rules(binding.lease))
        session.permission = permission
        await Session.setPermission({ sessionID: session.id, permission })
      }
      // kilocode_change end
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      // kilocode_change start - include interrupted flag in task metadata
      const meta = {
        sessionId: session.id,
        model,
        interrupted: false,
      }
      // kilocode_change end

      ctx.metadata({
        title: params.description,
        metadata: meta,
      })

      // kilocode_change start
      const messageID = MessageID.ascending()
      const gate = {
        done: false,
        unregister: () => {},
      }

      const finish = (action: () => void) => {
        if (gate.done) return
        gate.done = true
        gate.unregister()
        action()
      }

      const cancelChild = () => {
        void SessionPrompt.cancel(session.id).catch((error) => {
          log.warn("failed to cancel foreground child", { sessionID: session.id, error })
        })
      }

      ctx.abort.addEventListener("abort", cancelChild)
      using _cancelListener = defer(() => {
        ctx.abort.removeEventListener("abort", cancelChild)
      })

      const outcome = await new Promise<ForegroundOutcome>((resolve, reject) => {
        gate.unregister = ForegroundTask.register(session.projectID, session.id, {
          interrupt() {
            finish(() => resolve({ type: "interrupted" }))
          },
          timeout() {
            cancelChild()
            finish(() => resolve({ type: "timed_out" }))
          },
          complete(message) {
            finish(() => resolve({ type: "completed", message }))
          },
        })

        if (ctx.abort.aborted) {
          cancelChild()
          return
        }

        const childPromise = (async () => {
          const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

          if (gate.done) return undefined

          // kilocode_change start — Phase2F evidence-recall pilot: prepend the
          // canonical delegated-edit-lease text so the child agent can quote
          // it verbatim in evidenceRecall.exactText. Without this preamble the
          // worker would have to guess the exact format and surface.
          const finalParts =
            phase && binding
              ? [
                  {
                    type: "text" as const,
                    text:
                      "<delegated_edit_lease>\n" +
                      DelegatedEdit.canonicalLeaseText(binding.lease) +
                      "\n</delegated_edit_lease>\n\n" +
                      `When you call the ${binding.lease.scope.operation} tool for the authorized path, you MUST include an evidenceRecall object whose source is "delegated-edit-lease" and whose exactText reproduces the lease text above character-for-character (the single block between the <delegated_edit_lease> tags). Do not omit it; do not paraphrase. A missing or mismatched evidenceRecall will fail closed with EVIDENCE_RECALL_FAILED before your mutation is applied.`,
                  },
                  ...promptParts,
                ]
              : promptParts
          // kilocode_change end

          return SessionPrompt.prompt({
            messageID,
            sessionID: session.id,
            model: {
              modelID: model.modelID,
              providerID: model.providerID,
            },
            agent: agent.name,
            tools: {
              // kilocode_change start — Phase2F exposes only the exact leased
              // mutation operation and delegates path validation.
              ...(phase
                ? {
                    bash: false,
                    write: false,
                    apply_patch: false,
                    ...(authorization?.operation === "populate" ? { edit: false } : { populate: false }),
                  }
                : authorization
                  ? { write: false, apply_patch: false }
                  : {}),
              // kilocode_change end
              ...(hasTodoWritePermission ? {} : { todowrite: false }),
              ...(hasTaskPermission ? {} : { task: false }),
              ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((tool) => [tool, false])),
            },
            parts: finalParts,
          })
        })()

        childPromise.then(
          (message) => {
            if (!message) return
            finish(() => resolve({ type: "completed", message }))
          },
          (error) => {
            finish(() => reject(error))
          },
        )
      })

      if (outcome.type !== "completed") {
        const timedOut = outcome.type === "timed_out"
        return {
          title: params.description,
          metadata: {
            ...meta,
            interrupted: !timedOut,
            ...(timedOut ? { timedOut: true } : {}),
          },
          output: [
            `task_id: ${session.id} (for resuming to continue this task if needed)`,
            "",
            "<task_result>",
            timedOut
              ? "[Task timed out after producing no progress. Resume with the same task_id above to continue.]"
              : "[Task was interrupted. Resume with the same task_id above to continue.]",
            "</task_result>",
          ].join("\n"),
        }
      }

      const result = outcome.message
      const error = result.info?.role === "assistant" ? result.info.error : undefined
      const detail = error
        ? "message" in error.data && typeof error.data.message === "string"
          ? error.data.message
          : error.name
        : ""
      const status =
        error && "statusCode" in error.data && typeof error.data.statusCode === "number"
          ? ` (HTTP ${error.data.statusCode})`
          : ""
      const failure = error ? `[Subagent failed${status}: ${detail}]` : ""
      const text = result.parts.findLast((part) => part.type === "text")?.text || failure
      // kilocode_change end

      const output = [
        `task_id: ${session.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        text,
        "</task_result>",
      ].join("\n")

      return {
        title: params.description,
        metadata: meta,
        output,
      }
    },
  }
}

// kilocode_change start
export async function runDelegatedEdit(
  params: { description: string; prompt: string; authorization: DelegatedEdit.Authorization },
  ctx: Tool.Context,
) {
  const tool = await build()
  return tool.execute({ ...params, subagent_type: "phase2f-implementer" }, ctx)
}

export const TaskTool = Tool.define("task", async (ctx) => ({ ...(await build(ctx)), parameters }))
// kilocode_change end
