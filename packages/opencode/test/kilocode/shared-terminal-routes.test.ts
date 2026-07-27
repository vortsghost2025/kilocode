import { test, expect, describe, afterEach } from "bun:test"
import {
  checkOrigin,
  isRawSocket,
  parseSubprotocol,
  SharedTerminalRoutes,
} from "../../src/kilocode/shared-terminal/routes"
import { ListenerPolicy } from "../../src/server/listener-policy"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "node:child_process"

afterEach(() => {
  ListenerPolicy.clearForTest()
})

const routesSource = readFileSync(join(process.cwd(), "src/kilocode/shared-terminal/routes.ts"), "utf-8")

const VALID_HEADERS = {
  origin: "http://localhost:3000",
  "sec-websocket-protocol": "kilo.shared-terminal.v1, ticket.abc_-XYZ",
} as const

describe("Static source assertions — Q2 wiring", () => {
  test("routes.ts contains no query-ticket parsing", () => {
    expect(routesSource.includes('query("ticket")')).toBe(false)
  })

  test("routes.ts invokes attachWithTicket() with rawTicket", () => {
    expect(routesSource.includes("rawTicket:")).toBe(true)
  })

  test("routes.ts invokes runtimeGetter() to access service state", () => {
    expect(routesSource.includes("runtimeGetter?.")).toBe(true)
  })

  test("routes.ts invokes submitHuman() for onMessage forwarding", () => {
    expect(routesSource.includes("submitHuman(")).toBe(true)
  })

  test("routes.ts invokes detach() on WS close/error", () => {
    expect(routesSource.includes("detach(")).toBe(true)
  })

  test("routes.ts does NOT invoke consumeMode() (moved to service)", () => {
    expect(routesSource.includes("consumeMode(")).toBe(false)
  })
})

describe("checkOrigin — loopback listener", () => {
  test("missing Origin is allowed", () => {
    ListenerPolicy.setFromServerConfig("localhost")
    const v = checkOrigin(undefined, ListenerPolicy.current())
    expect(v.allowed).toBe(true)
  })

  test("any syntactically valid Origin is allowed", () => {
    ListenerPolicy.setFromServerConfig("127.0.0.1")
    const p = ListenerPolicy.current()
    expect(p?.loopbackOnly).toBe(true)
    expect(checkOrigin("https://example.com", p).allowed).toBe(true)
    expect(checkOrigin("http://evil.com:444", p).allowed).toBe(true)
  })

  test("malformed Origin is denied", () => {
    ListenerPolicy.setFromServerConfig("localhost")
    expect(checkOrigin("not-a-url", ListenerPolicy.current()).allowed).toBe(false)
  })

  test("loopback ::1 hostname is loopback", () => {
    ListenerPolicy.setFromServerConfig("::1")
    expect(ListenerPolicy.current()?.loopbackOnly).toBe(true)
  })

  test("0.0.0.0 hostname is non-loopback", () => {
    ListenerPolicy.setFromServerConfig("0.0.0.0")
    expect(ListenerPolicy.current()?.loopbackOnly).toBe(false)
  })

  test(":: hostname is non-loopback", () => {
    ListenerPolicy.setFromServerConfig("::")
    expect(ListenerPolicy.current()?.loopbackOnly).toBe(false)
  })
})

describe("checkOrigin — non-loopback listener (fail-closed)", () => {
  test("unavailable policy denies non-loopback", () => {
    const v = checkOrigin("https://example.com", undefined)
    expect(v.allowed).toBe(false)
    expect(v.reason).toBe("policy_unavailable")
  })

  test("missing Origin fails closed", () => {
    ListenerPolicy.setFromServerConfig("0.0.0.0", ["https://allowed.com"])
    expect(checkOrigin(undefined, ListenerPolicy.current()).allowed).toBe(false)
  })

  test("malformed Origin fails closed", () => {
    ListenerPolicy.setFromServerConfig("0.0.0.0", ["https://allowed.com"])
    expect(checkOrigin("not-a-url", ListenerPolicy.current()).allowed).toBe(false)
  })

  test("empty allowlist denies all", () => {
    ListenerPolicy.setFromServerConfig("0.0.0.0", [])
    expect(checkOrigin("https://example.com", ListenerPolicy.current()).allowed).toBe(false)
    expect(checkOrigin("https://allowed.com", ListenerPolicy.current()).allowed).toBe(false)
  })

  test("exact allowed Origin passes", () => {
    ListenerPolicy.setFromServerConfig("0.0.0.0", ["https://allowed.com"])
    expect(checkOrigin("https://allowed.com", ListenerPolicy.current()).allowed).toBe(true)
  })

  test("non-matching Origin denied", () => {
    ListenerPolicy.setFromServerConfig("0.0.0.0", ["https://allowed.com"])
    expect(checkOrigin("https://evil.com", ListenerPolicy.current()).allowed).toBe(false)
  })

  test("port mismatch denied", () => {
    ListenerPolicy.setFromServerConfig("0.0.0.0", ["https://allowed.com:3000"])
    expect(checkOrigin("https://allowed.com:4000", ListenerPolicy.current()).allowed).toBe(false)
  })

  test("multiple allowed origins — one matches", () => {
    ListenerPolicy.setFromServerConfig("0.0.0.0", ["https://a.com", "https://b.com"])
    expect(checkOrigin("https://a.com", ListenerPolicy.current()).allowed).toBe(true)
    expect(checkOrigin("https://b.com", ListenerPolicy.current()).allowed).toBe(true)
    expect(checkOrigin("https://c.com", ListenerPolicy.current()).allowed).toBe(false)
  })
})

describe("listener-policy immutability", () => {
  test("allowedOrigins is frozen", () => {
    ListenerPolicy.setFromServerConfig("localhost", ["https://a.com"])
    const p = ListenerPolicy.current()!
    expect(Object.isFrozen(p.allowedOrigins)).toBe(true)
    expect(() => {
      ;(p.allowedOrigins as string[]).push("https://evil.com")
    }).toThrow()
  })

  test("current() returns a fresh snapshot per call", () => {
    ListenerPolicy.setFromServerConfig("localhost", ["https://a.com"])
    const a = ListenerPolicy.current()!
    const b = ListenerPolicy.current()!
    expect(a).not.toBe(b)
    expect(a.allowedOrigins).not.toBe(b.allowedOrigins)
    expect(a.allowedOrigins).toEqual(b.allowedOrigins)
  })
})

describe("listener-policy publication lifetime", () => {
  test("setFromServerConfig returns a distinct publication token per publication", () => {
    const t1 = ListenerPolicy.setFromServerConfig("localhost", ["https://a.com"])
    const t2 = ListenerPolicy.setFromServerConfig("localhost", ["https://b.com"])
    expect(t1).not.toBe(t2)
    expect(typeof t1).toBe("number")
  })

  test("release with the current token clears the policy", () => {
    const t = ListenerPolicy.setFromServerConfig("localhost", ["https://a.com"])
    expect(ListenerPolicy.current()).toBeDefined()
    expect(ListenerPolicy.release(t)).toBe(true)
    expect(ListenerPolicy.current()).toBeUndefined()
  })

  test("stale release from an older publication does NOT clear a newer policy", () => {
    const oldToken = ListenerPolicy.setFromServerConfig("0.0.0.0", ["https://old.com"])
    const newToken = ListenerPolicy.setFromServerConfig("0.0.0.0", ["https://new.com"])
    expect(ListenerPolicy.release(oldToken)).toBe(false)
    const p = ListenerPolicy.current()!
    expect(p.allowedOrigins).toEqual(["https://new.com"])
    expect(ListenerPolicy.release(newToken)).toBe(true)
    expect(ListenerPolicy.current()).toBeUndefined()
  })

  test("release with a token that was never current is a no-op", () => {
    ListenerPolicy.setFromServerConfig("localhost", ["https://a.com"])
    expect(ListenerPolicy.release(99999)).toBe(false)
    expect(ListenerPolicy.current()).toBeDefined()
  })
})

describe("parseSubprotocol", () => {
  test("missing protocol rejected", () => {
    expect(parseSubprotocol(undefined).ok).toBe(false)
    expect(parseSubprotocol("").ok).toBe(false)
  })

  test("valid protocol + ticket parses", () => {
    const r = parseSubprotocol("kilo.shared-terminal.v1, ticket.abc123-_AB")
    expect(r.ok).toBe(true)
    expect(r.protocol).toBe("kilo.shared-terminal.v1")
    expect(r.ticket).toBe("abc123-_AB")
  })

  test("missing ticket rejected", () => {
    expect(parseSubprotocol("kilo.shared-terminal.v1").ok).toBe(false)
    expect(parseSubprotocol("kilo.shared-terminal.v1").reason).toBe("ticket_count")
  })

  test("missing protocol rejected", () => {
    expect(parseSubprotocol("ticket.abc123").ok).toBe(false)
    expect(parseSubprotocol("ticket.abc123").reason).toBe("protocol_count")
  })

  test("duplicate protocol rejected", () => {
    expect(parseSubprotocol("kilo.shared-terminal.v1, kilo.shared-terminal.v1, ticket.abc").ok).toBe(false)
    expect(parseSubprotocol("kilo.shared-terminal.v1, kilo.shared-terminal.v1, ticket.abc").reason).toBe(
      "protocol_count",
    )
  })

  test("duplicate ticket rejected", () => {
    expect(parseSubprotocol("kilo.shared-terminal.v1, ticket.abc, ticket.def").ok).toBe(false)
    expect(parseSubprotocol("kilo.shared-terminal.v1, ticket.abc, ticket.def").reason).toBe("ticket_count")
  })

  test("malformed ticket token rejected", () => {
    expect(parseSubprotocol("kilo.shared-terminal.v1, ticket.abc=").ok).toBe(false)
    expect(parseSubprotocol("kilo.shared-terminal.v1, ticket.ab/cd").ok).toBe(false)
    expect(parseSubprotocol("kilo.shared-terminal.v1, ticket.").ok).toBe(false)
  })

  test("unknown subprotocol token rejected", () => {
    expect(parseSubprotocol("kilo.shared-terminal.v1, ticket.abc, surprising.extra").ok).toBe(false)
  })

  test("raw ticket never appears in parser output body", () => {
    const r = parseSubprotocol("kilo.shared-terminal.v1, ticket.SECRET_TOKEN_VALUE_123")
    expect(r.ok).toBe(true)
    expect(r.reason).toBeUndefined()
    expect(JSON.stringify(r).includes("ticket.SECRET_TOKEN_VALUE_123")).toBe(false)
  })
})

describe("isRawSocket", () => {
  test("null returns false", () => {
    expect(isRawSocket(null)).toBe(false)
  })
  test("undefined returns false", () => {
    expect(isRawSocket(undefined)).toBe(false)
  })
  test("non-object returns false", () => {
    expect(isRawSocket("string")).toBe(false)
  })
  test("valid socket returns true", () => {
    expect(isRawSocket({ readyState: 1, bufferedAmount: 0, send: () => {}, close: () => {} })).toBe(true)
  })
  test("missing readyState returns false", () => {
    expect(isRawSocket({ send: () => {}, close: () => {} })).toBe(false)
  })
})

// Q2: upgradeWebSocket factory validates origin and subprotocol before the
// WS upgrade. These tests use app.fetch() which does NOT run in a Bun.serve
// context, so the upgradeWebSocket handler returns a 500 after the validation
// passes (since getBunServer() throws). But validation failures (origin,
// subprotocol) throw HTTPException which Hono converts before the internal
// WS upgrade code runs, so they return proper HTTP error codes via fetch().
describe("Q2 pre-upgrade validation via HTTPException", () => {
  test("Origin rejection returns 403", async () => {
    ListenerPolicy.setFromServerConfig("0.0.0.0", ["https://allowed.com"])
    const app = SharedTerminalRoutes({
      listenerPolicy: ListenerPolicy.current,
    })
    const res = await app.fetch(
      new Request("http://localhost/t-1/connect", { headers: { origin: "https://evil.com" } }),
    )
    expect(res.status).toBe(403)
  })

  test("missing subprotocol returns 400", async () => {
    ListenerPolicy.setFromServerConfig("localhost")
    const app = SharedTerminalRoutes({
      listenerPolicy: ListenerPolicy.current,
    })
    const res = await app.fetch(
      new Request("http://localhost/t-1/connect", { headers: { origin: "http://localhost:3000" } }),
    )
    expect(res.status).toBe(400)
  })

  test("malformed subprotocol returns 400", async () => {
    ListenerPolicy.setFromServerConfig("localhost")
    const app = SharedTerminalRoutes({
      listenerPolicy: ListenerPolicy.current,
    })
    const res = await app.fetch(
      new Request("http://localhost/t-1/connect", {
        headers: { origin: "http://localhost:3000", "sec-websocket-protocol": "kilo.shared-terminal.v1" },
      }),
    )
    expect(res.status).toBe(400)
  })

  test("valid origin + subprotocol with unavailable runtime returns 503", async () => {
    ListenerPolicy.setFromServerConfig("localhost")
    const app = SharedTerminalRoutes({
      listenerPolicy: ListenerPolicy.current,
      runtimeGetter: () => undefined,
    })
    const res = await app.fetch(new Request("http://localhost/t-1/connect", { headers: { ...VALID_HEADERS } }))
    // runtimeGetter returns undefined → HTTPException 503 thrown before WS upgrade
    expect(res.status).toBe(503)
  })

  test("raw ticket never appears in any response body", async () => {
    ListenerPolicy.setFromServerConfig("localhost")
    const app = SharedTerminalRoutes({
      listenerPolicy: ListenerPolicy.current,
    })
    const res = await app.fetch(
      new Request("http://localhost/t-1/connect", {
        headers: {
          origin: "http://localhost:3000",
          "sec-websocket-protocol": "kilo.shared-terminal.v1, ticket.SUPER_SECRET",
        },
      }),
    )
    const text = await res.text()
    expect(text.includes("SUPER_SECRET")).toBe(false)
    expect(text.includes("ticket.SUPER_SECRET")).toBe(false)
  })
})

// Behavioural flag-gated route mounting via isolated child Bun processes.
// Each child sets KILO_EXPERIMENTAL_SHARED_TERMINAL before importing any
// module, registers routes on a fresh Hono app via the real register()
// function, and reports presence by inspecting app.routes instead of making
// HTTP requests (since upgradeWebSocket can't upgrade outside Bun.serve).
const CHILD_PROBE = `
const { Hono } = require("hono")

async function main() {
  const { register } = await import("./src/kilocode/server/instance.ts")
  const app = new Hono()
  register(app)
  const hasSharedTerminal = app.routes.some(r => r.path.startsWith("/shared-terminal"))
  process.stdout.write(hasSharedTerminal ? "PRESENT" : "ABSENT")
}
main().catch((e) => {
  process.stdout.write("ERROR:" + String(e && e.message ? e.message : e))
  process.exit(1)
})
`

function runProbe(flagValue: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", CHILD_PROBE], {
      cwd: process.cwd(),
      env: { ...process.env, KILO_EXPERIMENTAL_SHARED_TERMINAL: flagValue },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d.toString()))
    child.stderr.on("data", (d) => (err += d.toString()))
    child.on("error", reject)
    child.on("close", () => resolve(out + (err ? "\nSTDERR:" + err : "")))
  })
}

describe("Behavioural flag-gated route mounting (isolated child processes)", () => {
  test("flag OFF → /shared-terminal route is absent", async () => {
    const report = await runProbe("0")
    expect(report.startsWith("ABSENT")).toBe(true)
  })

  test("flag ON → /shared-terminal route is present", async () => {
    const report = await runProbe("1")
    expect(report.startsWith("PRESENT")).toBe(true)
    expect(report.startsWith("ERROR")).toBe(false)
  })
})
