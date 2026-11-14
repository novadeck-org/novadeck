import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { LimitsCover } from "@novadeck/harness-core/events"
import type { Install, LimitsReading } from "@novadeck/harness-core/harness"
import type { AgentName, AgentTelemetry } from "@novadeck/protocol"
import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { askProgram, LimitsReadings, type Ask } from "./limits-reading.js"

type Limits = AgentTelemetry["limits"]

const home = join("/", "home", "person")
const install: Install = {
  env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "a key the sessions declined" },
  home,
  platform: "linux",
  plugin: join(home, "plugins"),
}
const fable = (used: number): Limits => [{ minutes: 10_080, used, resetsAt: 9_000, scope: "Fable" }]
const transcript = (claudeHome: string) =>
  join(claudeHome, "projects", "-home-person-app", "session.jsonl")

// The readings over fake terminals, a clock the case moves and an ask it answers.
const setup = (
  answers: (Limits | null)[] = [fable(0.07)],
  found: () => Promise<Install | undefined> = async () => install,
) => {
  let now = 1_000
  const applied: { record: string; agent: AgentName; limits: Limits; cover: LimitsCover }[] = []
  const asked: { program: string; env: NodeJS.ProcessEnv }[] = []
  const ask = vi.fn<Ask>(async (program, _reading, env) => {
    asked.push({ program, env })
    return answers.shift() ?? null
  })
  const readings = new LimitsReadings<string>(
    {
      install: found,
      apply: (record, agent, limits, cover) => applied.push({ record, agent, limits, cover }),
    },
    { ask, program: async (agent) => `/bin/${agent}`, everyMs: 300, soonMs: 60, now: () => now },
  )
  return {
    readings,
    applied,
    asked,
    ask,
    tick: (ms: number) => (now += ms),
  }
}
// Lets the install lookup and the ask, each a promise the fakes answer at once, settle.
const flush = () => new Promise((resolve) => setImmediate(resolve))

describe("asking a harness for the limits its records leave out", () => {
  it("asks once for an account however many terminals run it, and gives each the answer", async () => {
    const { readings, applied, asked } = setup()
    readings.wanted("a", "claude", transcript(join(home, ".claude")))
    readings.wanted("b", "claude", null)
    await flush()
    readings.wanted("b", "claude", null)
    await flush()
    // Without the key the sessions declined, which print mode would take.
    expect(asked).toEqual([{ program: "/bin/claude", env: { PATH: "/usr/bin" } }])
    expect(applied).toEqual([
      { record: "a", agent: "claude", limits: fable(0.07), cover: "scoped" },
      { record: "b", agent: "claude", limits: fable(0.07), cover: "scoped" },
    ])
  })

  it("asks again only once the wait has passed, or sooner after a turn that ran into a limit", async () => {
    const { readings, asked, tick } = setup([fable(0.07), fable(0.08), fable(0.09)])
    readings.wanted("a", "claude", null)
    await flush()
    tick(100)
    readings.wanted("a", "claude", null)
    await flush()
    expect(asked).toHaveLength(1)
    readings.wanted("a", "claude", null, true)
    await flush()
    expect(asked).toHaveLength(2)
    tick(300)
    readings.wanted("a", "claude", null)
    await flush()
    expect(asked).toHaveLength(3)
  })

  it("gives a terminal that joins an account its latest reading at once", async () => {
    const { readings, applied, asked } = setup()
    readings.wanted("a", "claude", null)
    await flush()
    readings.wanted("b", "claude", null)
    await flush()
    expect(asked).toHaveLength(1)
    expect(applied.map(({ record }) => record)).toEqual(["a", "b"])
  })

  it("keeps another Claude Code home apart, and points the program at it", async () => {
    const { readings, applied, asked } = setup([fable(0.07), fable(0.5)])
    const work = join(home, "claude-work")
    readings.wanted("a", "claude", transcript(join(home, ".claude")))
    readings.wanted("b", "claude", transcript(work))
    await flush()
    expect(asked).toEqual([
      { program: "/bin/claude", env: { PATH: "/usr/bin" } },
      { program: "/bin/claude", env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: work } },
    ])
    expect(applied.map(({ record, limits }) => [record, limits])).toEqual([
      ["a", fable(0.07)],
      ["b", fable(0.5)],
    ])
  })

  it("gives a terminal forgotten meanwhile nothing, and an answer that tells nothing to none", async () => {
    const { readings, applied } = setup([fable(0.07), null])
    readings.wanted("a", "claude", null)
    readings.forget("a")
    await flush()
    expect(applied).toEqual([])
    const other = setup([null])
    other.readings.wanted("a", "claude", null)
    await flush()
    expect(other.applied).toEqual([])
  })

  it("asks once the sooner wait is over, for a turn that ran into a limit just after an ask", async () => {
    const { readings, asked, applied } = setup([fable(0.93), fable(1)])
    readings.wanted("a", "claude", null)
    await flush()
    readings.wanted("a", "claude", null, true)
    await flush()
    expect(asked).toHaveLength(1)
    // The fake clock stands still, so the ask waits the whole 60 ms, set once however often wanted.
    readings.wanted("a", "claude", null, true)
    await vi.waitFor(() => expect(asked).toHaveLength(2))
    await vi.waitFor(() => expect(applied.at(-1)?.limits).toEqual(fable(1)))
  })

  it("moves a terminal to the account its transcript names once it is known", async () => {
    const { readings, applied, asked } = setup([fable(0.07), fable(0.5)])
    readings.wanted("a", "claude", null)
    await flush()
    readings.wanted("a", "claude", transcript(join(home, "claude-work")))
    await flush()
    expect(asked).toHaveLength(2)
    expect(applied.map(({ limits }) => limits)).toEqual([fable(0.07), fable(0.5)])
  })

  it("looks for an install it didn't find again only after the wait", async () => {
    const found = vi.fn<() => Promise<Install | undefined>>(async () => undefined)
    const { readings, ask, tick } = setup([fable(0.07)], found)
    readings.wanted("a", "claude", null)
    await flush()
    readings.wanted("a", "claude", null)
    await flush()
    expect(found).toHaveBeenCalledTimes(1)
    tick(300)
    found.mockResolvedValue(install)
    readings.wanted("a", "claude", null)
    await flush()
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it("asks nothing of a harness whose records tell all its windows", async () => {
    const { readings, ask } = setup()
    readings.wanted("a", "codex", null)
    readings.wanted("b", "agy", null)
    await flush()
    expect(ask).not.toHaveBeenCalled()
  })
})

describe("asking a program", () => {
  // A stand-in for the harness, run by Node: it reads what it was written, then writes
  // `lines`, each one alone.
  const program = (folder: string, lines: readonly string[], wait = 0) => {
    const script = join(folder, "harness.mjs")
    writeFileSync(
      script,
      `let input = ""
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => setTimeout(() => {
  for (const line of ${JSON.stringify(lines)}) process.stdout.write(line.replace("INPUT", input.trim()) + "\\n")
}, ${wait}))
`,
    )
    return script
  }
  const reading = (script: string): LimitsReading => ({
    args: [script],
    input: "ask\n",
    read: (line) => (line.startsWith("answer ") ? fable(Number(line.slice(7)) || 0) : undefined),
    cover: "scoped",
    account: () => ({ key: "", env: {} }),
  })

  it("reads its answer past the lines before it, from what it was written", async ({
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-limits-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const script = program(folder, ["noise", "INPUT 0.5", "answer 0.25"])
    expect(
      await askProgram(process.execPath, reading(script), process.env, process.platform, 10_000),
    ).toEqual(fable(0.25))
  })

  it("gives null for a program that ends without an answer, or takes too long", async ({
    resources,
  }) => {
    const folder = mkdtempSync(join(tmpdir(), "novadeck-limits-"))
    resources.defer(() => rmSync(folder, { recursive: true, force: true }))
    const silent = program(folder, ["noise"])
    expect(
      await askProgram(process.execPath, reading(silent), process.env, process.platform, 10_000),
    ).toBeNull()
    const slow = program(folder, ["answer 1"], 5_000)
    expect(
      await askProgram(process.execPath, reading(slow), process.env, process.platform, 200),
    ).toBeNull()
  })
})
