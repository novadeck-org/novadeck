import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Install } from "@novadeck/harness-core/harness"
import { afterEach, describe, expect, it } from "vitest"

import { claudeApart, parseLock, parseRoster, verdict, type Facts, type Worker } from "./daemon.js"

// As Claude Code 2.1.329 wrote them (probed 2026-11-20), trimmed to what is read.
const lockFile = (more: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid: 500,
    version: "2.1.329",
    startedAt: 1_795_178_948_527,
    origin: "transient",
    spawnedBy: { label: "claude", cwd: "/work/project", pid: 400 },
    procStart: "75822456",
    ...more,
  })

const closed = "4f67f429-9730-4ad8-8661-e590b99fcc69"

// The copy ← made of the closed terminal's conversation.
const copyOf = (from: string, id = "830145d1", pid = 510) => ({
  pid,
  procStart: String(75_822_466 + pid),
  sessionId: `${id}-4919-478d-85d7-eb4925963c74`,
  startedAt: 1_795_178_948_549,
  dispatch: {
    source: "slash",
    launch: {
      mode: "resume",
      sessionId: `/home/me/.claude/projects/-work-project/${from}.jsonl`,
      fork: true,
    },
  },
  replPid: pid + 1,
  replProcStart: String(75_822_471 + pid),
})

// A client's own session, for the agents view it shows.
const clientOwn = {
  pid: 520,
  procStart: "75822500",
  sessionId: "ac42f682-0000-0000-0000-000000000000",
  startedAt: 1_795_178_948_600,
  dispatch: { source: "spare", launch: { mode: "prompt" } },
}

const rosterFile = (workers: Record<string, unknown>, supervisorPid = 500) =>
  JSON.stringify({ proto: 1, supervisorPid, workers })

const facts = (
  workers: Record<string, unknown>,
  more: Partial<Omit<Facts, "lock" | "roster">> & { lock?: string; supervisor?: number } = {},
): Facts => ({
  lock: parseLock(more.lock ?? lockFile())!,
  roster: parseRoster(rosterFile(workers, more.supervisor))!,
  transcribed: more.transcribed ?? (() => false),
  running: more.running ?? (() => false),
})

const pids = (found: { readonly end: readonly { readonly pid: number }[] }) =>
  found.end.map(({ pid }) => pid)

describe("Claude Code's background service files", () => {
  it("reads the lock's service, by its pid and start", () => {
    expect(parseLock(lockFile())).toEqual({
      pid: 500,
      start: "75822456",
      startedAt: 1_795_178_948_527,
      origin: "transient",
      spawnedBy: 400,
    })
  })

  it("recognizes no lock that isn't one", () => {
    expect(parseLock("{")).toBeUndefined()
    expect(parseLock("[]")).toBeUndefined()
    expect(parseLock(lockFile({ pid: "500" }))).toBeUndefined()
    expect(parseLock(lockFile({ startedAt: undefined }))).toBeUndefined()
    expect(parseLock(lockFile({ origin: 3 }))).toBeUndefined()
  })

  it("reads each session of the roster with what it was copied from", () => {
    const roster = parseRoster(rosterFile({ "830145d1": copyOf(closed) }))
    expect(roster?.supervisor).toBe(500)
    expect(roster?.workers).toEqual<Worker[]>([
      {
        id: "830145d1",
        pid: 510,
        start: "75822976",
        startedAt: 1_795_178_948_549,
        sessionId: "830145d1-4919-478d-85d7-eb4925963c74",
        repl: { pid: 511, start: "75822981" },
        source: "slash",
        forkOf: closed,
      },
    ])
  })

  it("recognizes no roster with a session it can't place", () => {
    expect(parseRoster("nope")).toBeUndefined()
    expect(parseRoster(JSON.stringify({ workers: {} }))).toBeUndefined()
    expect(parseRoster(rosterFile({ x: { pid: 510 } }))).toBeUndefined()
  })
})

describe("what a closed terminal left in Claude Code's background service", () => {
  it("ends the unused copy of its conversation, and the service it alone was using", () => {
    const found = verdict(facts({ "830145d1": copyOf(closed) }), closed)
    expect(found.settled).toBe(true)
    expect(pids(found)).toEqual([500, 510, 511])
    expect(found.end[0]).toEqual({
      pid: 500,
      start: "75822456",
      born: { after: 1_795_178_948_527 - 60_000, before: 1_795_178_948_527 },
    })
  })

  it("stops an empty service started on demand", () => {
    expect(pids(verdict(facts({}), closed))).toEqual([500])
  })

  it("keeps a session the person set to work, and the service with it", () => {
    const worked = verdict(
      facts({ "830145d1": copyOf(closed) }, { transcribed: () => true }),
      closed,
    )
    expect(pids(worked)).toEqual([])
    const dispatched = {
      ...copyOf("other", "5e6f7a8b", 540),
      dispatch: { source: "agents", launch: { mode: "prompt" } },
    }
    const found = verdict(facts({ a: copyOf(closed), b: dispatched }), closed)
    expect(pids(found)).toEqual([510, 511])
  })

  it("leaves a service the person installed, ending only the copy", () => {
    const found = verdict(
      facts({ "830145d1": copyOf(closed) }, { lock: lockFile({ origin: "service" }) }),
      closed,
    )
    expect(pids(found)).toEqual([510, 511])
  })

  it("leaves the service while whatever started it still runs", () => {
    const found = verdict(
      facts({ "830145d1": copyOf(closed) }, { running: (pid) => pid === 400 }),
      closed,
    )
    expect(pids(found)).toEqual([510, 511])
  })

  it("waits while a client's own session is listed, and then ends only the closed one's copy", () => {
    const other = copyOf("someone-else", "9d0c0e11", 530)
    const found = verdict(facts({ a: copyOf(closed), b: other, c: clientOwn }), closed)
    expect(found.settled).toBe(false)
    expect(pids(found)).toEqual([510, 511])
  })

  it("ends another terminal's unused copy too once no client shows it, as two closing together", () => {
    const other = copyOf("someone-else", "9d0c0e11", 530)
    const found = verdict(facts({ a: copyOf(closed), b: other }), closed)
    expect(found.settled).toBe(true)
    expect(pids(found)).toEqual([500, 510, 511, 530, 531])
  })

  it("ends nothing where the roster is another service's than the lock's", () => {
    expect(pids(verdict(facts({ a: copyOf(closed) }, { supervisor: 499 }), closed))).toEqual([])
  })
})

describe("reading the service's files as a terminal closes", () => {
  let home: string | undefined
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true })
    home = undefined
  })

  const install = (): Install => {
    home = mkdtempSync(join(tmpdir(), "novadeck-claude-apart-"))
    mkdirSync(join(home, ".claude", "daemon"), { recursive: true })
    return { env: {}, home, platform: "linux", plugin: "" }
  }
  const write = (path: string, text: string) => writeFileSync(join(home!, ".claude", path), text)

  it("keeps the lock's service out of the close's follow", async () => {
    const where = install()
    write("daemon.lock", lockFile())
    expect((await claudeApart.kept(where)).map(({ pid }) => pid)).toEqual([500])
  })

  it("keeps and ends nothing without a lock or roster it can read", async () => {
    const where = install()
    expect(await claudeApart.kept(where)).toEqual([])
    expect(await claudeApart.left(where, { sessionId: closed }, Date.now())).toEqual([])
    write("daemon.lock", lockFile())
    write("daemon/roster.json", "{ half")
    expect(await claudeApart.left(where, { sessionId: closed }, Date.now())).toEqual([])
    write("daemon.lock", "garbage")
    write("daemon/roster.json", rosterFile({}))
    expect(await claudeApart.left(where, { sessionId: closed }, Date.now())).toEqual([])
  })

  it("reads whether anything was said in a copy from its transcript", async () => {
    const where = install()
    write("daemon.lock", lockFile({ spawnedBy: undefined }))
    write("daemon/roster.json", rosterFile({ "830145d1": copyOf(closed) }))
    const until = Date.now()
    expect(
      (await claudeApart.left(where, { sessionId: closed }, until)).map(({ pid }) => pid),
    ).toEqual([500, 510, 511])
    mkdirSync(join(home!, ".claude", "projects", "-work-project"), { recursive: true })
    write("projects/-work-project/830145d1-4919-478d-85d7-eb4925963c74.jsonl", "{}\n")
    expect(await claudeApart.left(where, { sessionId: closed }, until)).toEqual([])
  })

  it("waits for a client's own session to go, as its agent's close takes a moment", async () => {
    const where = install()
    write("daemon.lock", lockFile({ spawnedBy: undefined }))
    write("daemon/roster.json", rosterFile({ a: copyOf(closed), c: clientOwn }))
    setTimeout(() => write("daemon/roster.json", rosterFile({ a: copyOf(closed) })), 150)
    const found = await claudeApart.left(where, { sessionId: closed }, Date.now() + 3_000)
    expect(found.map(({ pid }) => pid)).toEqual([500, 510, 511])
  })

  it("goes by CLAUDE_CONFIG_DIR where the person moved its home", async () => {
    const where = install()
    const moved = join(home!, "elsewhere")
    mkdirSync(moved)
    writeFileSync(join(moved, "daemon.lock"), lockFile({ pid: 900 }))
    expect(
      (await claudeApart.kept({ ...where, env: { CLAUDE_CONFIG_DIR: moved } })).map(
        ({ pid }) => pid,
      ),
    ).toEqual([900])
  })
})
