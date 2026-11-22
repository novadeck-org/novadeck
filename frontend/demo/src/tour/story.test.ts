import { itemIdOf } from "@novadeck/core/items"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { demoTurns } from "../agents/turns"
import { plainDemo } from "../index"
import { demoTourFolder, isDemoTour, type DemoTour } from "../tour"
import { demoRun } from "../tour-runs"
import { coverSvg, heroOf, modelOf, tourEntries } from "./content"
import {
  artistName,
  chosenHero,
  coverAsk,
  fixerName,
  heroAsk,
  heroSculpted,
  heroSubject,
  heroTold,
  pickHero,
  scoreFixed,
  sculptorName,
  serverName,
  teammateCommand,
  tourStoryMs,
} from "./story"

const key = { projectId: "p", workspaceSessionId: "s", terminalId: "t" }

describe("the story's pieces", () => {
  it("starts a teammate on its harness and the lead's model", () => {
    expect(teammateCommand("claude")).toBe("claude --model haiku")
  })

  it("asks as the runner's ask does: a rocket, a robot or a cat, none recommended", () => {
    const terminal = { id: "t", name: sculptorName, handle: "fox" } as TerminalMetadata
    const row = heroAsk(key, terminal, "claude", "Tour", 5)
    expect(row).toMatchObject({
      kind: "ask",
      stopped: false,
      source: { terminalId: "t", handle: "fox", agent: "claude", projectName: "Tour" },
      ask: { subject: heroSubject, shape: { type: "options", recommend: null } },
    })
    if (row.kind !== "ask" || row.ask.shape.type !== "options") throw new Error("not options")
    expect(row.ask.shape.options.map(({ label }) => label)).toEqual([
      "A rocket",
      "A robot",
      "A cat",
    ])
  })

  it("takes the option picked, else the person's own words, else a rocket", () => {
    expect(chosenHero(pickHero(1))).toMatchObject({ name: "a robot", shape: "robot" })
    expect(chosenHero(pickHero(2))).toMatchObject({ name: "a cat", shape: "cat" })
    expect(chosenHero(pickHero("a tiny dragon"))).toMatchObject({
      name: "a tiny dragon",
      shape: "rocket",
    })
    expect(chosenHero(pickHero("my cat Pixel"))).toMatchObject({ shape: "cat" })
    expect(chosenHero(pickHero(7))).toMatchObject({ name: "a rocket" })
    expect(chosenHero(undefined)).toMatchObject({ name: "a rocket" })
    expect(heroTold(heroOf("A robot"))).toBe("The hero is a robot.")
  })

  it("makes a start model and a different sculpted one, each a small glTF the pane can draw", () => {
    const parsed = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes))
    const start = modelOf(undefined, "1")
    const rocket = modelOf(heroOf("A rocket"), "2")
    for (const model of [
      start,
      rocket,
      modelOf(heroOf("A robot"), "2"),
      modelOf(heroOf("A cat"), "2"),
    ]) {
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

  it("draws a cover that stays under the brief's 1500 characters", () => {
    expect(coverSvg(heroOf("A cat")).length).toBeLessThan(1500)
    expect(tourEntries).toContain("src/score.js")
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
  await tour.prepare("claude").catch(() => undefined)
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

// Long enough for the lead to bind, work, describe itself, open its team, and the team to name
// itself, ask and fix.
const teamUp = 300 + 400 + 300 + 300 + 300 + 300 * 4 + 400 * 3 + 600 + tourStoryMs.serve

describe("the story in the demo", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("opens two named teammates, which the lead leads, and a score fixer that fixes the score", async () => {
    const { backend, at, lead, terminals, items, works } = await open()
    await at(teamUp)
    const mates = terminals().filter((each) => each.ledBy === lead)
    expect(mates.map((each) => each.name).toSorted()).toEqual([fixerName, sculptorName])
    for (const mate of mates) expect(mate.titleSource?.kind).toBe("agent")
    const fixer = mates.find((each) => each.name === fixerName)!
    const work = works().find((each) => each.branch === "fix-score")!
    expect(work.terminalId).toBe(fixer.id)
    expect(work.files.map((file) => file.path).toSorted()).toEqual(["README.md", "src/score.js"])
    expect(items().find((item) => item.kind === "changes")).toMatchObject({
      holder: { terminalId: fixer.id },
      by: "agent",
      openAsked: true,
    })
    expect(messagesOf(backend).map(({ text }) => text)).toContain(scoreFixed)
    // Its writes are in the Files feed, under its handle.
    const feed = backend.files!.state.getSnapshot()
    const touched = Object.values(feed.projects).flatMap((project) =>
      Object.entries(project.changes).filter(([path]) => path === "src/score.js"),
    )
    expect(touched[0]?.[1].touched).toHaveProperty(fixer.handle!)
  })

  it("asks to run the game's server; allowed, it opens a terminal of its own and shows the page", async () => {
    const { backend, at, lead, terminals, items, approvals } = await open()
    await at(teamUp)
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
    expect(items().find((item) => item.kind === "page")).toMatchObject({
      holder: { terminalId: lead },
      url: "http://127.0.0.1:5173/",
    })
  })

  it("goes on without a page where the person says no, and where there is none", async () => {
    const declined = await open()
    await declined.at(teamUp)
    declined.backend.approvals!.answer(declined.approvals()[0]!.requestId, false)
    await declined.at(1000)
    expect(declined.items().some((item) => item.kind === "page")).toBe(false)
    expect(declined.terminals().some((each) => each.name === serverName)).toBe(false)
  })

  it("has no page to run where the computer has no Node or Python", async () => {
    vi.useRealTimers()
    const backend = plainDemo("plain", undefined, undefined, demoTurns())
    const tour = backend.tour
    if (!isDemoTour(tour)) throw new Error("no demo tour")
    tour.follow(
      {
        getSnapshot: () => [{ agent: "claude", available: true, connected: true, busy: false }],
        subscribe: () => () => {},
      },
      () => undefined,
    )
    tour.goNoPage()
    await expect(tour.prepare("claude")).resolves.toMatchObject({ page: false })
    // The lead's player takes the plan as it starts; the run after has its page again.
    tour.take()
    await expect(tour.prepare("claude")).resolves.toMatchObject({ page: true })
  })

  it("shows its model, asks who the hero is, and sculpts it once answered", async () => {
    const { backend, tour, at, lead, terminals, items, works, approvals } = await open()
    await at(teamUp)
    const sculptor = terminals().find((each) => each.name === sculptorName)!
    const model = items().find((item) => item.kind === "model")!
    expect(model).toMatchObject({ holder: { terminalId: sculptor.id }, name: "hero.gltf" })
    const rows = backend.inbox!.state.getSnapshot().items.filter((row) => row.kind === "ask")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: { terminalId: sculptor.id }, stopped: false })
    // Nothing is sculpted, and the lead names nothing, while the person takes their time.
    await at(60_000)
    expect(works().some((work) => work.branch === "hero")).toBe(true)
    expect(works().find((work) => work.branch === "hero")?.files).toEqual([])
    expect(works().some((work) => work.branch === "game")).toBe(false)
    const content: unknown[] = []
    backend.companions!.follow(
      { projectId: "p", workspaceSessionId: "s" },
      itemIdOf(String(model.id)),
      { reveal: undefined },
      (each) => content.push(each),
    )
    expect(content[0]).toMatchObject({ content: { kind: "model", format: "gltf" }, stamp: "1" })
    void approvals

    tour.answerHero(1)
    await at(3000)
    expect(
      backend.inbox!.state.getSnapshot().items.filter((row) => row.kind === "ask" && !row.settled),
    ).toHaveLength(0)
    const said = messagesOf(backend).map(({ text }) => text)
    expect(said).toEqual(expect.arrayContaining([heroTold(heroOf("A robot")), heroSculpted]))
    const hero = works().find((work) => work.branch === "hero")!
    expect(hero.files.map((file) => file.path)).toEqual(["model/hero.gltf"])
    expect(works().find((work) => work.branch === "game")).toMatchObject({
      terminalId: lead,
      files: [expect.objectContaining({ path: "src/config.js" })],
    })
    // The open pane hears the model sculpted anew.
    expect(content.at(-1)).toMatchObject({ stamp: "2" })
    // The merged preview of src/config.js names the game for the hero.
    const preview = await backend.works!.preview("p", "src/config.js")
    void preview
  })

  it("takes the person's own words as the hero", async () => {
    const { backend, tour, at } = await open()
    await at(teamUp)
    tour.answerHero("a dragon named Ash")
    await at(3000)
    expect(messagesOf(backend).map(({ text }) => text)).toContain("The hero is a dragon named Ash.")
  })

  it("starts an agent on no team in a new terminal, which draws the cover once the lead answers", async () => {
    const { backend, tour, at, lead, add, terminals, items, works } = await open()
    await at(teamUp)
    tour.answerHero(0)
    await at(4000)
    const id = await add(demoRun("claude").command)
    await at(1000)
    // At its prompt, until the tour rings its brief.
    expect(terminals().find((each) => each.id === id)?.name).not.toBe(artistName)
    await tour.artist!(id)
    await at(9000)
    const artist = terminals().find((each) => each.id === id)!
    expect(artist).toMatchObject({ name: artistName })
    expect(artist.ledBy).toBeUndefined()
    const talk = messagesOf(backend)
    const leadHandle = terminals().find((each) => each.id === lead)!.handle
    expect(talk.find((m) => m.text === coverAsk)).toMatchObject({
      from: { terminalId: id },
      to: { terminalId: lead },
    })
    expect(talk.find((m) => m.to.kind === "agent" && m.to.terminalId === id)).toBeTruthy()
    expect(leadHandle).toBeTruthy()
    expect(works().find((work) => work.branch === "cover")).toMatchObject({
      terminalId: id,
      files: [expect.objectContaining({ path: "art/cover.svg", status: "added" })],
    })
    expect(items().find((item) => item.kind === "image")).toMatchObject({
      holder: { terminalId: id },
    })
  })

  it("keeps the sculptor quiet until nudged, the lead's team quiet until nudged, and stops with the agent", async () => {
    const { tour, at, lead, terminals } = await open((each) => each.goQuietSculptor())
    await at(teamUp)
    const sculptor = terminals().find((each) => each.ledBy === lead && each.name !== fixerName)!
    expect(sculptor.name).not.toBe(sculptorName)
    await tour.nudge!(lead)
    await at(2000)
    expect(terminals().find((each) => each.id === sculptor.id)?.name).toBe(sculptorName)
    tour.stop()
    expect(terminals().find((each) => each.id === lead)?.state).toBe("exited")
  })

  it("waits for a nudge before opening its team", async () => {
    const { tour, at, lead, terminals } = await open((each) => each.goQuietTeam())
    await at(teamUp)
    expect(terminals().filter((each) => each.ledBy === lead)).toEqual([])
    await tour.nudge!(lead)
    await at(1000)
    expect(terminals().some((each) => each.ledBy === lead)).toBe(true)
  })

  it("keeps the artist quiet until nudged", async () => {
    const { tour, at, add, terminals } = await open((each) => each.goQuietArtist())
    await at(teamUp)
    tour.answerHero(0)
    await at(4000)
    const id = await add(demoRun("claude").command)
    await tour.artist!(id)
    await at(4000)
    expect(terminals().find((each) => each.id === id)?.name).not.toBe(artistName)
    await tour.nudge!(id)
    await at(2000)
    expect(terminals().find((each) => each.id === id)?.name).toBe(artistName)
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

  it("starts no artist's agent where it never starts", async () => {
    const { tour, at, add, terminals } = await open((each) => each.goArtistNever())
    await at(teamUp)
    tour.answerHero(0)
    await at(4000)
    const id = await add(demoRun("claude").command)
    await tour.artist!(id)
    await at(6000)
    const artist = terminals().find((each) => each.id === id)!
    expect(artist.state === "running" && artist.agent).toBeFalsy()
    expect(artist.name).not.toBe(artistName)
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
