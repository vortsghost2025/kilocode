import { git } from "@/util/git"
import { Filesystem } from "@/util/filesystem"

export async function primaryWorktree(dir: string): Promise<string> {
  const resolved = Filesystem.resolve(dir)

  const common = await git(["rev-parse", "--git-common-dir"], { cwd: resolved })
  if (common.exitCode !== 0) return resolved

  const list = await git(["worktree", "list", "--porcelain"], { cwd: resolved })
  if (list.exitCode !== 0) return resolved

  const text = list.text().trim()
  if (!text) return resolved

  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      const path = line.slice("worktree ".length)
      return Filesystem.resolve(path)
    }
  }

  return resolved
}
