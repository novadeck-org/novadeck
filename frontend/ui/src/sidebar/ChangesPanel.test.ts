import type { Work, WorkClosing, WorkFile } from "@novadeck/core/works"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, eventually, expect, it } from "../test"
import { ChangesPanel } from "./ChangesPanel"

const mounted: Rendered[] = []
afterEach(() => mounted.splice(0).forEach((page) => page.unmount()))

const work = (name: string, extra: Partial<Work> = {}): Work => ({
  root: `/w/${name}`,
  terminalId: `t-${name}`,
  projectId: "p",
  working: false,
  branch: `feat/${name}`,
  base: "main",
  firstSeenAt: 1,
  merged: false,
  added: 4,
  removed: 1,
  unreadAdded: 4,
  unreadRemoved: 1,
  files: [
    {
      path: "a.ts",
      status: "modified",
      changedAt: 1,
      added: 4,
      removed: 1,
      unreadAdded: 4,
      unreadRemoved: 1,
      conflict: false,
    },
  ],
  truncated: false,
  conflicts: [],
  ...extra,
})

// A file of 4 lines added and 1 removed, with `unreadAdded` and `unreadRemoved` as given.
const file = (unreadAdded: number, unreadRemoved: number): WorkFile => ({
  path: "a.ts",
  status: "modified",
  changedAt: 1,
  added: 4,
  removed: 1,
  unreadAdded,
  unreadRemoved,
  conflict: false,
})

const clean = (name: string, extra: Partial<Work> = {}) =>
  work(name, { files: [], added: 0, removed: 0, unreadAdded: 0, unreadRemoved: 0, ...extra })

const show = (
  works: readonly Work[],
  options: {
    close?: (root: string, force: boolean) => Promise<WorkClosing>
    select?: () => Promise<void>
    // The titles of terminals still open; every owner's by default.
    open?: readonly string[]
    selectedId?: string
    // The projects' names by id; the one project of the works' by default.
    projects?: ReadonlyMap<string, string>
    // Whether the backend has reported the works yet; it has by default.
    reported?: boolean
  } = {},
) => {
  const onSelect = vi.fn<(work: Work, on: string | undefined) => Promise<void>>(
    options.select ?? (async () => {}),
  )
  const onCloseWork = vi.fn<(root: string, force: boolean) => Promise<WorkClosing>>(
    options.close ?? (async () => ({ closed: true, branchDeleted: false })),
  )
  const page = render(
    createElement(ChangesPanel, {
      works,
      reported: options.reported ?? true,
      watch: () => () => {},
      titles: new Map(
        works.flatMap((each) =>
          each.terminalId && (options.open ?? [each.terminalId]).includes(each.terminalId)
            ? [[each.terminalId, `Title ${each.terminalId}`] as const]
            : [],
        ),
      ),
      projects: options.projects ?? new Map([["p", "Storefront"]]),
      selectedId: options.selectedId,
      active: true,
      watching: true,
      onClose: () => {},
      onSelect,
      onCloseWork,
    }),
  )
  mounted.push(page)
  const rows = () => [...page.container.querySelectorAll<HTMLElement>("[data-changes-row]")]
  const row = (name: string) =>
    page.container.querySelector<HTMLElement>(`[data-changes-row="/w/${name}"]`)!
  const cross = (name: string) =>
    row(name).querySelector<HTMLButtonElement>(".sidebar-item-actions button")!
  return { page, rows, row, cross, onSelect, onCloseWork }
}

const dialog = () => document.querySelector<HTMLElement>("[role=alertdialog]")
const answer = (name: string) =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent === name)!

describe("the Changes panel's rows", () => {
  it("names a row by its owner's title, with its branch on the detail line", () => {
    const { row } = show([work("a")])
    expect(row("a").querySelector("strong")?.textContent).toBe("Title t-a")
    expect(row("a").querySelector(".sidebar-item-detail")?.textContent).toBe("feat/a")
  })

  it("shows the work's total lines on the row and on each file, never gray for being read", () => {
    const { row } = show([work("a", { unreadAdded: 0, unreadRemoved: 0, files: [file(0, 0)] })])
    expect(row("a").querySelector(".changes-size")?.textContent).toBe("+4−1")
    expect(row("a").querySelector(".changes-trail")?.textContent).toBe("+4−1")
    expect(row("a").querySelector("[data-read]")).toBeNull()
    expect(row("a").dataset.read).toBeUndefined()
    expect(row("a").dataset.readStart).toBeUndefined()
    expect(row("a").dataset.arrived).toBeUndefined()
  })

  it("orders rows by when they were first seen, with no line between", () => {
    const { rows } = show([work("b", { firstSeenAt: 2 }), work("a", { firstSeenAt: 1 })])
    expect(rows().map((each) => each.dataset.changesRow)).toEqual(["/w/a", "/w/b"])
    expect(rows().some((each) => each.dataset.readStart !== undefined)).toBe(false)
  })

  it("says No owner for a worktree without one, and keeps a row for each root", () => {
    const { rows, row } = show([
      work("a", { terminalId: null }),
      work("b", { terminalId: "t-a" }),
      work("c", { terminalId: "t-a" }),
    ])
    expect(rows()).toHaveLength(3)
    expect(row("a").querySelector("strong")?.textContent).toBe("No owner")
  })

  it("shows the work on click, by the work itself", () => {
    const { row, onSelect } = show([work("a")])
    act(() => row("a").querySelector<HTMLButtonElement>(".sidebar-item-select")!.click())
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ root: "/w/a" }), "t-a")
  })

  it("shows a work whose owner is closed, or has none, on the selected terminal's bar", () => {
    const { row, onSelect } = show([work("a"), work("b", { terminalId: null })], {
      selectedId: "t-sel",
      open: [],
    })
    act(() => row("a").querySelector<HTMLButtonElement>(".sidebar-item-select")!.click())
    act(() => row("b").querySelector<HTMLButtonElement>(".sidebar-item-select")!.click())
    expect(onSelect.mock.calls.map(([, on]) => on)).toEqual(["t-sel", "t-sel"])
    expect(row("a").querySelector("strong")?.textContent).toBe("Closed terminal")
  })

  it("says why a work can't be shown, rather than leaving the click silent", async () => {
    const { row, page } = show([work("a")], {
      select: () => Promise.reject(new Error("That terminal is gone.")),
    })
    act(() => row("a").querySelector<HTMLButtonElement>(".sidebar-item-select")!.click())
    await eventually(() => expect(page.container.querySelector("[role=alert]")).not.toBeNull())
    expect(page.container.querySelector("[role=alert]")!.textContent).toContain(
      "can't be shown: That terminal is gone.",
    )
  })

  it("marks only one of a terminal's worktrees selected", () => {
    const { row } = show([work("a", { terminalId: "t" }), work("b", { terminalId: "t" })], {
      selectedId: "t",
    })
    expect(row("a").dataset.selected).toBe("true")
    expect(row("b").dataset.selected).toBe("false")
  })
})

describe("a row's accessible label", () => {
  const label = (page: Rendered) =>
    page.container.querySelector(".sidebar-item-select")!.getAttribute("aria-label")

  it("says the work's total lines, with line singular for one, and none for a work with none", () => {
    expect(label(show([work("a")]).page)).toContain("1 file changed, 4 lines added, 1 removed")
    const one = show([work("b", { added: 1, removed: 0 })])
    expect(label(one.page)).toContain("1 line added")
    expect(label(one.page)).not.toContain("removed")
    expect(label(show([clean("c")]).page)).not.toContain("added")
  })
})

describe("a merged work's row", () => {
  const merged = () => clean("m", { merged: true })
  const label = (page: Rendered) =>
    page.container.querySelector(".sidebar-item-select")!.getAttribute("aria-label")

  it("is marked merged, says so in its accessible label and keeps its branch", () => {
    const { row, page } = show([merged()])
    expect(row("m").dataset.merged).toBe("true")
    expect(label(page)).toContain("merged")
    expect(row("m").querySelector(".sidebar-item-detail")?.textContent).toBe("feat/m")
  })

  it("is not marked for a worktree just made", () => {
    const { row, page } = show([clean("n")])
    expect(row("n").dataset.merged).toBeUndefined()
    expect(label(page)).not.toContain("merged")
  })

  it("lets a conflict win over merged", () => {
    const { row, page } = show([work("c", { merged: true, conflicts: [{ with: "main" }] })])
    expect(row("c").dataset.merged).toBeUndefined()
    expect(row("c").dataset.conflict).toBe("true")
    expect(label(page)).toContain("conflicts with main")
    expect(label(page)).not.toContain("merged")
  })
})

describe("the projects of the rows", () => {
  const projects = new Map([
    ["p", "Storefront"],
    ["q", "Api"],
  ])

  it("names each row's project beside its branch where the panel lists several", () => {
    const { row } = show([work("a"), work("b", { projectId: "q" })], { projects })
    expect(row("a").querySelector(".changes-project")?.textContent).toBe("Storefront")
    expect(row("b").querySelector(".changes-project")?.textContent).toBe("Api")
  })

  it("names none while the panel lists one project", () => {
    const { row } = show([work("a")])
    expect(row("a").querySelector(".changes-project")).toBeNull()
  })

  it("shows another project's work on its owner's bar", () => {
    const { row, onSelect } = show([work("a"), work("b", { projectId: "q" })], { projects })
    act(() => row("b").querySelector<HTMLButtonElement>(".sidebar-item-select")!.click())
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ root: "/w/b", projectId: "q" }),
      "t-b",
    )
  })
})

describe("the × on a row", () => {
  const holding = async () =>
    ({ closed: false, holds: "2 changed files and 1 commit the main branch doesn't have" }) as const

  it("asks the runner to close, unforced, and closes at once when it did", async () => {
    const { cross, onCloseWork } = show([clean("a")])
    act(() => cross("a").click())
    expect(onCloseWork).toHaveBeenCalledWith("/w/a", false)
    await Promise.resolve()
    expect(dialog()).toBeNull()
  })

  it("asks the runner even for a work with files: it is the runner's standing that decides", async () => {
    const { cross, onCloseWork } = show([work("a")], {
      close: async () => ({ closed: true, branchDeleted: true }),
    })
    act(() => cross("a").click())
    expect(onCloseWork).toHaveBeenCalledWith("/w/a", false)
    await Promise.resolve()
    expect(dialog()).toBeNull()
  })

  it("asks first when the runner says it holds something, saying what, and forces only once confirmed", async () => {
    const { cross, onCloseWork } = show([clean("a")], {
      close: (_root, force) =>
        force ? Promise.resolve({ closed: true, branchDeleted: false }) : holding(),
    })
    act(() => cross("a").click())
    await eventually(() => expect(dialog()).not.toBeNull())
    expect(onCloseWork).toHaveBeenCalledTimes(1)
    const text = dialog()!.textContent!
    expect(text).toContain("Close this worktree?")
    expect(text).toContain("2 changed files and 1 commit the main branch doesn't have")
    expect(text).toContain("Committed work stays on the branch feat/a.")
    expect(text).toContain(
      "Uncommitted work, and commits only a detached HEAD reaches, are kept on a ref",
    )
    expect(text).toContain("refs/novadeck/kept/")
    expect(text).toContain("Ignored files, such as .env, are not kept.")
    act(() => answer("Close worktree").click())
    expect(onCloseWork).toHaveBeenLastCalledWith("/w/a", true)
  })

  it("words the dialog for a detached worktree, which has no branch", async () => {
    const { cross } = show([work("a", { branch: null })], { close: holding })
    act(() => cross("a").click())
    await eventually(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).not.toContain("stays on the branch")
    expect(dialog()!.textContent).toContain("commits only a detached HEAD reaches")
  })

  it("keeps the worktree when the person keeps it", async () => {
    const { cross, onCloseWork } = show([work("a")], { close: holding })
    act(() => cross("a").click())
    await eventually(() => expect(dialog()).not.toBeNull())
    act(() => answer("Keep it").click())
    expect(onCloseWork).toHaveBeenCalledTimes(1)
  })

  it("takes a worktree an agent closed meanwhile as closed, with no complaint", async () => {
    const { cross, page } = show([work("a")], {
      close: () =>
        Promise.reject(Object.assign(new Error("Novadeck tracks none"), { code: "NOT_FOUND" })),
    })
    act(() => cross("a").click())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(page.container.querySelector("[role=alert]")).toBeNull()
  })

  it("waits while the owner's agent works in the worktree, and says why", () => {
    const { cross, onCloseWork } = show([work("a", { working: true })])
    expect(cross("a").getAttribute("aria-disabled")).toBe("true")
    act(() => cross("a").click())
    expect(onCloseWork).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
  })

  it("shows the reason a close is refused above the list, and lets it be dismissed", async () => {
    const { cross, page } = show([clean("a")], {
      close: () => Promise.reject(new Error("Novadeck couldn't read git status, so it stays.")),
    })
    act(() => cross("a").click())
    await eventually(() => expect(page.container.querySelector("[role=alert]")).not.toBeNull())
    const alert = page.container.querySelector("[role=alert]")!
    expect(alert.textContent).toContain("Title t-a")
    expect(alert.textContent).toContain("Novadeck couldn't read git status, so it stays.")
    act(() => alert.querySelector("button")!.click())
    expect(page.container.querySelector("[role=alert]")).toBeNull()
  })
})

describe("the Changes panel with no worktrees", () => {
  it("describes tracked worktrees", () => {
    const { page } = show([])
    expect(page.container.querySelector(".changes-empty")?.textContent).toContain(
      "When an agent opens or takes a git worktree",
    )
  })

  context("before the backend has reported them", () => {
    it("says neither that there are none nor how many", () => {
      const { page } = show([], { reported: false })
      expect(page.container.querySelector(".changes-empty")).toBeNull()
      expect(page.container.querySelector(".sidebar-panel-count")).toBeNull()
    })

    it("lists the works it already has, with their count", () => {
      const { rows, page } = show([work("a")], { reported: false })
      expect(rows()).toHaveLength(1)
      expect(page.container.querySelector(".sidebar-panel-count")?.textContent).toBe("1")
    })
  })
})
