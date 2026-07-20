// kilocode_change - new file
import { Instance } from "@/project/instance"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage/db"
import { Storage } from "@/storage/storage"
import z from "zod"

export namespace AuthorityStore {
  const Rules = z
    .object({
      permission: z.string(),
      pattern: z.string(),
      action: z.enum(["allow", "deny", "ask"]),
    })
    .strict()
    .array()

  export const Layer = z
    .object({
      kind: z.enum(["role", "config", "session", "control"]),
      sourceSessionID: SessionID.zod,
      rules: Rules,
    })
    .strict()
  export type Layer = z.infer<typeof Layer>

  const Record = z
    .object({
      childSessionID: SessionID.zod,
      parentSessionID: SessionID.zod,
      layers: Layer.array(),
    })
    .strict()
  export type Record = z.infer<typeof Record>

  const cache = Instance.state(
    () => new Map<SessionID, Record>(),
    async (current) => {
      current.clear()
    },
  )

  const key = (sessionID: SessionID) => ["authority", Instance.project.id, sessionID]
  const copy = (record: Record) => structuredClone(record)

  function bound(record: Record) {
    const parent = Database.use((db) =>
      db
        .select({ parentID: SessionTable.parent_id, projectID: SessionTable.project_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, record.childSessionID))
        .get(),
    )
    if (!parent || parent.parentID !== record.parentSessionID || parent.projectID !== Instance.project.id) {
      throw new Error(`Authority parent mismatch for child session ${record.childSessionID}`)
    }
    return record
  }

  export async function create(input: Record) {
    const record = bound(Record.parse(input))
    const existing = await Storage.read<unknown>(key(record.childSessionID)).catch((err) => {
      if (Storage.NotFoundError.isInstance(err)) return undefined
      throw err
    })
    if (existing !== undefined) {
      throw new Error(`Authority already exists for child session ${record.childSessionID}`)
    }
    await Storage.write(key(record.childSessionID), record)
    cache().set(record.childSessionID, record)
    return copy(record)
  }

  export async function load(sessionID: SessionID) {
    const hit = cache().get(sessionID)
    if (hit) return copy(hit)
    const record = await Storage.read<unknown>(key(sessionID))
      .then(Record.parse)
      .then(bound)
      .catch((err) => {
        if (Storage.NotFoundError.isInstance(err)) return undefined
        throw err
      })
    if (record) cache().set(sessionID, record)
    return record ? copy(record) : undefined
  }

  export async function loadForExecution(sessionID: SessionID) {
    const hit = cache().get(sessionID)
    if (hit) return copy(hit)
    const session = await Session.get(sessionID)
    const isChild = session.parentID !== undefined
    const record = await Storage.read<unknown>(key(sessionID))
      .then(Record.parse)
      .then(bound)
      .catch((err) => {
        if (Storage.NotFoundError.isInstance(err)) {
          if (isChild) {
            throw new Error(`Missing authority record for delegated child session ${sessionID}`)
          }
          return undefined
        }
        throw new Error(
          `Authority storage read failed for session ${sessionID}: ${err instanceof Error ? err.message : String(err)}`,
        )
      })
    if (record) cache().set(sessionID, record)
    return record ? copy(record) : undefined
  }

  export async function narrow(input: { childSessionID: SessionID; parentSessionID: SessionID; layers: Layer[] }) {
    const current = await load(input.childSessionID)
    if (!current) throw new Error(`Missing trusted authority for child session ${input.childSessionID}`)
    if (current.parentSessionID !== input.parentSessionID) {
      throw new Error(`Authority parent mismatch for child session ${input.childSessionID}`)
    }
    const record = bound(
      Record.parse({
        ...current,
        layers: [...current.layers, ...input.layers],
      }),
    )
    await Storage.write(key(record.childSessionID), record)
    cache().set(record.childSessionID, record)
    return copy(record)
  }

  export function get(sessionID: SessionID) {
    const record = cache().get(sessionID)
    return record ? copy(record) : undefined
  }

  /** @internal Clears only the process cache so persistence/reload can be tested. */
  export function clear() {
    cache().clear()
  }
}
