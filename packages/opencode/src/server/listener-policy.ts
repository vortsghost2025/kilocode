// kilocode_change - new file

export namespace ListenerPolicy {
  export interface Policy {
    readonly hostname: string
    readonly loopbackOnly: boolean
    readonly allowedOrigins: readonly string[]
  }

  // Opaque publication identity returned by setFromServerConfig. A server
  // stop must release ONLY the policy it published; a stale stop belonging to
  // an older publication must not clear a newer server's policy.
  export type PublicationToken = number

  // localhost, 127.0.0.1 and ::1 are loopback. 0.0.0.0 and :: are not.
  function isLoopback(h: string): boolean {
    return h === "localhost" || h === "127.0.0.1" || h === "::1"
  }

  function build(hostname: string, allowedOrigins?: string[]): Policy {
    return {
      hostname,
      loopbackOnly: isLoopback(hostname),
      allowedOrigins:
        allowedOrigins && allowedOrigins.length > 0 ? Object.freeze([...allowedOrigins]) : Object.freeze([]),
    }
  }

  let currentPolicy: Policy | undefined
  let currentToken: PublicationToken = 0

  export function setFromServerConfig(hostname: string, allowedOrigins?: string[]): PublicationToken {
    currentToken = currentToken + 1
    currentPolicy = Object.freeze(build(hostname, allowedOrigins))
    return currentToken
  }

  export function current(): Policy | undefined {
    return currentPolicy ? Object.freeze(build(currentPolicy.hostname, [...currentPolicy.allowedOrigins])) : undefined
  }

  // Production-safe release: clears the retained policy only if the supplied
  // token matches the publication that currently owns it. A stale stop from an
  // older publication is a no-op and never clears a newer server's policy.
  export function release(token: PublicationToken): boolean {
    if (token !== currentToken) return false
    currentPolicy = undefined
    return true
  }

  export function clearForTest(): void {
    currentPolicy = undefined
    currentToken = 0
  }
}
