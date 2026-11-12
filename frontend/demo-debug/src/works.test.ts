import type { Workspace } from "@novadeck/core/types"
import { unread } from "@novadeck/core/works"
import { plainDemo } from "@novadeck/demo"
import { storefrontPlans } from "@novadeck/demo/work-plans"
import { createDemoWorks, worksFromPlans } from "@novadeck/demo/works"

import { context, describe, expect, it } from "./test"
import type { DemoActionContext } from "./types"
import { worksGroups } from "./works"

const seed = plainDemo("plain").seed
const session = seed.projects[0]!.sessions[0]!
const workspace = {
  projects: [
    {
      id: "storefront",
      history: [{ id: session.id, state: { roster: { terminals: session.terminals } } }],
    },
  ],
} as unknown as Workspace
const key = (slot: number) => ({
  projectId: "storefront",
  workspaceSessionId: session.id,
  terminalId: session.terminals[slot]!.id,
})

const setup = (plans = storefrontPlans) => {
  const works = createDemoWorks(worksFromPlans(seed, plans, 0))
  const notes: string[] = []
  const [group] = worksGroups(works)
  const run = (label: string, selected: number | undefined) =>
    void group!.actions
      .find((action) => action.label === label)!
      .run({
        selected: () => (selected === undefined ? undefined : key(selected)),
        workspace: () => workspace,
        note: (text: string) => notes.push(text),
      } as unknown as DemoActionContext)
  const work = (slot: number) =>
    works.state.getSnapshot().works.find((each) => each.terminalId === key(slot).terminalId)
  const rootOf = (slot: number) => work(slot)!.root
  return { works, run, work, rootOf, notes }
}

describe("the debug panel's Changes group", () => {
  it("is absent where the backend's works aren't the demo's", () => {
    expect(worksGroups(undefined)).toEqual([])
    expect(
      worksGroups({
        state: createDemoWorks([]).state,
        watch: () => () => {},
        look: () => {},
        show: async () => null,
        close: async () => ({ branchDeleted: false }),
      }),
    ).toEqual([])
  })

  it("gives every action a hint that names what appears", () => {
    const [group] = worksGroups(createDemoWorks([]))
    for (const action of group!.actions) expect(action.hint, action.label).toMatch(/^Open Changes/)
  })

  context("on a terminal with no work", () => {
    it("makes one at its new lines", () => {
      const { run, work } = setup([])
      run("New lines on its work", 1)
      expect(work(1)).toMatchObject({ unreadAdded: 14 })
    })

    it("lists more files than a row unfolds", () => {
      const { run, work } = setup([])
      run("Many files changed", 1)
      expect(work(1)!.files.length).toBeGreaterThan(6)
    })
  })

  it("conflicts the selected work with main", () => {
    const { run, work } = setup([])
    run("Conflict with main", 1)
    expect(work(1)?.conflicts).toEqual([{ with: "main" }])
  })

  it("conflicts the selected work with another terminal's work, preferring one that has a work", () => {
    const { run, work, rootOf } = setup()
    // Runtime has no work; Checkout implementation, the first terminal with one, is its partner.
    run("Conflict with another work", 4)
    expect(work(4)!.conflicts).toEqual([
      { with: "work", root: rootOf(0), terminalId: key(0).terminalId },
    ])
    expect(work(0)!.conflicts).toContainEqual({
      with: "work",
      root: rootOf(4),
      terminalId: key(4).terminalId,
    })
    run("No conflicts", 4)
    expect(work(4)?.conflicts).toEqual([])
  })

  it("asks to select a terminal first for a conflict between works", () => {
    const { run, notes } = setup()
    run("Conflict with another work", undefined)
    expect(notes).toEqual(["Select a terminal first."])
  })

  it("empties the row when its work is merged, keeping the worktree", () => {
    const { run, work } = setup()
    run("Work merged", 0)
    expect(work(0)).toMatchObject({ files: [], added: 0 })
  })

  it("makes a worktree that differs from nothing, or one with changes", () => {
    const { run, work } = setup([])
    run("Worktree just made", 1)
    expect(work(1)?.files).toEqual([])
    run("Worktree with changes", 1)
    expect(work(1)!.files.length).toBeGreaterThan(0)
  })

  it("leaves a worktree with no owner, or with its owner working in it", () => {
    const { run, work, works } = setup([])
    run("Owner working in it", 1)
    expect(work(1)?.working).toBe(true)
    run("Owner done", 1)
    expect(work(1)?.working).toBe(false)
    run("No owner", 2)
    expect(work(2)).toBeUndefined()
    expect(works.state.getSnapshot().works.filter((each) => each.terminalId === null)).toHaveLength(
      1,
    )
  })

  it("arms a refusal of the next close, and closes every worktree of the project", async () => {
    const { run, works, work, rootOf } = setup()
    run("Refuse the next close", 0)
    await expect(works.close(rootOf(0), true)).rejects.toThrow(/git status/)
    run("Close every worktree", 0)
    expect(work(0)).toBeUndefined()
    expect(
      works.state.getSnapshot().works.filter((each) => each.projectId === "storefront"),
    ).toEqual([])
  })

  it("reads the selected work", () => {
    const { run, work } = setup()
    expect(unread(work(0)!)).toBe(true)
    run("Mark read", 0)
    expect(unread(work(0)!)).toBe(false)
  })

  it("puts a spread of works in the session at once", () => {
    const { run, work, rootOf } = setup([])
    run("Every state in Changes", 0)
    expect(unread(work(0)!)).toBe(true)
    expect(unread(work(1)!)).toBe(false)
    expect(work(2)?.conflicts).toEqual([{ with: "main" }])
    expect(work(3)?.conflicts).toEqual([
      { with: "work", root: rootOf(0), terminalId: key(0).terminalId },
    ])
  })
})
