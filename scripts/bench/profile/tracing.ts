import { createWriteStream, readFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"

import type { TraceEvent } from "./trace.ts"

// Chromium traces, recorded through the DevTools protocol's Tracing domain on the browser's
// own endpoint, as chrome://tracing and the Performance panel do. Electron's `contentTracing`
// writes Perfetto's protobuf since Electron 45 (the file isn't JSON whatever its name), which
// nothing in the bench reads; `Tracing.start` takes a `streamFormat` of `json`. The browser
// endpoint records every process the app runs: the browser, the page's renderer, the GPU
// process and the utility processes (the runner's, the network service...). A page's own
// session records the browser, the renderer and the GPU process only.

/** What a trace records, as the protocol names it. */
export type TraceConfig = {
  readonly includedCategories: readonly string[]
  readonly traceBufferSizeInKb: number
  /** Chromium's own memory dump config, whose keys are snake case. */
  readonly memoryDumpConfig?: {
    readonly triggers: readonly { readonly mode: string; readonly periodic_interval_ms: number }[]
  }
}

/** A DevTools protocol connection: what a recording needs of one. */
export type Cdp = {
  readonly send: (method: string, params?: object) => Promise<Record<string, unknown>>
  /** Resolves with the params of the next `event`; rejects on timeout or a closed connection. */
  readonly next: (event: string, timeoutMs: number) => Promise<Record<string, unknown>>
  readonly close: () => void
}

/** Connects to the browser's DevTools endpoint, which it names in `<userData>/DevToolsActivePort`. */
export const connectBrowser = async (userData: string): Promise<Cdp> => {
  const [port, path] = readFileSync(join(userData, "DevToolsActivePort"), "utf8").trim().split("\n")
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("no DevTools connection")), {
      once: true,
    })
  })
  let counter = 0
  const calls = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >()
  const waiting = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }[]
  >()
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data)) as {
      id?: number
      method?: string
      params?: Record<string, unknown>
      result?: Record<string, unknown>
      error?: { message?: string }
    }
    if (data.id !== undefined) {
      const call = calls.get(data.id)
      calls.delete(data.id)
      if (data.error) call?.reject(new Error(data.error.message ?? "a DevTools call failed"))
      else call?.resolve(data.result ?? {})
    } else if (data.method) {
      for (const each of waiting.get(data.method) ?? []) each.resolve(data.params ?? {})
      waiting.delete(data.method)
    }
  })
  const lost = () => {
    const error = new Error("the DevTools connection closed")
    for (const call of calls.values()) call.reject(error)
    for (const each of waiting.values()) for (const one of each) one.reject(error)
    calls.clear()
    waiting.clear()
  }
  socket.addEventListener("close", lost)
  return {
    send: (method, params) =>
      new Promise((resolve, reject) => {
        counter += 1
        calls.set(counter, { resolve, reject })
        socket.send(JSON.stringify({ id: counter, method, params }))
      }),
    next: (event, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`no ${event} within ${timeoutMs / 1000} s`))
        }, timeoutMs)
        const done =
          <T>(settle: (value: T) => void) =>
          (value: T) => {
            clearTimeout(timer)
            settle(value)
          }
        waiting.set(event, [
          ...(waiting.get(event) ?? []),
          { resolve: done(resolve), reject: done(reject) },
        ])
      }),
    close: () => socket.close(),
  }
}

/** How long a recording that has been told to end may take to say it has. */
const endingMs = 120_000

/** Reads the stream `handle` to its end into the file at `path`. */
export const saveStream = async (cdp: Cdp, handle: string, path: string): Promise<void> => {
  const file = createWriteStream(path)
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- The stream is read in order.
      const chunk = (await cdp.send("IO.read", { handle, size: 4 * 1024 * 1024 })) as {
        data: string
        base64Encoded?: boolean
        eof?: boolean
      }
      if (!file.write(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8")))
        // eslint-disable-next-line no-await-in-loop -- As above.
        await new Promise((resolve) => file.once("drain", resolve))
      if (chunk.eof) break
    }
  } finally {
    await new Promise<void>((resolve) => file.end(resolve))
  }
  await cdp.send("IO.close", { handle })
}

/** A trace being recorded; `stop` ends it and saves it, gzipped JSON, at `path`. */
export type Recording = { readonly stop: (path: string) => Promise<void> }

/** Starts recording a trace of the whole app, over `cdp`, which `stop` closes. */
export const record = async (cdp: Cdp, config: TraceConfig): Promise<Recording> => {
  try {
    await cdp.send("Tracing.start", {
      traceConfig: { recordMode: "recordUntilFull", ...config },
      transferMode: "ReturnAsStream",
      streamFormat: "json",
      streamCompression: "gzip",
    })
  } catch (cause) {
    cdp.close()
    throw cause
  }
  return {
    stop: async (path) => {
      try {
        const complete = cdp.next("Tracing.tracingComplete", endingMs)
        // A connection that closes under it settles `complete` too.
        complete.catch(() => {})
        await cdp.send("Tracing.end")
        const { stream } = (await complete) as { stream?: string }
        if (!stream) throw new Error("Chromium gave the trace no stream")
        await saveStream(cdp, stream, path)
      } finally {
        cdp.close()
      }
    },
  }
}

/** Starts recording a trace of the app whose user data folder is `userData`. */
export const startTrace = async (userData: string, config: TraceConfig): Promise<Recording> =>
  record(await connectBrowser(userData), config)

/** A saved trace: Chromium's events and the metadata it records about the machine. */
export type Trace = {
  readonly traceEvents?: TraceEvent[]
  readonly metadata?: unknown
}

/** Reads a trace `startTrace` saved. Fails past about 512 MB of JSON, Node's longest string. */
export const readTrace = (path: string): Trace =>
  JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as Trace
