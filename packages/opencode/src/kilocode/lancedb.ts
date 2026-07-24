export namespace LanceDBRuntime {
  export const env = "KILO_LANCEDB_PATH"
  export const pkg = "@lancedb/lancedb"
  export const version = "0.26.2"
  export const external = [
    pkg,
    "@lancedb/lancedb-darwin-arm64",
    "@lancedb/lancedb-linux-arm64-gnu",
    "@lancedb/lancedb-linux-arm64-musl",
    "@lancedb/lancedb-linux-x64-gnu",
    "@lancedb/lancedb-linux-x64-musl",
    "@lancedb/lancedb-win32-arm64-msvc",
    "@lancedb/lancedb-win32-x64-msvc",
  ] as const

  const box = { ready: undefined as Promise<void> | undefined }

  export function clear() {
    delete process.env[env]
    box.ready = undefined
  }

  async function resolveSpecifier(): Promise<string> {
    try {
      const engineUrl = import.meta.resolve("@kilocode/kilo-indexing/engine")
      const lancedbUrl = import.meta.resolve(pkg, engineUrl)
      return lancedbUrl
    } catch {}
    return pkg
  }

  export async function ensure(store?: string) {
    if (store !== "lancedb") return
    if (process.env[env]) return
    if (process.platform === "darwin" && process.arch === "x64") {
      throw new Error(
        'LanceDB is not supported on Intel Macs. Set "indexing.vectorStore" to "qdrant" and configure a Qdrant server.',
      )
    }
    if (box.ready) return box.ready

    box.ready = (async () => {
      process.env[env] = await resolveSpecifier()
      // The dynamic import will be verified at Worker startup via the ping protocol.
      // From the host context, @lancedb/lancedb resolves only through the
      // packages/kilo-indexing workspace, so the verify-import happens inside
      // the Worker where the engine context has correct module resolution.
    })()

    return box.ready
  }
}
