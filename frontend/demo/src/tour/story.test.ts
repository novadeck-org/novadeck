import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { demoTurns } from "../agents/turns"
import { plainDemo } from "../index"
import { demoTourFolder, isDemoTour, type DemoTour } from "../tour"
import { demoRun } from "../tour-runs"
import { heroOf, modelOf, pitches, teamParts, tourEntries } from "./content"
import {
  chosenHero,
  chosenOption,
  firstVersion,
  heroColourSubject,
  heroColours,
  pickOption,
  pitchAsk,
  pitchSubject,
  polishedNote,
  serverName,
  teammateCommand,
  teammateLines,
} from "./story"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }

describe("the story's pieces", () => {
  it("starts a teammate on its harness and the lead's model", () => {
    expect(teammateCommand("claude")).toBe("claude --model haiku")
  })

  it("pitches three games as the runner's ask does: options with a title and a line each", () => {
    const terminal = { id: "t", name: "Game lead", handle: "fox" } as TerminalMetadata
    const entry = pitchAsk(key, terminal, "claude", "Tour", 5)
    expect(entry).toMatchObject({
      kind: "ask",
      stopped: false,
      source: { terminalId: "t", handle: "fox", agent: "claude", projectName: "Tour" },
      ask: { subject: pitchSubject, shape: { type: "options" } },
    })
    if (entry.kind !== "ask" || entry.ask.shape.type !== "options") throw new Error("no pitch")
    expect(entry.ask.shape.options.map(({ label, summary }) => [label, summary])).toEqual(
      pitches.map(({ title, line }) => [title, line]),
    )
  })

  it("takes the pitch picked, else the person's own words, else the first pitch", () => {
    expect(chosenHero(pickOption(1))).toMatchObject({ title: pitches[1].title, shape: "robot" })
    expect(chosenHero(pickOption(0))).toMatchObject({ title: pitches[0].title, shape: "rocket" })
    expect(chosenHero(pickOption("Space pirates"))).toMatchObject({
      title: "Space pirates",
      shape: "rocket",
    })
    expect(chosenHero(pickOption("Pirates"))).toMatchObject({ title: "Pirates", shape: "cat" })
    expect(chosenHero(pickOption(7))).toMatchObject({ title: pitches[0].title })
    expect(chosenHero(undefined)).toMatchObject({ title: pitches[0].title })
    expect(chosenOption(pickOption(1), heroColours)).toBe("Blue")
    expect(chosenOption(pickOption("teal"), heroColours)).toBe("teal")
    expect(chosenOption(undefined, heroColours)).toBe("Red")
  })

  it("makes a start model and a different sculpted one, each a small glTF the pane can draw", () => {
    const parsed = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes))
    const start = modelOf(undefined, "1")
    const rocket = modelOf(heroOf(0), "2")
    for (const model of [start, rocket, modelOf(heroOf(1), "2"), modelOf(heroOf(2), "2")]) {
      expect(model.bytes.length).toBeLessThan(2500)
      const gltf = parsed(model.bytes)
      expect(gltf.asset.version).toBe("2.0")
      expect(gltf.buffers[0].uri).toMatch(/^data:application\/octet-stream;base64,/)
      expect(atob(gltf.buffers[0].uri.split(",")[1]).length).toBe(gltf.buffers[0].byteLength)
      expect(gltf.nodes.length).toBeGreaterThanOrEqual(gltf.meshes.length)
      expect(gltf.buffers[0].byteLength).toBe(288)
    }
    expect(parsed(start.bytes).nodes).toHaveLength(2)
    expect(parsed(rocket.bytes).nodes.length).toBeGreaterThan(2)
    expect(start.content).toMatchObject({ state: "ready", stamp: "1" })
    expect(rocket.content).toMatchObject({ state: "ready", stamp: "2" })
  })

  it("lists the new seed", () => {
    expect(tourEntries).toContain("src/main.js")
    expect(tourEntries).toContain("models/placeholder.gltf")
    expect(tourEntries).toContain("kit/README.md")
  })
})

// The demo's workspace whose first project is the tour's, with the lead's terminal started there.
const open = async (setup?: (tour: DemoTour) => void) => {
  const backend = plainDemo("plain", undefined, undefined, demoTurns(), true)
  const tour = backend.tour
  if (!isDemoTour(tour)) throw new Error("no demo tour")
  const seeded = workspaceFromSeed(backend.seed, { view: "grid", windowedView: "grid", now: 0 })
  const store = createWorkspaceStore(
    {
      ...seeded,
      projects: seeded.projects.map((each, index) =>
        index === 0 ? { ...each, directory: demoTourFolder } : each,
      ),
    },
    backend.commit,
  )
  backend.commit(store.getSnapshot(), [])
  backend.start!({ dispatch: (actions) => store.transact(actions as never), open: () => {} })
  setup?.(tour)
  await tour.prepare().catch(() => undefined)
  const project = store.getSnapshot().projects[0]!
  const target = { projectId: project.id, workspaceSessionId: project.history[0]!.id }
  const add = async (command?: string) => {
    const terminal = backend.newTerminal({
      target,
      directory: demoTourFolder,
      ...(command && { launch: { command } }),
    })
    store.transact([{ type: "terminal/add", target, terminal }])
    await vi.dynamicImportSettled()
    return terminal.id
  }
  const lead = await add(demoRun("claude").command)
  const session = () =>
    store
      .getSnapshot()
      .projects.find((each) => each.id === project.id)!
      .history.find((each) => each.id === target.workspaceSessionId)!
  const workspace = (): Workspace => store.getSnapshot()
  const at = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms)
  }
  const terminals = () => session().state.roster.terminals
  const items = () => session().state.items
  const works = () => backend.works!.state.getSnapshot().works
  const approvals = () => backend.approvals!.pending.getSnapshot()
  // The person answers the lead's ask to run the game's server, which it makes as the sheet is
  // answered.
  const allow = async (approved = true) => {
    // eslint-disable-next-line no-await-in-loop -- The clock moves on until the ask is there.
    for (let waited = 0; approvals().length === 0 && waited < 5_000; waited += 100) await at(100)
    backend.approvals!.answer(approvals()[0]!.requestId, approved)
  }
  return {
    backend,
    tour,
    session,
    workspace,
    at,
    lead,
    project: project.id,
    add,
    terminals,
    items,
    works,
    approvals,
    allow,
  }
}

type Demo = Awaited<ReturnType<typeof open>>

const messagesOf = (backend: Demo["backend"]) => {
  const state = backend.messages!.state.getSnapshot()
  const distinct = new Map(
    Object.values(state.terminals)
      .flatMap((each) => each.threads.flatMap((thread) => thread.messages))
      .map((message) => [message.id, message]),
  )
  return [...distinct.values()]
}

// Long enough for the lead to bind, work, describe itself and pitch its games.
const asking = 300 + 400 + 300 + 300 + 400

// Long enough, from the person's answer to the lead's ask to run the server, for the lead to open
// its team and show its page, and the team to name itself, talk, work, show, and say it is
// polished.
const teamUp = 6_000

const sheetOf = (backend: Demo["backend"]) =>
  backend.inbox!.state.getSnapshot().items.filter((entry) => entry.kind === "ask")

describe("the story in the demo", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("pitches its games from the lead's terminal, and waits for as long as the person takes", async () => {
    const { backend, at, lead, terminals } = await open()
    await at(asking)
    const entries = sheetOf(backend)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      source: { terminalId: lead },
      stopped: false,
      ask: { subject: pitchSubject, shape: { type: "options" } },
    })
    await at(60_000)
    expect(terminals().filter((each) => each.ledBy === lead)).toEqual([])
    expect(sheetOf(backend).filter((entry) => !entry.settled)).toHaveLength(1)
  })

  it("opens Core, World and Feel, which the lead leads, once the pitch and the server are answered", async () => {
    const { backend, tour, at, allow, lead, project: id, terminals, items, works } = await open()
    await at(asking)
    tour.answerSheet(1)
    await allow()
    await at(teamUp)
    const mates = terminals().filter((each) => each.ledBy === lead)
    expect(mates.map((each) => each.name)).toEqual(teamParts.map(({ role }) => role))
    for (const mate of mates) expect(mate.titleSource?.kind).toBe("agent")
    const [core, world, feel] = mates as [TerminalMetadata, TerminalMetadata, TerminalMetadata]
    const filesOf = (terminalId: string) =>
      works().find((work) => work.terminalId === terminalId)?.files
    expect(filesOf(core.id)).toEqual([expect.objectContaining({ path: "src/main.js" })])
    expect(filesOf(world.id)).toEqual([
      expect.objectContaining({ path: "src/world.js", status: "added" }),
      expect.objectContaining({ path: "models/hero.gltf", status: "added" }),
    ])
    expect(filesOf(feel.id)).toEqual([
      expect.objectContaining({ path: "src/feel.js", status: "added" }),
    ])
    expect(items().find((item) => item.kind === "model")).toMatchObject({
      holder: { terminalId: world.id },
      name: "hero.gltf",
    })
    expect(
      items()
        .filter((item) => item.kind === "changes")
        .map((item) => item.holder),
    ).toEqual([{ terminalId: core.id }, { terminalId: feel.id }])
    // Each told the lead its first version was in, then that it was polished.
    const said = messagesOf(backend).map(({ text }) => text)
    for (const { role } of teamParts)
      expect(said).toEqual(expect.arrayContaining([firstVersion(role), polishedNote(role)]))
    // Its writes are in the Files feed, under its handle.
    const feed = backend.files!.state.getSnapshot()
    const touched = Object.values(feed.projects).flatMap((project) =>
      Object.entries(project.changes).filter(([path]) => path === "src/main.js"),
    )
    expect(touched[0]?.[1].touched).toHaveProperty(core.handle!)
    // The merged preview of src/main.js names the game for the pick.
    const preview = await backend.works!.preview(id, "src/main.js")
    expect(preview.works).toHaveLength(1)
  })

  it("has the teammates write to each other, not only to the lead", async () => {
    const { backend, tour, at, allow, lead, terminals } = await open()
    await at(asking)
    tour.answerSheet()
    await allow()
    await at(teamUp)
    const [core, world, feel] = terminals().filter((each) => each.ledBy === lead)
    const between = messagesOf(backend).filter(
      ({ from, to }) =>
        from.kind === "agent" &&
        to.kind === "agent" &&
        from.terminalId !== lead &&
        to.terminalId !== lead,
    )
    expect(
      between.map(({ from, to, text }) => [
        from.kind === "agent" && from.terminalId,
        to.kind === "agent" && to.terminalId,
        text,
      ]),
    ).toEqual([
      [world!.id, core!.id, teammateLines.world],
      [feel!.id, world!.id, teammateLines.feel],
    ])
  })

  it("takes the first options where the sheet is dismissed", async () => {
    const { backend, at, allow, lead, terminals } = await open()
    await at(asking)
    backend.inbox!.dismiss?.(sheetOf(backend)[0]!.id)
    await allow()
    await at(teamUp)
    expect(terminals().some((each) => each.ledBy === lead)).toBe(true)
  })

  it("asks to run the game's server first; allowed, it opens a terminal of its own, then its team and shows the page", async () => {
    const { backend, tour, at, lead, terminals, items, approvals } = await open()
    await at(asking)
    tour.answerSheet()
    // It opens nobody while the person has the approval to answer, however long they take.
    await at(60_000)
    expect(terminals().filter((each) => each.ledBy === lead)).toEqual([])
    expect(approvals()).toHaveLength(1)
    expect(approvals()[0]).toMatchObject({
      from: lead,
      terminalId: lead,
      action: { type: "run", command: "node dev.mjs 5173", cwd: demoTourFolder },
    })
    expect(items().some((item) => item.kind === "page")).toBe(false)
    backend.approvals!.answer(approvals()[0]!.requestId, true)
    await at(1000)
    expect(approvals()).toEqual([])
    const server = terminals().find((each) => each.name === serverName)!
    expect(server).toMatchObject({ openedBy: lead })
    expect(server.ledBy).toBeUndefined()
    // The team is opened first, the page shown once it is.
    expect(terminals().filter((each) => each.ledBy === lead).length).toBeGreaterThan(0)
    expect(items().some((item) => item.kind === "page")).toBe(false)
    await at(teamUp)
    expect(items().find((item) => item.kind === "page")).toMatchObject({
      holder: { terminalId: lead },
      url: "http://127.0.0.1:5173/",
    })
    expect(terminals().filter((each) => each.ledBy === lead)).toHaveLength(3)
  })

  it("goes on without a page where the person says no, and where there is none", async () => {
    const declined = await open()
    await declined.at(asking)
    declined.tour.answerSheet()
    await declined.allow(false)
    await declined.at(teamUp)
    expect(declined.items().some((item) => item.kind === "page")).toBe(false)
    expect(declined.terminals().some((each) => each.name === serverName)).toBe(false)
    // Its team all the same.
    expect(declined.terminals().filter((each) => each.ledBy === declined.lead)).toHaveLength(3)
  })

  it("has no page to run where the computer has no Node or Python", async () => {
    vi.useRealTimers()
    const backend = plainDemo("plain", undefined, undefined, demoTurns())
    const tour = backend.tour
    if (!isDemoTour(tour)) throw new Error("no demo tour")
    tour.follow(() => undefined)
    tour.goNoPage()
    await expect(tour.prepare()).resolves.toMatchObject({ page: false })
    // The lead's player takes the plan as it starts; the run after has its page again.
    tour.take()
    await expect(tour.prepare()).resolves.toMatchObject({ page: true })
  })

  it("has World ask its own question while the others work on, and polish only once it is answered", async () => {
    const { backend, tour, at, allow, lead, terminals } = await open((each) => each.goMateAsks())
    await at(asking)
    tour.answerSheet()
    await allow()
    await at(teamUp)
    const world = terminals().find((each) => each.ledBy === lead && each.name === "World")!
    const asks = () => sheetOf(backend).filter((entry) => !entry.settled)
    expect(asks()).toHaveLength(1)
    expect(asks()[0]).toMatchObject({
      source: { terminalId: world.id },
      ask: { subject: heroColourSubject, shape: { type: "options" } },
    })
    const said = () => messagesOf(backend).map(({ text }) => text)
    // Core and Feel polished; World, which waits on the person, told the lead its first version.
    expect(said()).toEqual(
      expect.arrayContaining([polishedNote("Core"), polishedNote("Feel"), firstVersion("World")]),
    )
    await at(60_000)
    expect(said()).not.toContain(polishedNote("World"))
    tour.answerMate(1)
    await at(3000)
    expect(asks()).toHaveLength(0)
    expect(said()).toContain(polishedNote("World"))
  })

  it("keeps Core quiet until nudged, and stops with the agent", async () => {
    const { tour, at, allow, lead, terminals } = await open((each) => each.goQuietMate())
    await at(asking)
    tour.answerSheet()
    await allow()
    await at(teamUp)
    const core = terminals().find((each) => each.ledBy === lead && each.handle !== undefined)!
    expect(core.name).not.toBe("Core")
    await tour.nudge!(lead)
    await at(3000)
    expect(terminals().find((each) => each.id === core.id)?.name).toBe("Core")
    tour.stop()
    expect(terminals().find((each) => each.id === lead)?.state).toBe("exited")
  })

  it("waits for a nudge before opening its team", async () => {
    const { tour, at, allow, lead, terminals } = await open((each) => each.goQuietTeam())
    await at(teamUp)
    expect(terminals().filter((each) => each.ledBy === lead)).toEqual([])
    await tour.nudge!(lead)
    await at(asking)
    tour.answerSheet()
    await allow()
    await at(teamUp)
    expect(terminals().some((each) => each.ledBy === lead)).toBe(true)
  })

  it("leaves the lead's program ended, its shell back, where it exits to its shell", async () => {
    const { tour, at, lead, terminals } = await open()
    await at(100)
    tour.exitToShell()
    expect(terminals().find((each) => each.id === lead)).toMatchObject({
      state: "idle",
      agentRan: true,
    })
  })

  it("lists the tour's repo in its Files panel, and no other project's", async () => {
    const { backend, project } = await open()
    const root = await backend.files!.list(project, "")
    expect(root.entries.map((entry) => entry.name)).toContain("src")
    expect(root.entries.find((entry) => entry.name === "vendor")).toMatchObject({ ignored: true })
  })

  it("keeps the project, or fails to once, as the closing card says", async () => {
    const { tour } = await open()
    await expect(tour.keep!()).resolves.toBeUndefined()
    tour.failKeep()
    await expect(tour.keep!()).rejects.toThrow("can't be written")
    await expect(tour.keep!()).resolves.toBeUndefined()
  })
})
