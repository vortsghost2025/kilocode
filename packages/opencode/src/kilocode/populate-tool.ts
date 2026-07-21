import { lstatSync } from "fs"
import path from "path"
import z from "zod"
import { Instance } from "@/project/instance"
import { EditTool } from "@/tool/edit"
import { Tool } from "@/tool/tool"
import { Filesystem } from "@/util/filesystem"
import { DelegatedEdit } from "./delegated-edit"

export const PopulateTool = Tool.define("populate", {
  description: "Populate one existing empty file. This tool never creates or overwrites a non-empty file.",
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the existing empty file"),
    content: z.string().min(1).describe("The initial file content"),
    evidenceRecall: DelegatedEdit.EvidenceRecall.optional().describe(
      "Required for a Phase2F populate lease: the verbatim delegated-edit lease text and mutation purpose",
    ),
  }),
  async execute(params, ctx) {
    const file = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    const stat = (() => {
      try {
        return lstatSync(file)
      } catch (err) {
        if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
          throw new Error("POPULATE_TARGET_MISSING: populate requires an existing empty regular file")
        }
        throw err
      }
    })()
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("POPULATE_TARGET_INVALID: populate requires an existing empty regular file")
    }
    if ((await Filesystem.readText(file)) !== "") {
      throw new Error("POPULATE_TARGET_NOT_EMPTY: populate cannot overwrite existing content")
    }

    const edit = await EditTool.init()
    return edit.execute(
      {
        filePath: file,
        oldString: "",
        newString: params.content,
        evidenceRecall: params.evidenceRecall,
      },
      ctx,
    )
  },
})
