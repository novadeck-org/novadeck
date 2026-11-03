import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { HarnessEvent } from "@novadeck/harness-core/events"
import type { Report } from "@novadeck/harness-core/report"
import { loadProbe } from "@novadeck/harness-core/testing/probes"
import { hookReport } from "@novadeck/harness-core/testing/reports"
import { afterEach, describe, expect, it } from "vitest"

import { decode } from "./decode.js"
import { followTranscript, transcriptVersion } from "./transcript-watch.js"

const probe = loadProbe(import.meta.dirname, "version.probe.json") as {
  version: string
  lines: { [kind: string]: string[] }
  statusLine: Report["payload"]
}

// A record about the conversation as Claude Code closes it (see the captured lines), with
// `content` as its text.
const record = (version: string, content = "hi") =>
  `{"type":"user","message":{"role":"user","content":"${content}"},"session_id":"s","userType":"external","entrypoint":"cli","cwd":"/home/user/project","sessionId":"s","version":"${version}","gitBranch":"HEAD"}`

describe("the version of Claude Code that wrote a transcript line, as captured", () => {
  it.each(["user", "attachment", "assistant", "system"])("is on a %s record", (kind) => {
    for (const line of probe.lines[kind]!) expect(transcriptVersion(line)).toBe(probe.version)
  })

  it("is not on its bookkeeping records", () => {
    for (const line of probe.lines.bookkeeping!) expect(transcriptVersion(line)).toBeUndefined()
  })

  it("is found at the end of a line whose content runs on for megabytes", () => {
    expect(transcriptVersion(record(probe.version, "x".repeat(3_000_000)))).toBe(probe.version)
  })

  it("is not read from a version key in the record's content", () => {
    const nested = JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", content: { version: "9.9.9" } }] },
      cwd: "/home/user/project",
    })
    expect(transcriptVersion(nested)).toBeUndefined()
    expect(transcriptVersion(`${nested.slice(0, -1)},${"x".repeat(1000)}}`)).toBeUndefined()
  })

  it("is not taken from a value that is no version", () => {
    expect(transcriptVersion('{"type":"user","version":"latest"}')).toBeUndefined()
    expect(transcriptVersion('{"type":"user","version":""}')).toBeUndefined()
  })
})

describe("the version in Claude Code's status line, as captured", () => {
  it("rides with the telemetry of the session it names", () => {
    const events = decode(hookReport("claude", "StatusLine", probe.statusLine, { seq: 5 }))
    expect(events).toMatchObject([{ type: "telemetry-observed", version: probe.version }])
  })

  it("is left out of a payload without one", () => {
    const { version: _, ...without } = probe.statusLine
    const [event] = decode(hookReport("claude", "StatusLine", without, { seq: 5 }))
    expect(event).not.toHaveProperty("version")
  })
})

describe("following the version a transcript says", () => {
  let folder: string | undefined
  afterEach(() => {
    if (folder) rmSync(folder, { recursive: true, force: true })
    folder = undefined
  })

  it("tells it once, when the first record with one is written, and again if a newer release writes", async () => {
    folder = mkdtempSync(join(tmpdir(), "version-"))
    const path = join(folder, "session.jsonl")
    const line = (version: string) => `${record(version)}\n`
    writeFileSync(path, '{"type":"mode","mode":"normal","sessionId":"s"}\n')
    const told: HarnessEvent[] = []
    const controller = new AbortController()
    const following = followTranscript(
      { sessionId: "s", instance: "7", transcript: path },
      controller.signal,
      (event) => told.push(event),
    )
    const versions = () =>
      told.flatMap((event) => (event.type === "telemetry-observed" ? [event.version] : []))
    const until = async (count: number) => {
      for (let waited = 0; versions().length < count && waited < 5000; waited += 50)
        // eslint-disable-next-line no-await-in-loop -- Polls the file's follower.
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    try {
      appendFileSync(path, line("2.1.300"))
      appendFileSync(path, line("2.1.300"))
      await until(1)
      appendFileSync(path, '{"type":"permission-mode","permissionMode":"default"}\n')
      appendFileSync(path, line("2.1.316"))
      await until(2)
      expect(versions()).toEqual(["2.1.300", "2.1.316"])
      expect(told[0]).toMatchObject({ agent: "claude", sessionId: "s", instance: "7" })
    } finally {
      controller.abort()
      await following
    }
  })
})
