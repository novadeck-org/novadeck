import type { Work, WorkClosing } from "@novadeck/core/works"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { describe, eventually, expect, it } from "../test"
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
  added: 4,
  removed: 1,
  unreadAdded: 4,
  unreadRemoved: 1,
  files: [
    { path: "a.ts", added: 4, removed: 1, unreadAdded: 4, unreadRemoved: 1, conflict: false },
  ],
  truncated: false,
  conflicts: [],
  ...extra,
})

const clean = (name: string, extra: Partial<Work> = {}) =>
  work(name, { files: [], added: 0, removed: 0, unreadAdded: 0, unreadRemoved: 0, ...extra })

const show = (
  works: readonly Work[],
  options: {
    agentWorktrees?: "on" | "off" | "absent"
    close?: (root: string, force: boolean) => Promise<WorkClosing>
    select?: () => Promise<void>
    // The titles of terminals still open; every owner's by default.
    open?: readonly string[]
    selectedId?: string
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
      synced: true,
      watch: () => () => {},
      titles: new Map(
        works.flatMap((each) =>
          each.terminalId && (options.open ?? [each.terminalId]).includes(each.terminalId)
            ? [[each.terminalId, `Title ${each.terminalId}`] as const]
            : [],
        ),
      ),
      selectedId: options.selectedId,
      agentWorktrees: options.agentWorktrees ?? "on",
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
  it("describes tracked worktrees, and points to Preferences while the setting is off", () => {
    const off = show([], { agentWorktrees: "off" })
    expect(off.page.container.querySelector(".changes-empty")?.textContent).toContain(
      "When an agent opens or takes a git worktree",
    )
    expect(off.page.container.querySelector(".changes-empty")?.textContent).toContain(
      "Preferences → Experimental",
    )
  })

  it("does not point to Preferences with the setting on, or where the backend has none", () => {
    for (const agentWorktrees of ["on", "absent"] as const) {
      const { page } = show([], { agentWorktrees })
      expect(page.container.querySelector(".changes-empty")?.textContent).not.toContain(
        "Preferences",
      )
      page.unmount()
      mounted.pop()
    }
  })
})
