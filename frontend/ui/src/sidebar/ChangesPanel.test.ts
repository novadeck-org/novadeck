import type { Work } from "@novadeck/core/works"
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
    close?: (root: string, force: boolean) => Promise<{ branchDeleted: boolean }>
    selectedId?: string
  } = {},
) => {
  const onSelect = vi.fn<(work: Work) => void>()
  const onCloseWork = vi.fn<(root: string, force: boolean) => Promise<{ branchDeleted: boolean }>>(
    options.close ?? (async () => ({ branchDeleted: false })),
  )
  const page = render(
    createElement(ChangesPanel, {
      works,
      synced: true,
      watch: () => () => {},
      titles: new Map(
        works.flatMap((each) =>
          each.terminalId ? [[each.terminalId, `Title ${each.terminalId}`] as const] : [],
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
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ root: "/w/a" }))
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
  it("closes a worktree that differs from nothing at once", async () => {
    const { cross, onCloseWork } = show([clean("a")])
    act(() => cross("a").click())
    expect(onCloseWork).toHaveBeenCalledWith("/w/a", false)
    expect(dialog()).toBeNull()
  })

  it("asks first when files differ from main, saying what is kept", async () => {
    const { cross, onCloseWork } = show([work("a")])
    act(() => cross("a").click())
    await eventually(() => expect(dialog()).not.toBeNull())
    expect(onCloseWork).not.toHaveBeenCalled()
    const text = dialog()!.textContent!
    expect(text).toContain("Close this worktree?")
    expect(text).toContain("Committed work stays on the branch feat/a.")
    expect(text).toContain(
      "Uncommitted work, and commits only a detached HEAD reaches, are kept on a ref",
    )
    expect(text).toContain("refs/novadeck/kept/")
    expect(text).toContain("Ignored files, such as .env, are not kept.")
    act(() => answer("Close worktree").click())
    expect(onCloseWork).toHaveBeenCalledWith("/w/a", true)
  })

  it("keeps the worktree when the person keeps it", async () => {
    const { cross, onCloseWork } = show([work("a")])
    act(() => cross("a").click())
    await eventually(() => expect(dialog()).not.toBeNull())
    act(() => answer("Keep it").click())
    expect(onCloseWork).not.toHaveBeenCalled()
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
