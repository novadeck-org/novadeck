import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { agentLimits } from "@novadeck/protocol"
import { vi } from "vitest"

import { logs, useLogger } from "../log.js"
import { describe, expect, it } from "../test.js"
import type { Turns } from "./receipt-match.js"
import { Receipts, type ReceiptSource } from "./receipts.js"

const terminal = "t1"
const slackMs = 50

/** A record of one JSON line per item, `{ "text": … }`, read as the user's text, at `at`. */
const items: ReceiptSource["items"] = (line) => {
  const { text, at = 0 } = JSON.parse(line) as { text: string; at?: number }
  return [
    { role: "user", kind: "text", text, at } as ReturnType<
      NonNullable<Harness["transcripts"]>["items"]
    >[number],
  ]
}
const row = (text: string, at?: number) => `${JSON.stringify({ text, at })}\n`

/** The runner's log lines while a test runs. */
const capture = (resources: { defer: (cleanup: () => void) => void }) => {
  const lines: { level: string; evt: string }[] = []
  const before = logs.current()
  const note = (level: string) => (evt: string) => void lines.push({ level, evt })
  useLogger({
    for: () => ({
      debug: note("debug"),
      info: note("info"),
      warn: note("warn"),
      error: note("error"),
      fatal: note("fatal"),
    }),
    flush: () => {},
    close: () => {},
  })
  resources.defer(() => useLogger(before))
  return lines
}

const setup = async (
  resources: { defer: (cleanup: () => void | Promise<void>) => void },
  initial = "",
) => {
  const folder = await mkdtemp(join(tmpdir(), "novadeck-receipts-"))
  resources.defer(() => rm(folder, { recursive: true, force: true }))
  const path = join(folder, "record.jsonl")
  await writeFile(path, initial)
  const clock = { now: 1_000 }
  const host = {
    agent: "claude" as ReceiptSource["agent"],
    key: "session-1" as string | null,
    shown: undefined as ReceiptSource["agent"] | undefined,
    interruptions: [] as { offset: number }[],
    // Holds the record's lookup until released, as a slow `locate`.
    lookup: undefined as Promise<void> | undefined,
    turns: { working: false, endedAt: null } as Turns,
    box: undefined as string | undefined,
    changes: 0,
  }
  const receipts = new Receipts(
    {
      source: async () => (
        await host.lookup,
        {
          key: "session-1",
          agent: host.agent,
          version: "1.0.0",
          path,
          items,
        }
      ),
      bound: () => host.key,
      shown: () => host.shown,
      interruptions: () => host.interruptions,
      turns: () => host.turns,
      box: async () => host.box,
      changed: () => void (host.changes += 1),
    },
    { now: () => clock.now, slackMs, pollMs: 5, keepMs: 30, lateMs: 1_000 },
  )
  resources.defer(() => receipts.close())
  const state = (ref: string) => receipts.view(terminal).find((each) => each.ref === ref)?.state
  /** Sends a prompt as the typist does: expected, then its Enter. */
  const give = async (text: string, ref: string) => {
    const result = await receipts.expect(terminal, text, ref)
    receipts.sent(terminal, ref)
    return result
  }
  /** Moves the clock past the slack and lets the record be read to its end after it. */
  const pass = async () => {
    clock.now += slackMs + 1
    receipts.changed(terminal)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  return { path, clock, host, receipts, state, give, pass }
}

describe("prompt receipts", () => {
  it("withdraws a prompt back in the agent's box once a Stop hands its words back", async ({
    resources,
  }) => {
    const { host, receipts, state, give, pass } = await setup(resources)
    host.box = "check the logs"
    await give("check the logs", "r1")
    await pass()
    await vi.waitFor(() => expect(state("r1")).toBe("in-box"))
    receipts.withdraw(terminal, "check the logs")
    expect(state("r1")).toBe("withdrawn")
  })

  it("lets a late record settle a missing prompt only within the cap", async ({ resources }) => {
    const { path, clock, state, give, pass } = await setup(resources)
    await give("late", "r1")
    await give("too late", "r2")
    await pass()
    await vi.waitFor(() => expect(state("r2")).toBe("unrecorded"))
    expect(state("r1")).toBe("unrecorded")
    await appendFile(path, row("late"))
    await vi.waitFor(() => expect(state("r1")).toBe("settled"))
    // Past the cap, the record is read for it no more: what it gains then settles nothing.
    clock.now += 1_000
    await appendFile(path, row("too late"))
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(state("r2")).toBe("unrecorded")
  })

  it("follows a prompt given before the session binds, by when the record got it", async ({
    resources,
  }) => {
    // Codex and Antigravity bind their session at their first prompt's hook; a resumed
    // session's record already holds the same words, recorded earlier.
    const { path, clock, host, receipts, state, give } = await setup(resources, row("hello", 100))
    host.key = null
    host.shown = "codex"
    host.agent = "codex"
    clock.now = 5_400
    expect(await give("hello", "r1")).toEqual({ ref: "r1", tracked: true })
    expect(state("r1")).toBe("pending")
    host.key = "session-1"
    receipts.changed(terminal)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(state("r1")).toBe("pending")
    // Recorded in the second it was given: coarse records write whole seconds.
    await appendFile(path, row("hello", 5_000))
    await vi.waitFor(() => expect(state("r1")).toBe("settled"))
  })

  it("keeps showing a prompt given before the session bound while its record is looked up", async ({
    resources,
  }) => {
    const { path, host, receipts, state, give } = await setup(resources)
    host.key = null
    host.shown = "codex"
    host.agent = "codex"
    await give("hello", "r1")
    let release = () => {}
    host.lookup = new Promise((resolve) => (release = resolve))
    host.key = "session-1"
    receipts.changed(terminal)
    expect(state("r1")).toBe("pending")
    // A prompt given meanwhile waits for the lookup, and the first prompt's receipt stays.
    const second = receipts.expect(terminal, "again", "r2")
    release()
    expect(await second).toEqual({ ref: "r2", tracked: true })
    receipts.sent(terminal, "r2")
    expect(state("r1")).toBe("pending")
    await appendFile(path, row("hello", 1_000))
    await vi.waitFor(() => expect(state("r1")).toBe("settled"))
  })

  it("counts the interruptions the runner joins to the record in a settled prompt's item", async ({
    resources,
  }) => {
    const { path, host, receipts, state, give } = await setup(resources, row("earlier"))
    // Antigravity's: an Escape after the first line, which the chat shows as an item there.
    host.interruptions = [{ offset: row("earlier").length }]
    await give("hello", "r1")
    await appendFile(path, row("hello"))
    await vi.waitFor(() => expect(state("r1")).toBe("settled"))
    expect(receipts.view(terminal)[0]?.item).toBe(2)
  })

  it("follows no shell command, on any harness", async ({ resources }) => {
    const { receipts } = await setup(resources)
    expect(await receipts.expect(terminal, "!npm test", "r1")).toEqual({
      ref: "r1",
      tracked: false,
    })
  })

  it("gives a prompt before the session binds twice the slack, and logs no decoder miss for it", async ({
    resources,
  }) => {
    const lines = capture(resources)
    const { host, state, give, pass } = await setup(resources)
    host.key = null
    host.shown = "codex"
    host.agent = "codex"
    await give("hello", "r1")
    await pass()
    expect(state("r1")).toBe("pending")
    await pass()
    await vi.waitFor(() => expect(state("r1")).toBe("unrecorded"))
    expect(lines.filter((line) => line.evt === "chat.unrecorded")).toEqual([])
  })

  it("looks up the record of a session that bound while another's was looked up", async ({
    resources,
  }) => {
    const { path, host, receipts, state, give } = await setup(resources)
    host.key = null
    host.shown = "claude"
    await give("hello", "r1")
    let release = () => {}
    host.lookup = new Promise((resolve) => (release = resolve))
    host.key = "session-0"
    receipts.changed(terminal)
    // The session that bound first is gone by the time its lookup answers.
    host.key = "session-1"
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await appendFile(path, row("hello", 1_000))
    await vi.waitFor(() => expect(state("r1")).toBe("settled"))
  })

  it("reads on from where the record was read for the next prompt, its items counted", async ({
    resources,
  }) => {
    const { path, receipts, state, give } = await setup(resources, row("earlier"))
    await give("one", "r1")
    await appendFile(path, row("one"))
    await vi.waitFor(() => expect(state("r1")).toBe("settled"))
    await give("two", "r2")
    await appendFile(path, row("two"))
    await vi.waitFor(() => expect(state("r2")).toBe("settled"))
    expect(receipts.view(terminal).map(({ item }) => item)).toEqual([1, 2])
    // Past the keep, the record is no longer followed; the next prompt reads it from its start.
    await new Promise((resolve) => setTimeout(resolve, 60))
    await give("three", "r3")
    await appendFile(path, row("three"))
    await vi.waitFor(() => expect(state("r3")).toBe("settled"))
    expect(receipts.view(terminal).at(-1)?.item).toBe(3)
  })

  it("calls a prompt given before any session bound missing once none bound in twice the slack", async ({
    resources,
  }) => {
    const { host, state, give, pass } = await setup(resources)
    host.key = null
    host.shown = "agy"
    await give("hello", "r1")
    await pass()
    await pass()
    await vi.waitFor(() => expect(state("r1")).toBe("unrecorded"))
  })

  it("does not follow a shell command given Antigravity before its session binds", async ({
    resources,
  }) => {
    const { host, receipts } = await setup(resources)
    host.key = null
    host.shown = "agy"
    expect(await receipts.expect(terminal, "!ls", "r1")).toEqual({ ref: "r1", tracked: false })
  })

  it("settles a pending prompt, with its item's index, when its line is appended", async ({
    resources,
  }) => {
    const { path, receipts, state, give } = await setup(resources, row("earlier"))
    expect(await give("hello", "r1")).toEqual({ ref: "r1", tracked: true })
    expect(state("r1")).toBe("pending")
    await appendFile(path, row("hello"))
    await vi.waitFor(() => expect(state("r1")).toBe("settled"))
    expect(receipts.view(terminal)[0]).toMatchObject({ ref: "r1", text: null, item: 1 })
  })

  it("does not settle a new send by an older identical item already in the record", async ({
    resources,
  }) => {
    const { path, state, give } = await setup(resources, row("ok"))
    await give("ok", "r1")
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(state("r1")).toBe("pending")
    await appendFile(path, row("ok"))
    await vi.waitFor(() => expect(state("r1")).toBe("settled"))
  })

  it("reaches unrecorded after the deadline and logs chat.unrecorded exactly once", async ({
    resources,
  }) => {
    const lines = capture(resources)
    const { state, give, pass } = await setup(resources)
    await give("never arrives", "r1")
    await pass()
    await vi.waitFor(() => expect(state("r1")).toBe("unrecorded"))
    await pass()
    expect(lines.filter((line) => line.evt === "chat.unrecorded")).toEqual([
      { level: "warn", evt: "chat.unrecorded" },
    ])
  })

  it("does not call a prompt missing while the agent works", async ({ resources }) => {
    const { host, state, give, pass } = await setup(resources)
    host.turns = { working: true, endedAt: null }
    await give("queued", "r1")
    await pass()
    expect(state("r1")).toBe("pending")
  })

  it("calls a prompt in-box, with no log, when the box holds its words", async ({ resources }) => {
    const lines = capture(resources)
    const { host, state, give, pass } = await setup(resources)
    host.box = "> hello\n  there"
    await give("hello there", "r1")
    await pass()
    await vi.waitFor(() => expect(state("r1")).toBe("in-box"))
    expect(lines.filter((line) => line.evt === "chat.unrecorded")).toEqual([])
  })

  it("turns unrecorded into settled when a late match arrives", async ({ resources }) => {
    capture(resources)
    const { path, state, give, pass } = await setup(resources)
    await give("late", "r1")
    await pass()
    await vi.waitFor(() => expect(state("r1")).toBe("unrecorded"))
    await appendFile(path, row("late"))
    await vi.waitFor(() => expect(state("r1")).toBe("settled"))
  })

  it("withdraws a pending prompt whose words a Stop handed back", async ({ resources }) => {
    const { receipts, state, give } = await setup(resources)
    await give("take this back", "r1")
    await give("keep this", "r2")
    receipts.withdraw(terminal, "> take this back")
    expect(state("r1")).toBe("withdrawn")
    expect(receipts.view(terminal)[0]).toMatchObject({ ref: "r1", text: null })
    expect(state("r2")).toBe("pending")
  })

  it("forgets a prompt that failed to be given", async ({ resources }) => {
    const { receipts, state, give } = await setup(resources)
    await give("never typed", "r1")
    receipts.failed(terminal, "r1")
    expect(state("r1")).toBeUndefined()
    expect(receipts.view(terminal)).toEqual([])
  })

  it("rejects a ref the terminal holds already as a CONFLICT", async ({ resources }) => {
    const { receipts, give } = await setup(resources)
    await give("one", "r1")
    await expect(receipts.expect(terminal, "two", "r1")).rejects.toMatchObject({
      code: "CONFLICT",
    })
  })

  it("does not track a shell send to Antigravity, which records none", async ({ resources }) => {
    const { host, receipts } = await setup(resources)
    host.agent = "agy"
    expect(await receipts.expect(terminal, "!ls", "r1")).toEqual({ ref: "r1", tracked: false })
    expect(await receipts.expect(terminal, "hello", "r2")).toEqual({ ref: "r2", tracked: true })
    expect(receipts.view(terminal)).toEqual([])
  })

  it("empties the view when the terminal binds another session", async ({ resources }) => {
    const { host, receipts, give } = await setup(resources)
    await give("hello", "r1")
    expect(receipts.view(terminal)).toHaveLength(1)
    host.key = "session-2"
    expect(receipts.view(terminal)).toEqual([])
    receipts.changed(terminal)
    host.key = "session-1"
    expect(receipts.view(terminal)).toEqual([])
  })

  it("keeps an item baseline across a rewrite of the record", async ({ resources }) => {
    const long = "the old prompt, long enough to end past where the first record did"
    const { path, receipts, state, give } = await setup(resources, row("a") + row(long))
    await give(long, "r1")
    await new Promise((resolve) => setTimeout(resolve, 40))
    // The record is truncated and rewritten, shorter at first, the old item landing again
    // as its second item: its line ends past where the record ended, but it is not new.
    await writeFile(path, row("b".repeat(40)))
    await new Promise((resolve) => setTimeout(resolve, 40))
    await appendFile(path, row(long))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(state("r1")).toBe("pending")
    await appendFile(path, row(long))
    await vi.waitFor(() => expect(state("r1")).toBe("settled"))
    expect(receipts.view(terminal)[0]?.item).toBe(2)
  })

  it("drops settled receipts first when it holds more than its cap", async ({ resources }) => {
    const { path, receipts, state, give } = await setup(resources)
    for (let at = 0; at < agentLimits.prompts; at += 1)
      // eslint-disable-next-line no-await-in-loop -- Each prompt is given after the one before.
      await give(`word ${at}`, `r${at}`)
    await appendFile(path, row("word 1"))
    await vi.waitFor(() => expect(state("r1")).toBe("settled"))
    await give("one more", "r8")
    const refs = receipts.view(terminal).map((each) => each.ref)
    expect(refs).toHaveLength(agentLimits.prompts)
    expect(refs).not.toContain("r1")
    expect(refs).toContain("r0")
    expect(refs).toContain("r8")
  })
})
