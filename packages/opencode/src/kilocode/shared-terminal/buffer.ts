import { SharedTerminalSchema as S } from "./schema"

// UTF-8 streaming encoder and an absolute-byte offset ring buffer with
// per-chunk visibility. The legacy /pty service counts JavaScript string code
// units and silently drops stale history; this module instead:
//   * carries a trailing high surrogate across `onData` callback boundaries,
//     emitting U+FFFD only for an unmatched surrogate on flush,
//   * stores output as an absolute safe-integer byte ring (8 MiB default),
//   * tags every chunk as `shared` or `human`, and
//   * reports gaps explicitly (truncated:true, gap:true) rather than silently
//     reconstructing from a partially-evicted history.

const ENC = new TextEncoder()
const FFFD = ENC.encode("\uFFFD")

// ---------------------------------------------------------------------------
// StreamingEncoder
// ---------------------------------------------------------------------------

// A stateful UTF-8 encoder that is safe to feed arbitrary JS-string chunks.
// Offsets are byte offsets, independent of where the caller split the input.
// A dangling high surrogate at the end of a chunk is held until the next call;
// flush() emits U+FFFD for any still-unmatched surrogate.
export class StreamingEncoder {
  private pending: number | undefined
  private bytes = 0

  // Encode one JS string and return the UTF-8 bytes that are now complete.
  // A trailing high surrogate is held internally and emitted with the next
  // call (or as U+FFFD on flush).
  push(input: string): Uint8Array[] {
    const out: Uint8Array[] = []
    let i = 0
    const len = input.length

    if (this.pending !== undefined && len > 0) {
      const high = this.pending
      this.pending = undefined
      const low = input.charCodeAt(i)
      const matched = low >= 0xdc00 && low <= 0xdfff
      const bytes = matched ? ENC.encode(String.fromCodePoint(high, low)) : FFFD
      out.push(bytes)
      this.bytes += bytes.length
      if (matched) i += 1
    }

    while (i < len) {
      const code = input.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const atTail = i + 1 === len
        if (atTail) {
          this.pending = code
          i += 1
          continue
        }
        const low = input.charCodeAt(i + 1)
        if (low >= 0xdc00 && low <= 0xdfff) {
          const bytes = ENC.encode(String.fromCodePoint(code, low))
          out.push(bytes)
          this.bytes += bytes.length
          i += 2
          continue
        }
        out.push(FFFD)
        this.bytes += FFFD.length
        i += 1
        continue
      }

      if (code >= 0xdc00 && code <= 0xdfff) {
        out.push(FFFD)
        this.bytes += FFFD.length
        i += 1
        continue
      }

      const bytes = ENC.encode(input[i])
      out.push(bytes)
      this.bytes += bytes.length
      i += 1
    }

    return out
  }

  // Emit any held high surrogate as U+FFFD. Returns the replacement bytes.
  // Called exactly once when the PTY exits (or during an explicit reset).
  // Subsequent pushes begin fresh.
  flush(): Uint8Array[] {
    if (this.pending === undefined) return []
    this.pending = undefined
    this.bytes += FFFD.length
    return [FFFD]
  }

  cursor(): number {
    return this.bytes
  }

  reset(): void {
    this.pending = undefined
    this.bytes = 0
  }
}

// ---------------------------------------------------------------------------
// OutputRing
// ---------------------------------------------------------------------------

type Visibility = "shared" | "human"

interface StoredChunk {
  start: number // absolute byte offset (inclusive)
  end: number // absolute byte offset (exclusive)
  visibility: Visibility
  bytes: Uint8Array
}

export interface RingAppendInput {
  bytes: Uint8Array
  visibility: Visibility
}

export interface RingReadInput {
  from: number
  maxBytes?: number
}

export interface RingReadResult {
  terminalID: string // empty here; the service fills it
  requested: number
  start: number
  end: number
  next: number
  truncated: boolean
  privateBytes: number
  eof: boolean
  text: string
  bytes: Uint8Array
  gap: boolean
  gapStart?: number
  gapEnd?: number
}

export class OutputRing {
  private chunks: StoredChunk[] = []
  private startOffset = 0
  private endOffset = 0
  private readonly cap: number

  constructor(opts: { ringBytes?: number } = {}) {
    this.cap = opts.ringBytes ?? S.LIMITS.RING_BYTES
  }

  start(): number {
    return this.startOffset
  }

  end(): number {
    return this.endOffset
  }

  append(input: RingAppendInput): void {
    const n = input.bytes.length
    if (n === 0) return
    const chunk: StoredChunk = {
      start: this.endOffset,
      end: this.endOffset + n,
      visibility: input.visibility,
      bytes: input.bytes,
    }
    this.chunks.push(chunk)
    this.endOffset += n
    this.evict()
  }

  private evict(): void {
    while (this.startOffset < this.endOffset && this.endOffset - this.startOffset > this.cap) {
      const head = this.chunks[0]
      if (!head) break
      const overage = this.endOffset - this.startOffset - this.cap
      if (head.end - head.start <= overage) {
        // Drop the whole leading chunk.
        this.startOffset = head.end
        this.chunks.shift()
        continue
      }
      // Partial eviction of the leading chunk.
      const drop = overage
      const remaining = head.bytes.subarray(drop)
      this.chunks[0] = {
        start: head.start + drop,
        end: head.end,
        visibility: head.visibility,
        bytes: remaining,
      }
      this.startOffset = head.start + drop
    }
  }

  // Bounded read for human subscribers: returns RAW visible bytes (shared plus
  // human chunks). Gaps are reported for stale cursors.
  readHuman(input: RingReadInput): RingReadResult {
    return this.read(input, { reader: "human" })
  }

  // Bounded read for agents: human chunks are OMITTED (never returned as raw
  // bytes); their byte count becomes privateBytes. Gaps are reported.
  readAgent(input: RingReadInput): RingReadResult {
    return this.read(input, { reader: "agent" })
  }

  private read(input: RingReadInput, opts: { reader: "human" | "agent" }): RingReadResult {
    const requested = input.from < 0 ? 0 : Math.floor(input.from)
    if (requested > this.endOffset) {
      // BLOCKER 3: a future cursor cannot be silently rewound. The only legal
      // "nothing new" position is exactly the end. Anything beyond it is a
      // contract violation that callers must surface, not paper over.
      throw S.SharedTerminalError.create("read_out_of_range", {
        message: `read cursor ${requested} is beyond the retained end ${this.endOffset}`,
      })
    }
    const max = this.boundMax(input.maxBytes)
    const retainedStart = this.startOffset
    const retainedEnd = this.endOffset

    const gap = requested < retainedStart
    const gapStart = gap ? requested : undefined
    const gapEnd = gap ? retainedStart : undefined

    // Effective read window. Start clamps the requested cursor up to the
    // retained start (a stale cursor becomes a gap, not a silent skip). The
    // window end is the retained end; reads never fabricate bytes past it.
    const effStart = Math.max(requested, retainedStart)
    const effEnd = retainedEnd

    const out: Uint8Array[] = []
    let privateBytes = 0
    let emitted = 0
    let cursor = effStart
    let truncated = false

    if (effStart < retainedEnd) {
      for (const c of this.chunks) {
        if (c.end <= effStart) continue
        if (c.start >= effEnd) break

        const overlapStart = Math.max(c.start, effStart)
        const overlapEnd = Math.min(c.end, effEnd)
        const off = overlapStart - c.start
        const len = overlapEnd - overlapStart
        if (len <= 0) continue
        const hidden = opts.reader === "agent" && c.visibility === "human"

        // BLOCKER 1: the absolute cursor advances over EVERY scanned byte.
        // privateBytes counts hidden bytes scanned; `bytes` omits them.
        // max caps emitted VISIBLE bytes only; hidden bytes do not consume
        // the visible budget and never cause truncation on their own.
        if (hidden) {
          privateBytes += len
          cursor += len
          continue
        }

        if (emitted >= max) {
          truncated = true
          break
        }
        const take = Math.min(len, max - emitted)
        out.push(c.bytes.subarray(off, off + take))
        emitted += take
        cursor += take
        if (take < len) {
          // Visible budget exhausted; remaining bytes in this chunk (and any
          // later chunks) are left for the next read, so stop scanning.
          truncated = true
          break
        }
      }
    }

    const bytes = concat(out)
    // next is the absolute terminal-stream cursor consumed by this read; it
    // advances over both visible and hidden bytes. end is the end of the
    // scanned range and equals next for a successful read (see schema refine).
    const next = cursor
    const start = gap ? retainedStart : effStart
    const end = next

    return {
      terminalID: "",
      requested,
      start,
      end,
      next,
      truncated: truncated || gap,
      privateBytes,
      eof: next >= retainedEnd,
      text: "",
      bytes,
      gap,
      gapStart,
      gapEnd,
    }
  }

  private boundMax(req: number | undefined): number {
    const wanted = req ?? S.LIMITS.READ_DEFAULT_BYTES
    if (!Number.isFinite(wanted) || wanted <= 0) return S.LIMITS.READ_DEFAULT_BYTES
    return Math.min(Math.floor(wanted), S.LIMITS.READ_MAX_BYTES)
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0)
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
