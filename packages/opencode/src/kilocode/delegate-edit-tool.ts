import z from "zod"
import { runDelegatedEdit } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { DelegatedEdit } from "./delegated-edit"

export const DelegateEditTool = Tool.define("delegate_edit", {
  description:
    "Launch Phase2F with one runtime-generated, replay-protected mutation lease for one canonical repository-relative path. Use a new tool call for each corrective or sequential lease.",
  parameters: z
    .object({
      description: z.string().describe("A short (3-5 words) description of the task"),
      prompt: z.string().describe("The implementation task; do not embed authorization JSON here"),
      operation: DelegatedEdit.Operation.describe(
        'The exact operation: "edit" for a non-empty file or "populate" for an existing empty file',
      ),
      path: z.string().min(1).describe("The exact repository-relative file path"),
    })
    .strict(),
  formatValidationError(error) {
    return DelegatedEdit.invalid(
      error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; "),
    ).message
  },
  execute(params, ctx) {
    return runDelegatedEdit(
      {
        description: params.description,
        prompt: params.prompt,
        authorization: { operation: params.operation, path: params.path },
      },
      ctx,
    )
  },
})
