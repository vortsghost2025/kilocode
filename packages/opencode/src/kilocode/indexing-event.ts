import { INDEXING_STATUS_STATES } from "@kilocode/kilo-indexing/status"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { INDEXING_WARNING_CODES } from "./indexing-warning"

export const Event = BusEvent.define(
  "indexing.status",
  z.object({
    status: z.object({
      state: z.enum(INDEXING_STATUS_STATES),
      message: z.string(),
      processedFiles: z.number().int().nonnegative(),
      totalFiles: z.number().int().nonnegative(),
      percent: z.number().int().min(0).max(100),
    }),
  }),
)

export const Warning = BusEvent.define(
  "indexing.warning",
  z.object({
    code: z.enum(INDEXING_WARNING_CODES),
    message: z.string(),
  }),
)
