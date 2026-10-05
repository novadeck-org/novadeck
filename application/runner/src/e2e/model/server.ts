import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { promisify } from "node:util"
import { brotliDecompress, gunzip, inflate, zstdDecompress } from "node:zlib"

import { ZodError } from "zod"

import type { Dialect, Request } from "./dialect.js"
import { answer, latest, Refusal, type Call, type Rule } from "./script.js"

/**
 * The fake model: one loopback HTTP server that answers every harness's API, and also
 * serves as their proxy so that any request meant for the internet is refused and
 * recorded rather than sent.
 */
export type FakeModel = {
  /** Where the harnesses' APIs point: `http://127.0.0.1:<port>`. */
  readonly url: string
  /** The proxy every sandboxed process gets as HTTP(S)_PROXY: the same server. */
  readonly proxy: string
  /**
   * The only credential the server accepts. A request carrying any other is refused and
   * recorded as foreign, without its value, which fails the test: a real login leaked in.
   */
  readonly credential: string
  /** The model calls so far, in order. */
  readonly calls: readonly Call[]
  /**
   * Requests no dialect served, as none took them or the one that did answered 404, and
   * connections the proxy refused, by method and host or path.
   */
  readonly strays: readonly string[]
  /** How many requests carried a credential other than `credential`. */
  readonly foreign: number
  /**
   * Requests a dialect failed on, by method, path and the error's message, never their
   * body or headers. Any fails the test: the fake model misread a harness.
   */
  readonly errors: readonly string[]
  /**
   * How many calls have been made so far: a cursor that `waitFor`'s `after` takes, to wait
   * only for a call made from now on.
   */
  readonly mark: () => number
  /**
   * Waits for a call that matches, including one already made, unless it came before
   * `after` (a `mark`). A call counts as made as soon as it arrives, while a rule may
   * still hold its reply. Fails after `timeoutMs`, a minute unless given.
   */
  readonly waitFor: (
    match: (call: Call) => boolean,
    options?: { readonly after?: number; readonly timeoutMs?: number },
  ) => Promise<Call>
  /** Adds rules ahead of the ones given before. */
  readonly use: (...rules: Rule[]) => void
  readonly close: () => Promise<void>
}

export type FakeModelOptions = {
  readonly dialects: readonly Dialect[]
  readonly rules?: readonly Rule[]
}

// Headers that carry a credential, by name, whatever the API: an Authorization or
// Proxy-Authorization, and the API keys, tokens and cookies APIs take in headers of their own.
const credentialHeader = /authorization|api[-_]?key|token|secret|cookie|credential/i

// An auth scheme with nothing after it, as a client sends when its token is empty and Node
// trims the space that followed the scheme.
const schemeAlone = /^\s*(basic|bearer|digest|negotiate|token)?\s*$/i

// The credentials a request carries: its credential headers' values, and the `key` query
// parameter the Gemini API also takes. An empty value, or a scheme alone, carries none.
const credentials = (request: IncomingMessage): string[] => {
  const headers = Object.entries(request.headers)
    .filter(([name]) => credentialHeader.test(name))
    .flatMap(([, value]) => [value ?? ""].flat())
  let key: string | null = null
  try {
    key = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("key")
  } catch {
    // A target no URL can be made of carries no key.
  }
  return [...headers, ...(key === null ? [] : [key])].filter((value) => !schemeAlone.test(value))
}

/**
 * Whether a header's value is the fake credential, alone or after an auth scheme such as
 * Bearer. The value is only compared, never kept.
 */
const isCredential = (value: string, credential: string): boolean =>
  value === credential || value.replace(/^\w+\s+/, "") === credential

const decoders: Readonly<Record<string, (body: Buffer) => Promise<Buffer>>> = {
  gzip: promisify(gunzip),
  deflate: promisify(inflate),
  br: promisify(brotliDecompress),
  zstd: promisify(zstdDecompress),
}

const read = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const body = Buffer.concat(chunks)
  const decode = decoders[String(request.headers["content-encoding"] ?? "").toLowerCase()]
  return (decode ? await decode(body) : body).toString("utf8")
}

// The host a proxied request is for, never its path or query, which may hold a secret.
const hostOf = (target: string): string => {
  try {
    return new URL(target.includes("://") ? target : `http://${target}`).hostname
  } catch {
    return "?"
  }
}

// What went wrong, in a line that names it rather than quoting the body: a parse's first
// issue, by where it is and what it says; for a body that isn't JSON only that, as the
// parser's message quotes the body; or an error message's first line.
const failure = (error: unknown): string => {
  if (error instanceof SyntaxError) return "the body is not JSON"
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    return issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}`.slice(0, 200) : "invalid"
  }
  return ((error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "").slice(
    0,
    200,
  )
}

// One line per call for a timeout's message: whether it was a side call, and what the
// person or a hook last said in it.
const outline = (calls: readonly Call[]): string =>
  calls
    .map(
      (call, index) =>
        `  ${index + 1}. ${call.side ? "(side) " : ""}${JSON.stringify(latest(call).slice(-160))}`,
    )
    .join("\n") || "  (none)"

/**
 * Starts the fake model on a free loopback port. A proxy's request (CONNECT, or one for
 * an absolute URL) is recorded by its host and refused. Any other request is checked for
 * a credential, in its headers or a `key` query parameter; then one a dialect matches is
 * answered by it, and anything else is recorded and answered 404. Every request's
 * credential that isn't the fake one is counted.
 */
export const startFakeModel = async (options: FakeModelOptions): Promise<FakeModel> => {
  const credential = `novadeck-e2e-${randomBytes(16).toString("hex")}`
  const calls: Call[] = []
  const strays: string[] = []
  const errors: string[] = []
  let foreign = 0
  let rules: readonly Rule[] = options.rules ?? []
  const waiters = new Set<(index: number, call: Call) => void>()

  // Counts a request carrying a credential that isn't the fake one, and says so.
  const trespasses = (request: IncomingMessage): boolean => {
    const other = credentials(request).some((one) => !isCredential(one, credential))
    if (other) foreign += 1
    return other
  }

  // The call counts as made, and its waiters hear of it, before any rule answers: a
  // test can see a call whose reply a rule holds.
  const reply = (call: Call) => {
    calls.push(call)
    for (const waiter of waiters) waiter(calls.length - 1, call)
    return answer(rules, call)
  }

  const respond = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const target = incoming.url ?? "/"
    const method = incoming.method ?? "GET"
    // A request for another server is recorded by its host whatever it carried.
    if (!target.startsWith("/")) {
      strays.push(`${method} ${hostOf(target)}`)
      trespasses(incoming)
      outgoing.writeHead(403).end()
      return
    }
    if (trespasses(incoming)) {
      outgoing.writeHead(401, { "content-type": "application/json" })
      outgoing.end(JSON.stringify({ error: { type: "authentication_error", message: "foreign" } }))
      return
    }
    const request: Request = {
      method,
      path: target,
      // Every header but those holding the credential and the body's encoding, now undone.
      headers: Object.fromEntries(
        Object.entries(incoming.headers)
          .filter(([name]) => !credentialHeader.test(name) && name !== "content-encoding")
          .map(([name, value]) => [name, [value ?? ""].flat().join(", ")]),
      ),
      body: await read(incoming),
    }
    const dialect = options.dialects.find((one) => one.matches(request))
    if (!dialect) {
      strays.push(`${method} ${target.split("?")[0]}`)
      outgoing.writeHead(404, { "content-type": "application/json" })
      outgoing.end(JSON.stringify({ error: { type: "not_found_error", message: "not found" } }))
      return
    }
    const response = await dialect.handle(request, reply)
    // A request of the dialect's API it doesn't serve is a stray too: an endpoint the
    // harness needs that the fake model lacks.
    if (response.status === 404) strays.push(`${method} ${target.split("?")[0]}`)
    outgoing.writeHead(response.status, response.headers)
    for (const chunk of typeof response.body === "string" ? [response.body] : response.body)
      outgoing.write(chunk)
    outgoing.end()
  }

  const server = createServer((incoming, outgoing) => {
    respond(incoming, outgoing).catch((error: unknown) => {
      // A rule's refusal: the error each API answers a bad request with, as far as its
      // harness reads one.
      if (error instanceof Refusal && !outgoing.headersSent) {
        outgoing.writeHead(error.status, { "content-type": "application/json" })
        const message = "The fake model refused the request."
        outgoing.end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message, code: error.status },
          }),
        )
        return
      }
      const what = failure(error)
      errors.push(`${incoming.method ?? "GET"} ${(incoming.url ?? "/").split("?")[0]}: ${what}`)
      if (outgoing.headersSent) return outgoing.destroy()
      outgoing.writeHead(500, { "content-type": "application/json" })
      outgoing.end(JSON.stringify({ error: { type: "api_error", message: what } }))
    })
  })
  // A tunnel through the proxy, as for any HTTPS request: refused, by its host alone.
  server.on("connect", (incoming: IncomingMessage, socket: Socket) => {
    trespasses(incoming)
    strays.push(`CONNECT ${hostOf(incoming.url ?? "")}`)
    socket.on("error", () => {})
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    url,
    proxy: url,
    credential,
    get calls() {
      return calls
    },
    get strays() {
      return strays
    },
    get foreign() {
      return foreign
    },
    get errors() {
      return errors
    },
    mark: () => calls.length,
    waitFor: (match, { after = 0, timeoutMs = 60_000 } = {}) => {
      const made = calls.find((call, index) => index >= after && match(call))
      if (made) return Promise.resolve(made)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter)
          reject(
            new Error(
              `No matching model call${after > 0 ? ` from call ${after + 1} on` : ""} in ${timeoutMs} ms. Calls:\n${outline(calls)}`,
            ),
          )
        }, timeoutMs)
        const waiter = (index: number, call: Call) => {
          if (index < after || !match(call)) return
          clearTimeout(timer)
          waiters.delete(waiter)
          resolve(call)
        }
        waiters.add(waiter)
      })
    },
    use: (...added) => {
      rules = [...added, ...rules]
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
