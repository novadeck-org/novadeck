import type { Backend } from "@novadeck/core/port"
import { unread } from "@novadeck/core/works"

import { demoTurns } from "./agents/turns"
import { createDemoBackend, plainDemo } from "./index"
import { showcaseDemo } from "./showcase/demo"
import { context, describe, expect, it } from "./test"
import { visitorDemo } from "./visitor"
import {
  babciaPlans,
  chirpPlans,
  launchPlans,
  showcasePlans,
  storefrontPlans,
  visitorPlans,
} from "./work-plans"
import {
  createDemoWorks,
  isDemoWorks,
  planFile,
  withWorks,
  worksFromPlans,
  type WorkPlan,
} from "./works"

const stateOf = (backend: Backend) => backend.works!.state.getSnapshot().works

const setups: readonly (readonly [string, () => Backend, readonly WorkPlan[]])[] = [
  ["plain", () => plainDemo("plain"), storefrontPlans],
  ["welcome", () => plainDemo("welcome"), storefrontPlans],
  ["agents", () => plainDemo("agents"), storefrontPlans],
  ["messages", () => plainDemo("messages"), storefrontPlans],
  ["inbox", () => plainDemo("inbox"), storefrontPlans],
  ["spec backend", () => createDemoBackend(), storefrontPlans],
  ["chirp", () => plainDemo("chirp"), chirpPlans],
  ["babcia", () => plainDemo("babcia"), babciaPlans],
  ["launch", () => plainDemo("launch"), launchPlans],
  ["showcase", () => showcaseDemo(), showcasePlans],
  ["visitor", () => visitorDemo({ ambient: false }), visitorPlans],
]

describe("the demo's Changes seeds", () => {
  for (const [name, make, plans] of setups) {
    context(`in the ${name} demo`, () => {
      const backend = make()
      const works = stateOf(backend)
      const terminals = new Map(
        backend.seed.projects.flatMap((project) =>
          project.sessions.flatMap((session) =>
            session.terminals.map((terminal) => [terminal.id, project.id] as const),
          ),
        ),
      )

      it("has a work for every plan, of terminals and projects the seed holds", () => {
        expect(works).toHaveLength(plans.length)
        for (const work of works) expect(terminals.get(work.terminalId)).toBe(work.projectId)
      })

      it("mixes unread works with read ones", () => {
        expect(works.some(unread)).toBe(true)
        expect(works.some((work) => !unread(work))).toBe(true)
      })

      it("has a conflict with main and one between two works of a project", () => {
        expect(works.some((work) => work.conflicts.some((each) => each.with === "main"))).toBe(true)
        const ids = new Set(works.map((work) => work.terminalId))
        const between = works.filter((work) =>
          work.conflicts.some((each) => each.with === "work" && ids.has(each.terminalId)),
        )
        expect(between.length).toBeGreaterThanOrEqual(2)
        for (const work of between)
          for (const each of work.conflicts)
            if (each.with === "work")
              expect(works.find((other) => other.terminalId === each.terminalId)?.projectId).toBe(
                work.projectId,
              )
      })

      it("lists a conflicting file wherever a work conflicts", () => {
        for (const work of works.filter((each) => each.conflicts.length > 0))
          expect(work.files.some((file) => file.conflict)).toBe(true)
      })

      it("sums each work from its files", () => {
        for (const work of works) {
          expect(work.added).toBe(work.files.reduce((sum, file) => sum + file.added, 0))
          expect(work.unreadRemoved).toBe(
            work.files.reduce((sum, file) => sum + file.unreadRemoved, 0),
          )
        }
      })
    })
  }
})

describe("the demo's works", () => {
  const { seed } = plainDemo("plain")

  const at = { projectId: "storefront", terminalId: "storefront-initial-02", root: "~/x" }

  it("reads a work when it is looked at, and only that one", () => {
    const works = createDemoWorks(worksFromPlans(seed, storefrontPlans, Date.now()))
    const [first, second] = works.state.getSnapshot().works
    works.look(first!.terminalId)
    const after = works.state.getSnapshot().works
    expect(unread(after[0]!)).toBe(false)
    expect(unread(after[1]!)).toBe(unread(second!))
  })

  it("makes a work at a terminal's first change, and adds lines to one it has", () => {
    const works = createDemoWorks([])
    works.gain(at, 10)
    expect(works.state.getSnapshot().works).toMatchObject([
      { terminalId: at.terminalId, unreadAdded: 10 },
    ])
    works.gain(at, 5)
    expect(works.state.getSnapshot().works[0]).toMatchObject({ added: 15, unreadAdded: 15 })
  })

  it("brings a read work back with unread lines", () => {
    const works = createDemoWorks(
      worksFromPlans(
        seed,
        [
          {
            project: "storefront",
            terminal: "Build",
            minutesAgo: 5,
            files: [planFile("a.ts", 3, 1, { read: true })],
          },
        ],
        Date.now(),
      ),
    )
    const id = works.state.getSnapshot().works[0]!.terminalId
    expect(unread(works.state.getSnapshot().works[0]!)).toBe(false)
    works.gain({ ...at, terminalId: id }, 4)
    expect(unread(works.state.getSnapshot().works[0]!)).toBe(true)
  })

  it("conflicts with main and with another work, both ways, and settles", () => {
    const works = createDemoWorks([])
    const other = { ...at, terminalId: "storefront-initial-03" }
    works.conflictWithMain(at)
    expect(works.state.getSnapshot().works[0]?.conflicts).toEqual([{ with: "main" }])
    works.conflictBetween(at, other)
    const [one, two] = works.state.getSnapshot().works
    expect(one?.conflicts).toContainEqual({ with: "work", terminalId: other.terminalId })
    expect(two?.conflicts).toEqual([{ with: "work", terminalId: at.terminalId }])
    works.settle(at.terminalId)
    expect(works.state.getSnapshot().works[0]?.conflicts).toEqual([])
  })

  it("drops a work that ends, and the conflicts with it", () => {
    const works = createDemoWorks([])
    const other = { ...at, terminalId: "storefront-initial-03" }
    works.conflictBetween(at, other)
    works.end(at.terminalId)
    expect(works.state.getSnapshot().works).toMatchObject([
      { terminalId: other.terminalId, conflicts: [] },
    ])
  })

  it("resolves a show to null where the demo has no pane to show it in", async () => {
    const works = createDemoWorks([])
    works.gain(at)
    await expect(works.show(at.terminalId)).resolves.toBeNull()
    expect(isDemoWorks(works)).toBe(true)
  })
})

describe("the showcase's Changes", () => {
  it("shows a work as a changes item on its terminal's bar", async () => {
    const backend = showcaseDemo()
    const work = stateOf(backend).find((each) => unread(each))!
    const reported: unknown[] = []
    backend.start?.({ dispatch: (actions: unknown[]) => reported.push(...actions) } as never)
    backend.commit(
      {
        activeProjectId: "studio",
        projects: backend.seed.projects.map((project) => ({
          id: project.id,
          directory: project.directory,
          history: project.sessions.map((session) => ({
            id: session.id,
            state: { roster: { terminals: session.terminals } },
          })),
        })),
      } as never,
      [],
    )
    const id = await backend.works!.show(work.terminalId)
    expect(id).toBe(`work-${work.terminalId}`)
    expect(reported).toContainEqual(
      expect.objectContaining({
        type: "item/upsert",
        item: expect.objectContaining({ kind: "changes" }),
      }),
    )
  })
})

describe("a demo agent's turn", () => {
  it("adds unread lines to its work as it starts, once per turn", () => {
    const turns = demoTurns()
    const backend = withWorks(plainDemo("plain"), { turns })
    const [project] = backend.seed.projects
    const session = project!.sessions[0]!
    const terminal = session.terminals.find((each) => each.name === "Dev server")!
    const key = { projectId: project!.id, workspaceSessionId: session.id, terminalId: terminal.id }
    expect(stateOf(backend)).toEqual([])

    turns.work(key, terminal)
    turns.work(key, terminal)

    expect(stateOf(backend)).toMatchObject([{ terminalId: terminal.id, unreadAdded: 14 }])
  })
})
