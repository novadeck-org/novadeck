import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { TelemetryObserved } from "@novadeck/harness-core/events"
import type { Install } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"
import { afterEach, beforeEach, vi } from "vitest"

import { started } from "../../harnesses/activity.js"
import { describe, expect, it } from "../../test.js"
import { adapterFolder } from "../../testing/adapters.js"
import type { Record } from "../record.js"
import { Bindings, type BindingsHost } from "./facts.js"

let temporary = ""
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "novadeck-facts-limits-"))
})
afterEach(async () => {
  await rm(temporary, { recursive: true, force: true })
})

/**
 * A stand-in for Claude Code on PATH: it reads the request it is written and answers with
 * the probe's answer to `get_usage`, counting each time it is asked in `asked`.
 */
const fakeClaude = async (): Promise<Install> => {
  const probe = JSON.parse(
    await readFile(join(adapterFolder("claude"), "fixtures", "usage.probe.json"), "utf8"),
  ) as { line: string }
  const script = join(temporary, "claude.mjs")
  await writeFile(
    script,
    `import { appendFileSync } from "node:fs"
let input = ""
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(join(temporary, "asked"))}, input)
  process.stdout.write(${JSON.stringify(`{"type":"system","subtype":"init"}\n${probe.line}\n`)})
})
`,
  )
  const windows = process.platform === "win32"
  await writeFile(
    join(temporary, windows ? "claude.cmd" : "claude"),
    windows
      ? `@"${process.execPath}" "${script}"\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`,
    { mode: 0o755 },
  )
  return {
    env: { ...process.env, PATH: temporary },
    home: temporary,
    platform: process.platform,
    plugin: temporary,
  }
}

const record = (agent: AgentName = "claude") =>
  ({
    summary: { id: "t1" },
    closed: false,
    bound: {
      binding: { agent, sessionId: "s1", instance: "41" },
      activity: started(0),
      telemetry: null,
    },
    transcript: null,
    actorWatches: new Map(),
  }) as unknown as Record

// The account's windows as Claude Code's status line tells them.
const statusLine = (startedAt: number) =>
  ({
    type: "telemetry-observed" as const,
    agent: "claude" as const,
    sessionId: "s1",
    instance: "41",
    startedAt,
    limits: [
      { minutes: 300, used: 0.4, resetsAt: startedAt + 3_600_000 },
      { minutes: 10_080, used: 0.21, resetsAt: startedAt + 86_400_000 },
    ],
    limitsCover: "account" as const,
  }) satisfies TelemetryObserved

describe("a Claude Code session's model windows", () => {
  it("are asked of Claude Code once its status line tells limits, and stay through the next", async () => {
    const install = await fakeClaude()
    const bindings = new Bindings({
      stopping: () => false,
      install: async () => install,
      messaging: () => ({ ringing: () => undefined }),
    } as unknown as BindingsHost)
    const published = vi.spyOn(bindings, "publishAgent").mockImplementation(() => {})
    const each = record()
    bindings.appliedFact(each, statusLine(Date.now()))
    await vi.waitFor(() => expect(published).toHaveBeenCalled(), { timeout: 10_000 })
    const fable = {
      minutes: 10_080,
      used: 0.07,
      resetsAt: Date.parse("2026-11-16T14:00:00.166468+00:00"),
      scope: "Fable",
    }
    expect(each.bound?.telemetry?.limits).toContainEqual(fable)
    const asked = await readFile(join(temporary, "asked"), "utf8")
    expect(JSON.parse(asked)).toMatchObject({
      type: "control_request",
      request: { subtype: "get_usage" },
    })
    // The next status line replaces the account's windows and leaves the model's be, and asks
    // nothing more so soon.
    bindings.appliedFact(each, statusLine(Date.now() + 1_000))
    expect(each.bound?.telemetry?.limits).toEqual([
      ...statusLine(0).limits.map((limit) => ({ ...limit, resetsAt: expect.any(Number) })),
      fable,
    ])
    expect(await readFile(join(temporary, "asked"), "utf8")).toBe(asked)
  })
})
