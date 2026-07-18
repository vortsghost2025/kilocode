// kilocode_change - new file
import { afterEach, expect, test } from "bun:test"
import { Command } from "../../src/command"
import { Instance } from "../../src/project/instance"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await resetDatabase()
})

test("review command routes to reviewer subagent not code primary agent", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const cmd = await Command.get("review")
      expect(cmd).toBeDefined()
      expect(cmd!.agent).toBe("reviewer")
      expect(cmd!.subtask).toBe(true)
    },
  })
})
