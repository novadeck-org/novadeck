import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readTrace } from "./tracing.ts"

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
