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

// kilocode_change start
const inFlight = new Map<string, Set<string>>()
const log = Log.create({ service: "tool.task" })
// kilocode_change end

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

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

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => Permission.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents
  const list = accessibleAgents.toSorted((a, b) => a.name.localeCompare(b.name))

  const description = DESCRIPTION.replace(
    "{agents}",
    list
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
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

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
      // kilocode_change start — reject primary agents; only subagent/all modes allowed
      if (agent.mode === "primary")
        throw new Error(`Agent "${params.subagent_type}" is a primary agent and cannot be used as a subagent`)
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

      // kilocode_change start — inherit edit and bash restrictions from the calling agent so
      // sub-agents cannot perform actions the parent agent is not allowed to perform.
      // We merge the static agent definition with the current session's accumulated permissions
      // so that restrictions survive multi-hop chains (plan → general → explore).
      // Agent.get() gives the base definition; session.permission carries restrictions that
      // were themselves inherited from a grandparent, so both sources are needed.
      const caller = await Agent.get(ctx.agent)
      const callerSession = await Session.get(ctx.sessionID)
      const callerRules = Permission.merge(caller?.permission ?? [], callerSession.permission ?? [])
      // Build the set of MCP server prefixes (e.g. "servername_") so we can
      // include both server-wide wildcards ("servername_*") and specific MCP tool
      // permissions ("servername_create_issue") in the inherited ruleset.
      // Same sanitisation logic as agent.ts.
      const mcpPrefixes = Object.keys(config.mcp ?? {}).map((k) => k.replace(/[^a-zA-Z0-9_-]/g, "_") + "_")
      const isMcpRule = (p: string) => mcpPrefixes.some((prefix) => p.startsWith(prefix))
      const inherited = callerRules.filter(
        (r) => r.permission === "edit" || r.permission === "bash" || isMcpRule(r.permission),
      )
      // kilocode_change end
      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
      const hasTodoWritePermission = agent.permission.some((rule) => rule.permission === "todowrite")

      const session = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: [
            ...(hasTodoWritePermission
              ? []
              : [
                  {
                    permission: "todowrite" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            // kilocode_change start — unconditionally deny task for all subagent sessions
            { permission: "task", pattern: "*", action: "deny" },
            // kilocode_change end
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
            ...inherited, // kilocode_change — propagate caller's edit and bash restrictions
          ],
        })
      })
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

          return SessionPrompt.prompt({
            messageID,
            sessionID: session.id,
            model: {
              modelID: model.modelID,
              providerID: model.providerID,
            },
            agent: agent.name,
            tools: {
              ...(hasTodoWritePermission ? {} : { todowrite: false }),
              ...(hasTaskPermission ? {} : { task: false }),
              ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((tool) => [tool, false])),
            },
            parts: promptParts,
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
})
