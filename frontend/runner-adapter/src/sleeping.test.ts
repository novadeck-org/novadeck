import type { TerminalSummary } from "@novadeck/protocol"
import { WireError } from "@novadeck/wire"

import { describe, expect, it } from "./test"
import { id, keptSummary, scripted } from "./testing/scripted"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const asleep = (terminalId: string, change: Partial<TerminalSummary> = {}): TerminalSummary =>
  keptSummary(terminalId, id(8), {
    lastProgram: "claude",
    sleeping: true,
    restingAgent: "claude",
    ...change,
  })

const statusOf = (app: ReturnType<typeof scripted>, terminalId: string) =>
  app
    .workspace()
    .projects[0]!.history[0]!.state.roster.terminals.find((each) => each.id === terminalId)

describe("a sleeping agent", () => {
  it("is shown asleep and starts no shell, though its session is on screen", async () => {
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [asleep(id(1))],
    })
    await wait(300)
    expect(statusOf(app, id(1))).toMatchObject({ state: "sleeping", agent: "claude" })
    expect(app.of("create")).toEqual([])
    app.stop()
  })

  it("wakes into the session it saved once a surface has wanted it for a moment", async () => {
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [asleep(id(1))],
    })
    const release = app.seen(app.key(id(1)))
    await wait(150)
    expect(app.of("create")).toEqual([])
    await wait(300)
    expect(app.of("create")).toEqual([
      expect.objectContaining({ id: id(1), restore: true, resume: "claude" }),
    ])
    release()
    app.stop()
  })

  it("wakes nothing for a tile flicked past", async () => {
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [asleep(id(1))],
    })
    app.seen(app.key(id(1)))()
    await wait(500)
    expect(app.of("create")).toEqual([])
    app.stop()
  })

  it("still resumes at once an agent that is not asleep, in a session nobody opened", async () => {
    const app = scripted({
      shown: [],
      background: [{ id: id(1), lastProcess: "claude" }],
      listed: [],
    })
    await wait(300)
    expect(app.of("create")).toHaveLength(1)
    app.stop()
  })

  it("wakes once when the runner says it is no longer asleep, however often it says so", async () => {
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [asleep(id(1))],
    })
    await wait(100)
    const woken = asleep(id(1), { sleeping: false })
    app.changes.push({ type: "changed", terminal: woken })
    app.changes.push({ type: "changed", terminal: woken })
    await wait(300)
    expect(app.of("create")).toEqual([expect.objectContaining({ id: id(1), resume: "claude" })])
    app.stop()
  })

  it("stays asleep through a runner crash loop, and wakes when asked to try again", async () => {
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [asleep(id(1))],
      apply: true,
    })
    for (const epoch of ["r2", "r3", "r4", "r5", "r6"])
      app.statuses.push({ state: "connected", epoch })
    await wait(100)
    expect(statusOf(app, id(1))).toMatchObject({ state: "sleeping" })
    app.seen(app.key(id(1)))
    await wait(400)
    expect(app.of("create")).toEqual([])
    expect(statusOf(app, id(1))).toMatchObject({ state: "failed" })
    app.backend.crashLoop?.retry()
    await wait(400)
    expect(app.of("create")).toEqual([expect.objectContaining({ id: id(1), resume: "claude" })])
    app.stop()
  })

  it("tells the runner a wake is seen when the person's look started it, and not when a message did", async () => {
    const looked = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [asleep(id(1))],
    })
    looked.seen(looked.key(id(1)))
    await wait(400)
    expect(looked.of("create")).toEqual([expect.objectContaining({ seen: true })])
    looked.stop()
    const messaged = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [asleep(id(1))],
    })
    await wait(100)
    messaged.changes.push({ type: "changed", terminal: asleep(id(1), { sleeping: false }) })
    await wait(300)
    expect(messaged.of("create")).toEqual([expect.not.objectContaining({ seen: true })])
    messaged.stop()
  })

  it("stays asleep when the runner refuses a wake it was not looked at for", async () => {
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [asleep(id(1))],
      apply: true,
      create: () => Promise.reject(new WireError("SPAWN_FAILED")),
    })
    await wait(100)
    app.changes.push({ type: "changed", terminal: asleep(id(1), { sleeping: false }) })
    await wait(400)
    expect(statusOf(app, id(1))).toMatchObject({ state: "sleeping", agent: "claude" })
    app.stop()
  })

  it("shows a crashed shell whose record the runner let go as a sleeper again, not as exited", async () => {
    const crashed = keptSummary(id(1), id(8), {
      started: true,
      lastProgram: "claude",
      run: 1,
      exit: { code: null, signal: "SIGKILL", ranMs: 9_000 },
    })
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [crashed],
      apply: true,
    })
    await wait(100)
    expect(statusOf(app, id(1))).toMatchObject({ state: "exited" })
    app.changes.push({ type: "changed", terminal: asleep(id(1)) })
    await wait(100)
    expect(statusOf(app, id(1))).toMatchObject({ state: "sleeping", agent: "claude" })
    app.stop()
  })

  it("resumes at once a wake it first sees as waking, from the runner's agent, unseen off screen", async () => {
    const waking = keptSummary(id(1), id(9), {
      lastProgram: "node",
      restingAgent: "codex",
      sleeping: false,
    })
    const app = scripted({
      shown: [],
      background: [{ id: id(1), lastProcess: "node" }],
      listed: [],
    })
    await wait(100)
    app.changes.push({ type: "changed", terminal: waking })
    await wait(300)
    expect(app.of("create")).toEqual([expect.objectContaining({ id: id(1), resume: "codex" })])
    app.stop()
  })

  it("resumes a wake it sees as waking while a surface looks, and says it is seen", async () => {
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "node" }],
      listed: [asleep(id(1), { lastProgram: "node", restingAgent: "codex" })],
    })
    app.seen(app.key(id(1)))
    await wait(100)
    app.changes.push({
      type: "changed",
      terminal: asleep(id(1), { lastProgram: "node", restingAgent: "codex", sleeping: false }),
    })
    await wait(400)
    expect(app.of("create")).toEqual([
      expect.objectContaining({ id: id(1), resume: "codex", seen: true }),
    ])
    app.stop()
  })

  it("shows a sleeper's standing report, and again when it changes while it sleeps", async () => {
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [asleep(id(1))],
      apply: true,
    })
    await wait(100)
    expect(statusOf(app, id(1))).not.toHaveProperty("reported")
    app.changes.push({
      type: "changed",
      terminal: asleep(id(1), { reported: { subject: "done", at: 5 } }),
    })
    await wait(100)
    expect(statusOf(app, id(1))).toMatchObject({ state: "sleeping", reported: true })
    app.stop()
  })

  it("stays asleep for a refused unseen wake that was starting, by the runner's latest word", async () => {
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "node" }],
      listed: [asleep(id(1), { lastProgram: "node", restingAgent: "codex", sleeping: false })],
      apply: true,
      create: () => Promise.reject(new WireError("SPAWN_FAILED")),
    })
    await wait(100)
    app.changes.push({
      type: "changed",
      terminal: asleep(id(1), { lastProgram: "node", restingAgent: "codex" }),
    })
    await wait(400)
    expect(statusOf(app, id(1))).toMatchObject({ state: "sleeping", agent: "codex" })
    app.stop()
  })

  it("fails a seen wake the runner cannot spawn, instead of looping asleep and waking", async () => {
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [asleep(id(1))],
      apply: true,
      create: () => Promise.reject(new WireError("SPAWN_FAILED")),
    })
    app.seen(app.key(id(1)))
    await wait(1_200)
    expect(statusOf(app, id(1))).toMatchObject({ state: "failed" })
    expect(app.of("create")).toHaveLength(1)
    app.stop()
  })

  it("follows the messages of a shell the runner started itself", async () => {
    const app = scripted({
      shown: [{ id: id(1), lastProcess: "claude" }],
      listed: [asleep(id(1))],
    })
    await wait(100)
    expect(app.followed).toEqual([])
    app.changes.push({
      type: "changed",
      terminal: asleep(id(1), { sleeping: false, started: true }),
    })
    await wait(100)
    expect(app.followed).toEqual([id(1)])
    app.stop()
  })
})
