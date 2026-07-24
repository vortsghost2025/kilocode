import path from "path"
import z from "zod"
import type { VectorStoreSearchResult } from "@kilocode/kilo-indexing/engine"
import { Tool } from "@/tool/tool"
import { KiloIndexing } from "@/kilocode/indexing"
import { Instance } from "@/project/instance"

import DESCRIPTION from "./semantic-search.txt"

const Parameters = z.object({
  query: z.string().describe("The search query, expressed in natural language."),
  path: z
    .string()
    .optional()
    .describe(
      "Limit search to specific subdirectory (relative to the current workspace directory). Leave empty for entire workspace.",
    ),
})

type SearchResult = {
  filePath: string
  score: number
  startLine: number
  endLine: number
  codeChunk: string
}

type Meta = {
  results: SearchResult[]
}

export const SemanticSearchTool = Tool.define("semantic_search", {
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params, ctx) {
    if (!params.query || params.query.trim().length === 0) {
      throw new Error("query is required")
    }

    const normalizedPrefix = normalizeSearchPath(params.path)

    if (!KiloIndexing.ready()) {
      return {
        title: "Codebase Search",
        metadata: {
          results: [] satisfies SearchResult[],
        },
        output: `No relevant code found for "${params.query}"${normalizedPrefix ? ` in ${normalizePath(normalizedPrefix)}` : ""}.`,
      }
    }

    await ctx.ask({
      permission: "semantic_search",
      patterns: [params.query],
      always: [],
      metadata: {
        query: params.query,
        ...(normalizedPrefix === undefined ? {} : { path: normalizedPrefix }),
      },
    })

    const matches = await KiloIndexing.search(params.query, normalizedPrefix).catch(
      () => [] satisfies VectorStoreSearchResult[],
    )

    const results = matches.flatMap<SearchResult>((item) => {
      const payload = item.payload
      if (!payload) return []
      if (
        typeof payload.filePath !== "string" ||
        payload.filePath.length === 0 ||
        typeof payload.codeChunk !== "string" ||
        typeof payload.startLine !== "number" ||
        typeof payload.endLine !== "number" ||
        typeof item.score !== "number" ||
        !Number.isFinite(item.score)
      ) {
        return []
      }
      if (!Number.isInteger(payload.startLine) || !Number.isInteger(payload.endLine)) return []
      if (payload.endLine < payload.startLine) return []

      const relative = workspaceRelative(payload.filePath)
      if (relative === undefined) return []

      return [
        {
          filePath: normalizePath(relative),
          score: item.score,
          startLine: payload.startLine,
          endLine: payload.endLine,
          codeChunk: payload.codeChunk,
        },
      ]
    })

    if (results.length === 0) {
      return {
        title: "Codebase Search",
        metadata: {
          results,
        },
        output: `No relevant code found for "${params.query}"${normalizedPrefix ? ` in ${normalizePath(normalizedPrefix)}` : ""}.`,
      }
    }

    const output = [
      `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${params.query}"${normalizedPrefix ? ` in ${normalizePath(normalizedPrefix)}` : ""}.`,
      "",
      ...results.flatMap((item, index) => {
        return [
          `${index + 1}. ${item.filePath}:${item.startLine}-${item.endLine} (score ${item.score.toFixed(4)})`,
          item.codeChunk,
          "",
        ]
      }),
    ]

    return {
      title: "Codebase Search",
      metadata: {
        results,
      },
      output: output.join("\n").trim(),
    }
  },
})

function normalizeSearchPath(input?: string): string | undefined {
  if (!input) return undefined

  const absolute = path.resolve(Instance.directory, input)
  const relative = path.relative(Instance.directory, absolute)
  if (!relative || relative === ".") return undefined
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`path must be within the current workspace: ${input}`)
  }
  return path.normalize(relative)
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/")
}

function workspaceRelative(filePath: string): string | undefined {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(Instance.directory, filePath)
  const relative = path.relative(Instance.directory, absolute)
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined
  return relative
}
