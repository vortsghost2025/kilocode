import { describe, expect, test } from "bun:test"
import path from "node:path"
import { SharedTerminalDebug } from "../../src/kilocode/shared-terminal/debug"
import { tmpdir } from "../fixture/fixture"

describe("shared terminal debug writer", () => {
  test("deduplicates consecutive records", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "trace.log")
    const writer = new SharedTerminalDebug.Writer(file, { bytes: 1024, records: 10 })
    await writer.reset()
    const line = JSON.stringify({ stage: "tui_status_event", status: "resize" }) + "\n"
    await Promise.all([writer.append(line), writer.append(line), writer.append(line)])
    expect((await Bun.file(file).text()).split("\n").filter(Boolean)).toEqual([line.trim()])
  })

  test("caps records at the configured limit", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "trace.log")
    const writer = new SharedTerminalDebug.Writer(file, { bytes: 4096, records: 3 })
    await writer.reset()
    for (const stage of ["one", "two", "three", "four", "five"]) {
      await writer.append(JSON.stringify({ stage }) + "\n")
    }
    const records = (await Bun.file(file).text()).split("\n").filter(Boolean)
    expect(records).toHaveLength(3)
    expect(records.map((record) => JSON.parse(record).stage)).toEqual(["one", "two", "three"])
  })

  test("caps bytes before the configured limit is exceeded", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "trace.log")
    const line = JSON.stringify({ stage: "1234567890" }) + "\n"
    const writer = new SharedTerminalDebug.Writer(file, { bytes: Buffer.byteLength(line) + 1, records: 100 })
    await writer.reset()
    await writer.append(line)
    await writer.append(JSON.stringify({ stage: "different" }) + "\n")
    expect(await Bun.file(file).text()).toBe(line)
  })
})
