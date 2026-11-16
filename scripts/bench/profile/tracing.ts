import { createWriteStream, readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"

import type { CDPSession, Page } from "playwright"

import type { TraceEvent } from "./trace.ts"

// Chromium traces, recorded through the DevTools protocol's Tracing domain, as the
// Performance panel does. Electron's own `contentTracing` writes Perfetto's protobuf since
// Electron 45 (the file isn't JSON whatever its name), which nothing in the bench reads; the
// protocol's `Tracing.start` takes a `streamFormat` of `json`, and records every process the
// browser runs, the page's renderer and the GPU process among them, as `contentTracing` did.

/** What a trace records, as the protocol names it. */
export type TraceConfig = {
  readonly includedCategories: readonly string[]
  readonly traceBufferSizeInKb: number
  /** Chromium's own memory dump config, whose keys are snake case. */
  readonly memoryDumpConfig?: {
    readonly triggers: readonly { readonly mode: string; readonly periodic_interval_ms: number }[]
  }
}

/** A trace being recorded; `stop` ends it and saves it, gzipped JSON, at `path`. */
export type Recording = { readonly stop: (path: string) => Promise<void> }

/** Starts recording a trace of the whole app through `page`'s DevTools session. */
export const startTrace = async (page: Page, config: TraceConfig): Promise<Recording> => {
  const session: CDPSession = await page.context().newCDPSession(page)
  const complete = new Promise<{ stream?: string }>((resolve) => {
    session.once("Tracing.tracingComplete", resolve)
  })
  await session.send("Tracing.start", {
    traceConfig: { recordMode: "recordUntilFull", ...config },
    transferMode: "ReturnAsStream",
    streamFormat: "json",
    streamCompression: "gzip",
  } as never)
  return {
    stop: async (path) => {
      try {
        await session.send("Tracing.end")
        const { stream } = await complete
        if (!stream) throw new Error("Chromium gave the trace no stream")
        const file = createWriteStream(path)
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- The stream is read in order.
          const chunk = await session.send("IO.read", { handle: stream, size: 4 * 1024 * 1024 })
          // eslint-disable-next-line no-await-in-loop -- As above.
          if (!file.write(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8")))
            // eslint-disable-next-line no-await-in-loop -- As above.
            await new Promise((resolve) => file.once("drain", resolve))
          if (chunk.eof) break
        }
        await new Promise<void>((resolve, reject) => {
          file.once("error", reject)
          file.end(resolve)
        })
        await session.send("IO.close", { handle: stream })
      } finally {
        await session.detach().catch(() => {})
      }
    },
  }
}

/** A saved trace: Chromium's events and the metadata it records about the machine. */
export type Trace = {
  readonly traceEvents?: TraceEvent[]
  readonly metadata?: unknown
}

/** Reads a trace `startTrace` saved. Fails past about 512 MB of JSON, Node's longest string. */
export const readTrace = (path: string): Trace =>
  JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as Trace
