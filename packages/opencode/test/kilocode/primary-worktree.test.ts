import { $ } from "bun"
import { afterEach, describe, expect, test, mock } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { primaryWorktree } from "../../src/kilocode/primary-worktree"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { KiloIndexing } from "../../src/kilocode/indexing"
import { IndexingWorker } from "../../src/kilocode/indexing-worker-client"

function norm(p: string) {
  return p.replace(/\\/g, "/").toLowerCase()
}

async function addWorktree(primary: string, dir: string, ...args: string[]) {
  await $`git worktree add ${dir} ${args}`.cwd(primary).quiet()
}

async function removeWorktree(primary: string, dir: string) {
  await $`git worktree remove --force ${dir}`.cwd(primary).quiet().nothrow()
}

afterEach(async () => {
  await Instance.disposeAll()
  IndexingWorker.override()
})

describe("primaryWorktree", () => {
  test("returns same dir for non-git directory", async () => {
    await using tmp = await tmpdir()
    const result = await primaryWorktree(tmp.path)
    expect(norm(result)).toBe(norm(tmp.path))
  })

  test("returns same dir for normal git checkout", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await primaryWorktree(tmp.path)
    expect(norm(result)).toBe(norm(tmp.path))
  })

  test("returns primary checkout for linked worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const primary = tmp.path
    const worktreeDir = path.join(path.dirname(primary), `wt-${Date.now()}`)
    try {
      await addWorktree(primary, worktreeDir, "HEAD")
      const result = await primaryWorktree(worktreeDir)
      expect(norm(result)).toBe(norm(primary))
    } finally {
      await removeWorktree(primary, worktreeDir)
    }
  })

  test("two linked worktrees both resolve to same primary", async () => {
    await using tmp = await tmpdir({ git: true })
    const primary = tmp.path
    const w1 = path.join(path.dirname(primary), `wt1-${Date.now()}`)
    const w2 = path.join(path.dirname(primary), `wt2-${Date.now()}`)
    try {
      await addWorktree(primary, w1, "HEAD")
      await addWorktree(primary, w2, "HEAD")
      const r1 = await primaryWorktree(w1)
      const r2 = await primaryWorktree(w2)
      expect(norm(r1)).toBe(norm(primary))
      expect(norm(r2)).toBe(norm(primary))
    } finally {
      await removeWorktree(primary, w2)
      await removeWorktree(primary, w1)
    }
  })

  test("unrelated repositories produce distinct identities", async () => {
    await using tmp1 = await tmpdir({ git: true })
    await using tmp2 = await tmpdir({ git: true })
    const r1 = await primaryWorktree(tmp1.path)
    const r2 = await primaryWorktree(tmp2.path)
    expect(norm(r1)).toBe(norm(tmp1.path))
    expect(norm(r2)).toBe(norm(tmp2.path))
    expect(r1).not.toBe(r2)
  })

  test("linked worktree with spaces in path", async () => {
    await using tmp = await tmpdir({ git: true })
    const primary = tmp.path
    const worktreeDir = path.join(path.dirname(primary), "my worktree")
    try {
      await addWorktree(primary, worktreeDir, "HEAD")
      const result = await primaryWorktree(worktreeDir)
      expect(norm(result)).toBe(norm(primary))
    } finally {
      await removeWorktree(primary, worktreeDir)
    }
  })

  test("detached worktree resolves to primary", async () => {
    await using tmp = await tmpdir({ git: true })
    const primary = tmp.path
    const worktreeDir = path.join(path.dirname(primary), `detached-${Date.now()}`)
    try {
      await addWorktree(primary, worktreeDir, "--detach", "HEAD")
      const result = await primaryWorktree(worktreeDir)
      expect(norm(result)).toBe(norm(primary))
    } finally {
      await removeWorktree(primary, worktreeDir)
    }
  })

  test("nested git repo returns inner repo path", async () => {
    await using tmp = await tmpdir({ git: true })
    const outer = tmp.path
    const innerDir = path.join(outer, "submodule")
    await fs.mkdir(innerDir, { recursive: true })
    await $`git init`.cwd(innerDir).quiet()
    await $`git config user.email "test@test.test"`.cwd(innerDir).quiet()
    await $`git config user.name "Test"`.cwd(innerDir).quiet()
    await $`git commit --allow-empty -m "inner"`.cwd(innerDir).quiet()
    const result = await primaryWorktree(innerDir)
    expect(norm(result)).toBe(norm(innerDir))
  })

  test("canonical production output matches Filesystem.resolve", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await primaryWorktree(tmp.path)
    const expected = Filesystem.resolve(tmp.path)
    expect(result).toBe(expected)
  })

  test("forward slash input path is normalized", async () => {
    await using tmp = await tmpdir({ git: true })
    const pathWithForward = tmp.path.replace(/\\/g, "/")
    const result = await primaryWorktree(pathWithForward)
    expect(norm(result)).toBe(norm(tmp.path))
  })

  test("subdirectory of primary repo resolves to primary", async () => {
    await using tmp = await tmpdir({ git: true })
    const primary = tmp.path
    const subdir = path.join(primary, "src", "lib")
    await fs.mkdir(subdir, { recursive: true })
    const result = await primaryWorktree(subdir)
    expect(norm(result)).toBe(norm(primary))
  })

  test("returns same dir when git commands fail", async () => {
    const nonExistent = path.join(os.tmpdir(), `__kilocode_primary_fail_${Date.now()}__`)
    const result = await primaryWorktree(nonExistent)
    expect(norm(result)).toBe(norm(nonExistent))
  })

  test("baseline directory passes through to Worker.init as second argument", async () => {
    await using tmp = await tmpdir({ git: true, config: { indexing: { enabled: true, provider: "openai" } } })
    const initArgs: any[] = []
    IndexingWorker.override((_dir, _root, _hooks) => ({
      ping: mock(async () => ({
        key: "test",
        engineLoaded: true,
        statusLoaded: true,
        lancedbPath: undefined,
        lancedbLoaded: true,
        connectType: undefined,
      })),
      init: mock(async (cfg, baseline) => {
        initArgs.push(baseline)
        return { state: "Standby" as const, message: "", processedFiles: 0, totalFiles: 0, percent: 100 }
      }),
      search: mock(async () => []),
      dispose: mock(async () => {}),
    }))
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await KiloIndexing.init()
      },
    })
    expect(initArgs).toHaveLength(1)
    const baseline = initArgs[0]
    expect(baseline).toBeTruthy()
    expect(typeof baseline).toBe("string")
    const expected = await primaryWorktree(tmp.path)
    expect(baseline).toBe(expected)
  })
})
