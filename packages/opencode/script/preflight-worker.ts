// kilocode_change - new file
import { LanceDBRuntime } from "../src/kilocode/lancedb"
import { IndexingWorker } from "../src/kilocode/indexing-worker-client"
import { tmpdir } from "os"
import { join } from "path"

const dir = join(tmpdir(), "kilo-preflight")
const root = join(tmpdir(), "kilo-preflight")
const hooks = {
  status: () => {},
  telemetry: () => {},
  warning: () => {},
  log: () => {},
  failure: () => {},
}

const keepalive = setInterval(() => {}, 60000)

async function main() {
  await LanceDBRuntime.ensure("lancedb")

  const w = IndexingWorker.create(dir, root, hooks)
  const ping = await w.ping()

  const ok =
    ping.engineLoaded === true &&
    ping.statusLoaded === true &&
    ping.lancedbLoaded === true &&
    ping.connectType === "function"

  await w.dispose()

  let workerTerminated = false
  try {
    await w.ping()
  } catch {
    workerTerminated = true
  }

  const result = {
    workerReady: ok,
    engineLoaded: ping.engineLoaded,
    statusLoaded: ping.statusLoaded,
    lancedbLoaded: ping.lancedbLoaded,
    connectType: ping.connectType,
    workerTerminated,
  }

  clearInterval(keepalive)
  console.log(JSON.stringify(result))

  if (!ok || !workerTerminated) process.exit(1)
  process.exit(0)
}

main().catch((err) => {
  clearInterval(keepalive)
  console.log(
    JSON.stringify({
      workerReady: false,
      engineLoaded: false,
      statusLoaded: false,
      lancedbLoaded: false,
      connectType: undefined,
      workerTerminated: false,
      error: String(err),
    }),
  )
  process.exit(1)
})
