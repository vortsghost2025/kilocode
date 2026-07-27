import { test, expect, describe } from "bun:test"
import { parseSubprotocol } from "../../src/kilocode/shared-terminal/routes"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Read the routes source for static assertions that verify Q2 wiring is
// present in the route module. These assertions check source text only; they
// do not prove route-registration behaviour, which is covered by the routes
// test.
const routesSource = readFileSync(join(process.cwd(), "src/kilocode/shared-terminal/routes.ts"), "utf-8")

describe("Static source assertions — Q2 wiring", () => {
  test("routes.ts contains no query-ticket parsing", () => {
    expect(routesSource.includes('query("ticket")')).toBe(false)
  })

  test("routes.ts invokes attachWithTicket() with rawTicket (not consumeMode)", () => {
    expect(routesSource.includes("rawTicket:")).toBe(true)
  })

  test("routes.ts does NOT invoke consumeMode() (moved to service)", () => {
    expect(routesSource.includes("consumeMode(")).toBe(false)
  })
})

describe("Subprotocol parser contract: kilo.shared-terminal.v1 + ticket.<base64url>", () => {
  test("valid protocol + ticket subprotocol parses", () => {
    const r = parseSubprotocol("kilo.shared-terminal.v1, ticket.abc123-_")
    expect(r.ok).toBe(true)
    expect(r.protocol).toBe("kilo.shared-terminal.v1")
    expect(r.ticket).toBe("abc123-_")
  })

  test("missing protocol rejected", () => {
    expect(parseSubprotocol("ticket.abc").ok).toBe(false)
    expect(parseSubprotocol("ticket.abc").reason).toBe("protocol_count")
  })

  test("missing ticket rejected", () => {
    expect(parseSubprotocol("kilo.shared-terminal.v1").ok).toBe(false)
    expect(parseSubprotocol("kilo.shared-terminal.v1").reason).toBe("ticket_count")
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

  test("raw ticket never appears in response body", () => {
    const r = parseSubprotocol("kilo.shared-terminal.v1, ticket.TOP_SECRET_VALUE")
    expect(r.ok).toBe(true)
    // The parser exposes the bare token on `r.ticket` to the caller, but
    // it never echoes "ticket.TOP_SECRET_VALUE" in any error/reason/body.
    expect(JSON.stringify(r).includes("ticket.TOP_SECRET_VALUE")).toBe(false)
  })

  test("order-insensitive — ticket then protocol", () => {
    const r = parseSubprotocol("ticket.abc, kilo.shared-terminal.v1")
    expect(r.ok).toBe(true)
    expect(r.protocol).toBe("kilo.shared-terminal.v1")
    expect(r.ticket).toBe("abc")
  })

  test("header normalization — extra whitespace tolerated", () => {
    const r = parseSubprotocol("  kilo.shared-terminal.v1 ,  ticket.abc  ")
    expect(r.ok).toBe(true)
    expect(r.ticket).toBe("abc")
  })

  test("unexpected subprotocol token rejected", () => {
    expect(parseSubprotocol("kilo.shared-terminal.v1, ticket.abc, surprising.extra").ok).toBe(false)
  })

  test("empty header rejected", () => {
    expect(parseSubprotocol("").ok).toBe(false)
    expect(parseSubprotocol(undefined).ok).toBe(false)
  })
})
