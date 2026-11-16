import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readTrace, record, saveStream, type Cdp } from "./tracing.ts"

describe("readTrace", () => {
  let folder = ""
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "profile-trace-"))
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it("reads the gzipped JSON a recording saves: its events and its metadata", () => {
    const path = join(folder, "phase.json.gz")
    const trace = {
      traceEvents: [{ name: "profile-start", ph: "I", pid: 1, tid: 2, ts: 3 }],
      metadata: { "cpu-brand": "a CPU" },
    }
    writeFileSync(path, gzipSync(JSON.stringify(trace)))
    expect(readTrace(path)).toEqual(trace)
  })

  it("fails on a file that isn't gzip, as Perfetto's protobuf behind a .json.gz name wasn't", () => {
    const path = join(folder, "phase.json.gz")
    writeFileSync(path, Buffer.from([0x0a, 0x65, 0x32, 0x5b]))
    expect(() => readTrace(path)).toThrow(/header/)
  })
})

// A DevTools connection that answers from a script, and says what it was asked.
const fake = (
  answer: (method: string, params?: object) => Record<string, unknown>,
  ending: () => Promise<Record<string, unknown>> = () => Promise.resolve({ stream: "s1" }),
): Cdp & { readonly calls: string[]; closed: boolean } => {
  const calls: string[] = []
  const cdp = {
    calls,
    closed: false,
    send: (method: string, params?: object) => {
      calls.push(method)
      return Promise.resolve(answer(method, params))
    },
    next: () => ending(),
    close: () => {
      cdp.closed = true
    },
  }
  return cdp
}

describe("saveStream", () => {
  let folder = ""
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "profile-stream-"))
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it("reads the stream to its end, base64 or not, then closes it", async () => {
    const pieces = [
      { data: Buffer.from("ab").toString("base64"), base64Encoded: true },
      { data: "cd", base64Encoded: false },
      { data: Buffer.from("ef").toString("base64"), base64Encoded: true, eof: true },
    ]
    const cdp = fake((method) => (method === "IO.read" ? pieces.shift()! : {}))
    const path = join(folder, "out")
    await saveStream(cdp, "s1", path)
    expect(readFileSync(path, "utf8")).toBe("abcdef")
    expect(cdp.calls).toEqual(["IO.read", "IO.read", "IO.read", "IO.close"])
  })
})

describe("record", () => {
  let folder = ""
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), "profile-record-"))
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it("starts JSON gzip streaming, ends, saves what streams and closes the connection", async () => {
    const started: object[] = []
    const cdp = fake((method, params) => {
      if (method === "Tracing.start") started.push(params!)
      return method === "IO.read" ? { data: "x", eof: true } : {}
    })
    const recording = await record(cdp, {
      includedCategories: ["toplevel"],
      traceBufferSizeInKb: 8,
    })
    await recording.stop(join(folder, "t.json.gz"))
    expect(started[0]).toMatchObject({ streamFormat: "json", transferMode: "ReturnAsStream" })
    expect(cdp.calls).toEqual(["Tracing.start", "Tracing.end", "IO.read", "IO.close"])
    expect(cdp.closed).toBe(true)
  })

  it("fails, and closes the connection, when the recording never completes", async () => {
    const cdp = fake(
      () => ({}),
      () => Promise.reject(new Error("no Tracing.tracingComplete within 120 s")),
    )
    const recording = await record(cdp, { includedCategories: [], traceBufferSizeInKb: 8 })
    await expect(recording.stop(join(folder, "t.json.gz"))).rejects.toThrow(/tracingComplete/)
    expect(cdp.closed).toBe(true)
  })

  it("fails when the browser closes under it", async () => {
    const cdp = fake(
      () => ({}),
      () => Promise.reject(new Error("the DevTools connection closed")),
    )
    const recording = await record(cdp, { includedCategories: [], traceBufferSizeInKb: 8 })
    await expect(recording.stop(join(folder, "t.json.gz"))).rejects.toThrow(/closed/)
  })
})
