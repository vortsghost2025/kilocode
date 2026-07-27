import { test, expect, describe } from "bun:test"

import { OutputRing, StreamingEncoder } from "../../src/kilocode/shared-terminal/buffer"
import { LIMITS, ReadResult } from "../../src/kilocode/shared-terminal/schema"

const enc = new TextEncoder()

// Buffer read results leave terminalID empty; schema requires a non-empty id.
// Fill it before validating through the canonical ReadResult schema.
const fix = (r: ReturnType<OutputRing["readHuman"]>) => ({ ...r, terminalID: "t-001" })

const cat = (chunks: Uint8Array[]) => {
  let n = 0
  for (const c of chunks) n += c.length
  const out = new Uint8Array(n)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

describe("StreamingEncoder: offset examples", () => {
  test("ASCII: bytes equal chars", () => {
    const e = new StreamingEncoder()
    const out = e.push("hello")
    expect(cat(out)).toEqual(enc.encode("hello"))
    expect(e.cursor()).toBe(5)
  })

  test("BMP Unicode (é, U+00E9): 2 UTF-8 bytes per char", () => {
    const e = new StreamingEncoder()
    const out = e.push("café")
    expect(cat(out)).toEqual(enc.encode("café"))
    // 'caf' = 3 bytes, 'é' = 2 bytes -> 5 total
    expect(e.cursor()).toBe(5)
  })

  test("astral Unicode (𝓐 U+1D4D0): 4 UTF-8 bytes via surrogate pair", () => {
    const e = new StreamingEncoder()
    const out = e.push("𝓐")
    expect(cat(out)).toEqual(enc.encode("𝓐"))
    // 𝓐 is U+1D4D0, encoded as one JS surrogate pair but 4 UTF-8 bytes
    expect("𝓐".length).toBe(2)
    expect(e.cursor()).toBe(4)
  })

  test("surrogate pair split across callbacks: high held, then low completes; no U+FFFD", () => {
    const e = new StreamingEncoder()
    // "𝓐" = \uD835\uDCD0. Feed high surrogate first.
    const first = e.push("\uD835")
    // High surrogate is held, no bytes emitted yet.
    expect(first.length).toBe(0)
    expect(e.cursor()).toBe(0)
    const second = e.push("\uDCD0")
    const joined = cat([...first, ...second])
    expect(joined).toEqual(enc.encode("𝓐"))
    expect(e.cursor()).toBe(4)
  })

  test("unmatched trailing surrogate on flush emits U+FFFD (1 byte)", () => {
    const e = new StreamingEncoder()
    const out = e.push("\uD835")
    expect(out.length).toBe(0)
    const flush = e.flush()
    expect(flush.length).toBe(1)
    expect(flush[0]).toEqual(new Uint8Array([0xef, 0xbf, 0xbd]))
    expect(e.cursor()).toBe(3)
  })

  test("unmatched leading unit mid-stream: flush emits replacement separately", () => {
    const e = new StreamingEncoder()
    e.push("x")
    e.push("\uD800") // lone high
    const mid = e.flush()
    // U+FFFD is 3 bytes
    expect(cat(mid)).toEqual(enc.encode("\uFFFD"))
    expect(e.cursor()).toBe(1 + 3)
  })

  test("combining characters: é as e + combining acute is 3 UTF-8 bytes total", () => {
    const e = new StreamingEncoder()
    const out = e.push("e\u0301")
    // 'e' = 1 byte, U+0301 combining acute = 2 bytes -> 3 total
    expect(cat(out)).toEqual(enc.encode("e\u0301"))
    expect(e.cursor()).toBe(3)
  })

  test("CRLF: 2 bytes total", () => {
    const e = new StreamingEncoder()
    const out = e.push("\r\n")
    expect(cat(out)).toEqual(enc.encode("\r\n"))
    expect(e.cursor()).toBe(2)
  })

  test("split CRLF across callbacks: CR then LF both emit without holding", () => {
    const e = new StreamingEncoder()
    const a = e.push("\r")
    const b = e.push("\n")
    expect(cat([...a, ...b])).toEqual(enc.encode("\r\n"))
    expect(e.cursor()).toBe(2)
  })

  test("cursor is byte-based, not JS code-unit based (contrast with legacy /pty)", () => {
    const e = new StreamingEncoder()
    e.push("abc")
    e.push("é")
    e.push("𝓐")
    // a,b,c = 3 bytes; é = 2 bytes; 𝓐 = 4 bytes -> 9 total
    expect(e.cursor()).toBe(9)
  })

  test("concatenated multi-callback encodings match a single TextEncoder call", () => {
    const e = new StreamingEncoder()
    const samples = ["hello", " ", "wörld", " ", "𝓐", "!", "e\u0301", "\r\n"]
    const captured: Uint8Array[] = []
    for (const s of samples) captured.push(...e.push(s))
    captured.push(...e.flush())
    const expected = enc.encode(samples.join(""))
    expect(cat(captured)).toEqual(expected)
  })
})

describe("OutputRing: append and read", () => {
  test("appending ASCII bytes advances absolute byte cursor", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("hello"), visibility: "shared" })
    expect(ring.start()).toBe(0)
    expect(ring.end()).toBe(5)
  })

  test("human-readable read returns raw shared bytes across multiple appends", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("foo"), visibility: "shared" })
    ring.append({ bytes: enc.encode("bar"), visibility: "shared" })
    const human = ring.readHuman({ from: 0, maxBytes: 1024 })
    expect(human.start).toBe(0)
    expect(human.end).toBe(6)
    expect(human.next).toBe(6)
    expect(human.truncated).toBe(false)
    expect(dec(human.bytes)).toBe("foobar")
    // Successful read must pass the canonical schema invariant next === end.
    expect(ReadResult.zod.safeParse(fix(human)).success).toBe(true)
  })

  test("agent read strips human chunks and produces omission records", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("x"), visibility: "shared" })
    ring.append({ bytes: enc.encode("secret"), visibility: "human" })
    ring.append({ bytes: enc.encode("y"), visibility: "shared" })
    const agent = ring.readAgent({ from: 0, maxBytes: 1024 })
    expect(dec(agent.bytes)).toBe("xy")
    expect(agent.privateBytes).toBe(enc.encode("secret").length)
    expect(agent.truncated).toBe(false)
  })

  test("agent read over only-human range returns empty bytes with privateBytes set", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("secret"), visibility: "human" })
    const agent = ring.readAgent({ from: 0, maxBytes: 1024 })
    expect(agent.bytes.length).toBe(0)
    expect(agent.privateBytes).toBe(enc.encode("secret").length)
  })

  test("read clamps maxBytes to the limit and marks truncation", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("0123456789"), visibility: "shared" })
    const r = ring.readHuman({ from: 0, maxBytes: 4 })
    expect(dec(r.bytes)).toBe("0123")
    expect(r.next).toBe(4)
    expect(r.truncated).toBe(true)
    expect(r.end).toBe(4)
  })

  test("read respects READ_MAX_BYTES upper bound even if caller asks for more", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("a".repeat(100)), visibility: "shared" })
    // READ_MAX_BYTES is a cap, not a floor. Only 100 bytes exist, so all 100
    // are returned and nothing is truncated (a read can never fabricate bytes).
    const r = ring.readHuman({ from: 0, maxBytes: 1_000_000 })
    expect(r.bytes.length).toBe(100)
    expect(r.truncated).toBe(false)
    expect(r.next).toBe(100)
  })

  test("read clamps to READ_MAX_BYTES when more than the cap is available", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("a".repeat(100_000)), visibility: "shared" })
    const r = ring.readHuman({ from: 0, maxBytes: 1_000_000 })
    expect(r.bytes.length).toBe(LIMITS.READ_MAX_BYTES)
    expect(r.truncated).toBe(true)
    expect(r.next).toBe(LIMITS.READ_MAX_BYTES)
  })

  test("read defaults to READ_DEFAULT_BYTES when maxBytes omitted", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("b".repeat(100)), visibility: "shared" })
    const r = ring.readHuman({ from: 0 })
    expect(r.bytes.length).toBe(100) // under default, so all returned
    expect(r.truncated).toBe(false)
    expect(r.next).toBe(100)
  })
})

describe("OutputRing: eviction and gap", () => {
  test("ring evicts oldest chunks once capacity is exceeded (byte ring)", () => {
    // Build a ring with a tiny byte cap by subclass-style small ring.
    const ring = new OutputRing({ ringBytes: 10 })
    ring.append({ bytes: enc.encode("aaaaaa"), visibility: "shared" }) // 6 bytes, fits
    ring.append({ bytes: enc.encode("bbbbbb"), visibility: "shared" }) // 12 total > 10, evict
    expect(ring.start()).toBe(2) // evicted 2 leading bytes
    expect(ring.end()).toBe(12)
  })

  test("stale cursor (before retained start) returns gap and truncated", () => {
    const ring = new OutputRing({ ringBytes: 10 })
    ring.append({ bytes: enc.encode("aaaaaa"), visibility: "shared" })
    ring.append({ bytes: enc.encode("bbbbbb"), visibility: "shared" })
    // start is now 2; ask for cursor 0 (stale)
    const human = ring.readHuman({ from: 0, maxBytes: 1024 })
    expect(human.truncated).toBe(true)
    expect(human.requested).toBe(0)
    expect(human.start).toBe(ring.start()) // replay begins at retained start
    expect(human.gap).toBe(true)
    expect(human.gapStart).toBe(0)
    expect(human.gapEnd).toBe(ring.start())
  })

  test("agent read with stale cursor reports gap and omits private bytes in lost region", () => {
    const ring = new OutputRing({ ringBytes: 10 })
    ring.append({ bytes: enc.encode("aaaaaa"), visibility: "human" }) // 6 private bytes
    ring.append({ bytes: enc.encode("bbbbbb"), visibility: "shared" }) // 12 total > 10, evict
    // start is now 2; the leading private region [0,2) is lost.
    const agent = ring.readAgent({ from: 0, maxBytes: 1024 })
    expect(agent.truncated).toBe(true)
    expect(agent.gap).toBe(true)
    expect(agent.gapStart).toBe(0)
    expect(agent.gapEnd).toBe(ring.start())
    // The evicted private bytes in lost region [0, start) are not counted.
    // The retained partial "aaaa" tail [start, end-of-first-chunk) is human
    // and still present, so it is counted toward privateBytes.
    expect(agent.privateBytes).toBe(4)
  })

  test("reading from current end returns empty, not gap, with eof-style next", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("abc"), visibility: "shared" })
    const r = ring.readHuman({ from: 3, maxBytes: 1024 })
    expect(r.bytes.length).toBe(0)
    expect(r.truncated).toBe(false)
    expect(r.gap).toBe(false)
    expect(r.next).toBe(3)
    expect(r.end).toBe(3)
    expect(ReadResult.zod.safeParse(fix(r)).success).toBe(true)
  })

  function expectOutOfRange(fn: () => unknown): void {
    let threw = false
    let err: unknown
    try {
      fn()
    } catch (e) {
      threw = true
      err = e
    }
    expect(threw).toBe(true)
    expect(typeof err === "object" && err !== null && (err as { code?: unknown }).code === "read_out_of_range").toBe(
      true,
    )
  }

  test("reading from a future cursor (>end) throws SharedTerminalError read_out_of_range", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("abc"), visibility: "shared" })
    expectOutOfRange(() => ring.readHuman({ from: 99, maxBytes: 1024 }))
    expectOutOfRange(() => ring.readAgent({ from: 99, maxBytes: 1024 }))
  })

  test("reading exactly from end is valid (not future), reading end+1 throws", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("abc"), visibility: "shared" })
    // from === end is the "caught up, nothing new" case -> ok, empty.
    const ok = ring.readHuman({ from: 3, maxBytes: 1024 })
    expect(ok.next).toBe(3)
    // from === end+1 is future -> throw.
    expectOutOfRange(() => ring.readHuman({ from: 4, maxBytes: 1024 }))
  })

  test("no duplicated or skipped byte across eviction boundary", () => {
    const ring = new OutputRing({ ringBytes: 10 })
    ring.append({ bytes: enc.encode("aaa"), visibility: "shared" })
    ring.append({ bytes: enc.encode("bbb"), visibility: "shared" })
    ring.append({ bytes: enc.encode("ccc"), visibility: "shared" })
    // After appends: 9 bytes total, within cap, start stays 0
    expect(ring.start()).toBe(0)
    expect(ring.end()).toBe(9)
    // Append one more to force eviction
    ring.append({ bytes: enc.encode("ddd"), visibility: "shared" })
    // 12 bytes > 10 -> evict 2 leading bytes of "aaa" -> start=2, retained =
    // "a" + "bbb" + "ccc" + "ddd" = "abbbcccddd"
    expect(ring.start()).toBe(2)
    expect(ring.end()).toBe(12)
    const human = ring.readHuman({ from: ring.start(), maxBytes: 1024 })
    expect(dec(human.bytes)).toBe("abbbcccddd")
  })
})

describe("OutputRing: integration with StreamingEncoder", () => {
  test("encode complex stream once, read back deterministically by byte offset", () => {
    const enc2 = new StreamingEncoder()
    const ring = new OutputRing()
    const parts = ["café ", "𝓐", " ", "e\u0301", "\r\n", "$"]
    for (const p of parts) {
      const bytes = cat([...enc2.push(p), ...flushIfAny(enc2)])
      if (bytes.length) ring.append({ bytes, visibility: "shared" })
    }
    // Total bytes: café =5, space=1, 𝓐=4, space=1, e+combining=3, crlf=2, $=1 -> 17
    expect(ring.end()).toBe(17)
    const full = ring.readHuman({ from: 0, maxBytes: 1024 })
    expect(dec(full.bytes)).toBe("café 𝓐 e\u0301\r\n$")
  })

  test("surrogate pair split across two append calls still yields one 4-byte sequence", () => {
    const e = new StreamingEncoder()
    const ring = new OutputRing()
    const half1 = e.push("\uD835")
    if (half1.length) ring.append({ bytes: cat(half1), visibility: "shared" })
    const half2 = e.push("\uDCD0")
    if (half2.length) ring.append({ bytes: cat(half2), visibility: "shared" })
    const flush = e.flush()
    if (flush.length) ring.append({ bytes: cat(flush), visibility: "shared" })
    expect(ring.end()).toBe(4)
    const r = ring.readHuman({ from: 0, maxBytes: 1024 })
    expect(dec(r.bytes)).toBe("𝓐")
  })
})

function flushIfAny(e: StreamingEncoder): Uint8Array[] {
  // Only flush at a boundary; for this test we never leave a dangling surrogate,
  // so flush returns nothing. Kept for clarity.
  return []
}

function dec(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

// ---------------------------------------------------------------------------
// BLOCKER 2: streaming UTF-8 ordering. A lone high surrogate NOT at the end
// of a chunk must emit U+FFFD immediately, in order, and never be held pending.
// Only a genuinely trailing high surrogate may remain pending.
// ---------------------------------------------------------------------------
describe("StreamingEncoder: malformed-surrogate ordering", () => {
  test("push(\"\\uD800A\") emits U+FFFD then 'A' immediately, in order", () => {
    const e = new StreamingEncoder()
    const out = cat(e.push("\uD800A"))
    // WHATWG: lone high -> U+FFFD, then 'A'. Bytes: EF BF BD 41.
    expect(out).toEqual(enc.encode("\uFFFDA"))
    expect(e.cursor()).toBe(4)
  })

  test('flush() after push("\\uD800A") returns nothing', () => {
    const e = new StreamingEncoder()
    e.push("\uD800A")
    expect(e.flush()).toEqual([])
    expect(e.cursor()).toBe(4)
  })

  test('push("\\uD800\\uD835\\uDCD0") emits U+FFFD then the valid astral 𝓐', () => {
    const e = new StreamingEncoder()
    const out = cat(e.push("\uD800\uD835\uDCD0"))
    // High \uD800 followed by another high (not a low) -> U+FFFD for \uD800;
    // then \uD835\uDCD0 is a valid astral pair -> 𝓐 (4 bytes). Total 7 bytes.
    expect(out).toEqual(enc.encode("\uFFFD𝓐"))
    expect(e.cursor()).toBe(7)
  })

  test("malformed-surrogate output matches TextEncoder of the full concatenated input", () => {
    const samples = ["\uD800A", "\uD800\uD835\uDCD0", "x\uD800y", "\uD800\uD800\uD800"]
    const e = new StreamingEncoder()
    let captured: Uint8Array = new Uint8Array(0)
    for (const s of samples) captured = cat([captured, cat([...e.push(s), ...e.flush()])])
    const expected = enc.encode("\uFFFDA\uFFFD𝓐x\uFFFDy\uFFFD\uFFFD\uFFFD")
    expect(captured).toEqual(expected)
  })

  test("callback boundaries do not alter output ordering", () => {
    const full = "\uD800\uD835\uDCD0A\uD800B"
    const expected = enc.encode("\uFFFD𝓐A\uFFFDB")

    // flush() is the PTY-exit signal and is called ONCE at the end, not per
    // chunk: a genuinely trailing high may legitimately persist into the next
    // push, so eager per-chunk flushing would destroy cross-boundary pairs.
    function run(parts: string[]): Uint8Array {
      const e = new StreamingEncoder()
      let captured: Uint8Array = new Uint8Array(0)
      for (const p of parts) captured = cat([captured, cat(e.push(p))])
      captured = cat([captured, cat(e.flush())])
      return captured
    }

    expect(run([full])).toEqual(expected)
    expect(run(["\uD800", "\uD835\uDCD0A\uD800B"])).toEqual(expected)
    expect(run(["\uD800\uD835", "\uDCD0A", "\uD800", "B"])).toEqual(expected)
  })

  test("trailing high surrogate (genuinely at end) is still held until next low", () => {
    const e = new StreamingEncoder()
    const first = e.push("\uD835")
    expect(first.length).toBe(0)
    expect(e.cursor()).toBe(0)
    const second = e.push("\uDCD0")
    expect(cat(second)).toEqual(enc.encode("𝓐"))
    expect(e.cursor()).toBe(4)
    expect(e.flush()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// BLOCKER 1: absolute agent cursor. next/end advance over private bytes even
// though they are omitted from `bytes`. maxBytes limits emitted visible bytes,
// NOT absolute cursor movement. A second read from `next` must never repeat
// output or recount hidden bytes.
// ---------------------------------------------------------------------------
describe("OutputRing: absolute agent cursor advances over private bytes", () => {
  test("all-private range advances next/end to retainedEnd; bytes empty; privateBytes full", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("secret"), visibility: "human" })
    const agent = ring.readAgent({ from: 0, maxBytes: 1024 })
    expect(agent.bytes.length).toBe(0)
    expect(agent.privateBytes).toBe(6)
    expect(agent.next).toBe(6)
    expect(agent.end).toBe(6)
    expect(agent.truncated).toBe(false)
    expect(agent.eof).toBe(true)
  })

  test("a second read from returned next cursor emits nothing and recounts no private bytes", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("secret"), visibility: "human" })
    const first = ring.readAgent({ from: 0, maxBytes: 1024 })
    const second = ring.readAgent({ from: first.next, maxBytes: 1024 })
    expect(second.bytes.length).toBe(0)
    expect(second.privateBytes).toBe(0)
    expect(second.next).toBe(6)
    expect(second.truncated).toBe(false)
  })

  test("private then shared output is returned exactly once across repeated reads", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("priv"), visibility: "human" }) // 4 bytes
    ring.append({ bytes: enc.encode("shared"), visibility: "shared" }) // 6, total 10
    const first = ring.readAgent({ from: 0, maxBytes: 1024 })
    expect(dec(first.bytes)).toBe("shared")
    expect(first.privateBytes).toBe(4)
    expect(first.next).toBe(10)
    const second = ring.readAgent({ from: first.next, maxBytes: 1024 })
    expect(second.bytes.length).toBe(0)
    expect(second.privateBytes).toBe(0)
    expect(second.next).toBe(10)
  })

  test("shared private shared ordering with repeated bounded reads emits each byte once", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("A"), visibility: "shared" })
    ring.append({ bytes: enc.encode("PRIV"), visibility: "human" })
    ring.append({ bytes: enc.encode("BC"), visibility: "shared" })
    let cursor = 0
    let collected = ""
    let privateTotal = 0
    for (let i = 0; i < 10 && cursor < ring.end(); i++) {
      const r = ring.readAgent({ from: cursor, maxBytes: 2 })
      collected += dec(r.bytes)
      privateTotal += r.privateBytes
      expect(r.next).toBeGreaterThanOrEqual(cursor)
      cursor = r.next
    }
    expect(collected).toBe("ABC")
    expect(privateTotal).toBe(4)
    expect(cursor).toBe(7)
  })

  test("stale cursor plus retained private bytes advances over the full scanned range", () => {
    const ring = new OutputRing({ ringBytes: 10 })
    ring.append({ bytes: enc.encode("aaaaaa"), visibility: "human" })
    ring.append({ bytes: enc.encode("bbb"), visibility: "shared" })
    ring.append({ bytes: enc.encode("ccc"), visibility: "shared" })
    const agent = ring.readAgent({ from: 0, maxBytes: 1024 })
    expect(agent.gap).toBe(true)
    expect(agent.gapStart).toBe(0)
    expect(agent.gapEnd).toBe(ring.start())
    expect(agent.privateBytes).toBe(4)
    expect(dec(agent.bytes)).toBe("bbbccc")
    expect(agent.next).toBe(12)
    expect(agent.end).toBe(12)
    const again = ring.readAgent({ from: agent.next, maxBytes: 1024 })
    expect(again.bytes.length).toBe(0)
    expect(again.privateBytes).toBe(0)
  })

  test("no duplicate visible output after any private interval", () => {
    const ring = new OutputRing()
    ring.append({ bytes: enc.encode("X"), visibility: "shared" })
    ring.append({ bytes: enc.encode("p1p1"), visibility: "human" })
    ring.append({ bytes: enc.encode("Y"), visibility: "shared" })
    ring.append({ bytes: enc.encode("p2"), visibility: "human" })
    ring.append({ bytes: enc.encode("Z"), visibility: "shared" })
    let cursor = 0
    let collected = ""
    for (let i = 0; i < 10 && cursor < ring.end(); i++) {
      const r = ring.readAgent({ from: cursor, maxBytes: 1 })
      collected += dec(r.bytes)
      cursor = r.next
    }
    expect(collected).toBe("XYZ")
    expect(cursor).toBe(9)
  })
})
