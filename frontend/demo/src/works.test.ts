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
  closeRefusal,
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

      it("has a work for every plan, of terminals and projects the seed holds, keyed by root", () => {
        expect(works).toHaveLength(plans.length)
        for (const work of works)
          if (work.terminalId !== null) expect(terminals.get(work.terminalId)).toBe(work.projectId)
        expect(new Set(works.map((work) => work.root)).size).toBe(works.length)
      })

      it("mixes unread works with read ones", () => {
        expect(works.some(unread)).toBe(true)
        expect(works.some((work) => !unread(work))).toBe(true)
      })

      it("has a conflict with main and one between two works of a project", () => {
        expect(works.some((work) => work.conflicts.some((each) => each.with === "main"))).toBe(true)
        const roots = new Set(works.map((work) => work.root))
        const between = works.filter((work) =>
          work.conflicts.some((each) => each.with === "work" && roots.has(each.root)),
        )
        expect(between.length).toBeGreaterThanOrEqual(2)
        for (const work of between)
          for (const each of work.conflicts)
            if (each.with === "work")
              expect(works.find((other) => other.root === each.root)?.projectId).toBe(
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

describe("the storefront's worktrees", () => {
  const works = stateOf(plainDemo("plain")).filter((work) => work.projectId === "storefront")

  it("has one with no owner, one just made, one with changes and one its owner is working in", () => {
    expect(works.some((work) => work.terminalId === null && work.files.length > 0)).toBe(true)
    expect(works.some((work) => work.terminalId !== null && work.files.length === 0)).toBe(true)
    expect(works.some((work) => work.terminalId !== null && work.files.length > 0)).toBe(true)
    expect(works.some((work) => work.working)).toBe(true)
  })

  it("gives each a branch of its own, and a worktree of one owner is not another's", () => {
    expect(new Set(works.map((work) => work.branch)).size).toBe(works.length)
    const builds = works.filter((work) => work.branch?.startsWith("agent/build"))
    expect(builds).toHaveLength(2)
    expect(new Set(builds.map((work) => work.terminalId)).size).toBe(1)
  })
})

describe("the demo's works", () => {
  const { seed } = plainDemo("plain")

  const at = { projectId: "storefront", terminalId: "storefront-initial-02", root: "~/x" }

  it("reads a work when it is looked at, and only that one", () => {
    const works = createDemoWorks(worksFromPlans(seed, storefrontPlans, Date.now()))
    const [first, second] = works.state.getSnapshot().works
    works.look(first!.root)
    const after = works.state.getSnapshot().works
    expect(unread(after[0]!)).toBe(false)
    expect(unread(after[1]!)).toBe(unread(second!))
  })

  it("makes a work at a terminal's first change, and adds lines to one it has", () => {
    const works = createDemoWorks([])
    works.gain(at, 10)
    expect(works.state.getSnapshot().works).toMatchObject([
      { root: at.root, terminalId: at.terminalId, unreadAdded: 10 },
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
    const { root, terminalId } = works.state.getSnapshot().works[0]!
    expect(unread(works.state.getSnapshot().works[0]!)).toBe(false)
    works.gain({ ...at, terminalId: terminalId!, root }, 4)
    expect(unread(works.state.getSnapshot().works[0]!)).toBe(true)
  })

  it("conflicts with main and with another work, both ways, and settles", () => {
    const works = createDemoWorks([])
    const other = { ...at, terminalId: "storefront-initial-03", root: "~/y" }
    works.conflictWithMain(at)
    expect(works.state.getSnapshot().works[0]?.conflicts).toEqual([{ with: "main" }])
    works.conflictBetween(at, other)
    const [one, two] = works.state.getSnapshot().works
    expect(one?.conflicts).toContainEqual({
      with: "work",
      root: other.root,
      terminalId: other.terminalId,
    })
    expect(two?.conflicts).toEqual([{ with: "work", root: at.root, terminalId: at.terminalId }])
    works.settle(at.root)
    expect(works.state.getSnapshot().works[0]?.conflicts).toEqual([])
  })

  it("drops a work that is closed, and the conflicts with it", async () => {
    const works = createDemoWorks([])
    const other = { ...at, terminalId: "storefront-initial-03", root: "~/y" }
    works.conflictBetween(at, other)
    await works.close(at.root, true)
    expect(works.state.getSnapshot().works).toMatchObject([
      { terminalId: other.terminalId, conflicts: [] },
    ])
  })

  it("keeps a merged work as a worktree with no files", () => {
    const works = createDemoWorks([])
    works.gain(at, 10)
    works.merge(at.root)
    expect(works.state.getSnapshot().works).toMatchObject([
      { root: at.root, files: [], added: 0, conflicts: [] },
    ])
  })

  it("refuses a close that would lose changes unless forced, and says what it kept", async () => {
    const works = createDemoWorks([])
    works.gain(at, 10)
    expect(await works.close(at.root)).toEqual({ closed: false, holds: "1 changed file" })
    expect(works.state.getSnapshot().works).toHaveLength(1)
    expect(await works.close(at.root, true)).toMatchObject({
      closed: true,
      kept: expect.stringContaining("refs/novadeck/kept/"),
      branchDeleted: false,
    })
    expect(works.state.getSnapshot().works).toEqual([])
  })

  it("closes a worktree that differs from nothing without a question", async () => {
    const works = createDemoWorks([])
    works.openClean(at)
    expect(await works.close(at.root)).toEqual({ closed: true, branchDeleted: true })
    expect(works.state.getSnapshot().works).toEqual([])
  })

  it("refuses to close one its owner's agent is working in, and one the panel armed a refusal for", async () => {
    const works = createDemoWorks([])
    works.gain(at, 10)
    works.setWorking(at.terminalId, true)
    await expect(works.close(at.root, true)).rejects.toThrow(/working in that worktree/)
    works.setWorking(at.terminalId, false)
    works.refuseNextClose()
    await expect(works.close(at.root, true)).rejects.toThrow(closeRefusal)
    // Only the next.
    await expect(works.close(at.root, true)).resolves.toBeDefined()
  })

  it("leaves a worktree with no owner that shows on the bar it is asked for", async () => {
    const works = createDemoWorks([], { show: async (work, on) => `${work.root}@${on}` })
    works.gain(at)
    works.orphan(at.root)
    expect(works.state.getSnapshot().works[0]).toMatchObject({ terminalId: null })
    await expect(works.show(at.root, "t9")).resolves.toBe(`${at.root}@t9`)
    await expect(works.show(at.root)).resolves.toBeNull()
  })

  it("holds commits main lacks in a worktree with no changed files, until merged", async () => {
    const works = createDemoWorks([])
    works.commitsMainLacks(at, 2)
    expect(works.state.getSnapshot().works[0]).toMatchObject({ files: [] })
    expect(await works.close(at.root)).toEqual({
      closed: false,
      holds: "2 commits the main branch doesn't have",
    })
    works.merge(at.root)
    expect(await works.close(at.root)).toEqual({ closed: true, branchDeleted: true })
  })

  it("leaves a worktree whose owner is closed, which shows on the terminal asked for", async () => {
    const works = createDemoWorks([], { show: async (work, on) => `${work.root}@${on}` })
    works.gain(at)
    works.ownerClosed(at.root)
    expect(works.state.getSnapshot().works[0]?.terminalId).toMatch(/^closed-/)
    await expect(works.show(at.root, "t9")).resolves.toBe(`${at.root}@t9`)
  })

  it("empties a project's worktrees", () => {
    const works = createDemoWorks([])
    works.gain(at)
    works.removeAll(at.projectId)
    expect(works.state.getSnapshot().works).toEqual([])
  })

  it("is always synced, watching it is free, and spreading files marks the work truncated", () => {
    const works = createDemoWorks([])
    expect(works.state.getSnapshot().synced).toBe(true)
    expect(() => works.watch()()).not.toThrow()
    works.spread(at, 9)
    expect(works.state.getSnapshot()).toMatchObject({
      synced: true,
      works: [{ truncated: true }],
    })
  })

  it("resolves a show to null where the demo has no pane to show it in", async () => {
    const works = createDemoWorks([])
    works.gain(at)
    await expect(works.show(at.root)).resolves.toBeNull()
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
    const id = await backend.works!.show(work.root)
    expect(id).toBe(`work-${work.root.replace(/[^A-Za-z0-9]+/g, "-")}`)
    expect(reported).toContainEqual(
      expect.objectContaining({
        type: "item/upsert",
        item: expect.objectContaining({ kind: "changes" }),
      }),
    )
  })
})

describe("a demo agent's turn", () => {
  const started = () => {
    const turns = demoTurns()
    const backend = withWorks(plainDemo("plain"), { turns, plans: storefrontPlans })
    const [project] = backend.seed.projects
    const session = project!.sessions[0]!
    const key = (name: string) => {
      const terminal = session.terminals.find((each) => each.name === name)!
      return {
        terminal,
        key: { projectId: project!.id, workspaceSessionId: session.id, terminalId: terminal.id },
      }
    }
    return { turns, backend, key }
  }

  it("adds unread lines to the first work it owns as it starts, once per turn, and holds it busy", () => {
    const { turns, backend, key } = started()
    const { terminal, key: at } = key("Tests")
    const before = stateOf(backend).find((work) => work.terminalId === terminal.id)!
    turns.work(at, terminal)
    turns.work(at, terminal)
    const after = stateOf(backend).find((work) => work.root === before.root)!
    expect(after.unreadAdded - before.unreadAdded).toBe(14)
    expect(after.working).toBe(true)
  })

  it("makes no worktree for an agent that owns none", () => {
    const { turns, backend, key } = started()
    const { terminal, key: at } = key("Dev server")
    const before = stateOf(backend).length
    turns.work(at, terminal)
    expect(stateOf(backend)).toHaveLength(before)
  })
})
