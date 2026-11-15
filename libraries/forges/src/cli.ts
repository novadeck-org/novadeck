import type { Problem, Ran } from "./forge.js"

/** A failed run as a Problem: a missing tool, one too slow, or `exit` as the caller reads it. */
export const failure = (
  ran: Extract<Ran, { ok: false }>,
  onExit: (said: string) => Problem,
): Problem =>
  ran.kind === "missing"
    ? { kind: "missing" }
    : ran.kind === "timeout"
      ? { kind: "unreachable" }
      : onExit(ran.said)

// What tools say when the network failed them: Go's net errors (gh, glab), Python's requests
// and urllib3 (az).
const networkFailure =
  /no such host|dial tcp|i\/o timeout|connection refused|connection reset|network is unreachable|temporary failure in name resolution|could not resolve|failed to establish a new connection|max retries exceeded|connectionerror|getaddrinfo|tls handshake timeout|timed out/i

/** Whether what a failing tool said is the network failing, which says nothing of a sign-in. */
export const offline = (said: string): boolean => networkFailure.test(said)

export const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
