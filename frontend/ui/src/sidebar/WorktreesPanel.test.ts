import type { PullRequest } from "@novadeck/core/forges"
import type { Work, WorkClosing } from "@novadeck/core/works"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, eventually, expect, it } from "../test"
import { WorktreesPanel } from "./WorktreesPanel"

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
    // Whether the backend has reported the works yet; it has by default.
    reported?: boolean
    // Handles by terminal id, bare.
    handles?: ReadonlyMap<string, string>
    fetch?: () => Promise<void>
  } = {},
) => {
  const onSelect = vi.fn<(work: Work, on: string | undefined) => Promise<void>>(
    options.select ?? (async () => {}),
  )
  const onCloseWork = vi.fn<(root: string, force: boolean) => Promise<WorkClosing>>(
    options.close ?? (async () => ({ closed: true, branchDeleted: false })),
  )
  const props = {
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
    selectedId: options.selectedId,
    active: true,
    watching: true,
    onClose: () => {},
    onSelect,
    onCloseWork,
    ...(options.handles ? { handles: options.handles } : {}),
    ...(options.fetch ? { onFetch: options.fetch } : {}),
  }
  const page = render(createElement(WorktreesPanel, props))
  mounted.push(page)
  // The panel again with other works, as another project's, or after a worktree closed.
  const listing = (next: readonly Work[]) =>
    page.rerender(createElement(WorktreesPanel, { ...props, works: next }))
  const rows = () => [...page.container.querySelectorAll<HTMLElement>("[data-worktrees-row]")]
  const row = (name: string) =>
    page.container.querySelector<HTMLElement>(`[data-worktrees-row="/w/${name}"]`)!
  const cross = (name: string) =>
    row(name).querySelector<HTMLButtonElement>(".sidebar-item-actions button")!
  return { page, rows, row, cross, listing, onSelect, onCloseWork }
}

// A pull request of the work's branch, #812, in this state.
const pull = (state: PullRequest["state"], extra: Partial<PullRequest> = {}): PullRequest => ({
  number: 812,
  url: "https://github.com/acme/app/pull/812",
  title: "Work",
  state,
  ...extra,
})

const label = (row: HTMLElement) =>
  row.querySelector(".sidebar-item-select")!.getAttribute("aria-label")

const dialog = () => document.querySelector<HTMLElement>("[role=alertdialog]")
const answer = (name: string) =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent === name)!

describe("the Worktrees panel's rows", () => {
  it("names a row by its worktree's title, else its branch in mono", () => {
    const { row } = show([work("a", { title: "Checkout rounding fix" }), work("b")])
    expect(row("a").querySelector("strong")?.textContent).toBe("Checkout rounding fix")
    expect(row("a").dataset.untitled).toBeUndefined()
    expect(row("b").querySelector("strong")?.textContent).toBe("feat/b")
    expect(row("b").dataset.untitled).toBe("true")
  })

  it("says where its work goes: the pull request's target, else its home, else main", () => {
    const { row } = show([
      work("a", { home: "JIRA-123", pullRequest: pull("open", { base: "release" }) }),
      work("b", { home: "JIRA-123", base: "origin/JIRA-123" }),
      work("c", { base: "origin/main" }),
    ])
    const route = (name: string) =>
      [".worktrees-target", ".worktrees-branch"].map(
        (part) => row(name).querySelector(part)?.textContent,
      )
    expect(route("a")).toEqual(["release", "feat/a"])
    expect(route("b")).toEqual(["JIRA-123", "feat/b"])
    expect(route("c")).toEqual(["main", "feat/c"])
    expect(row("a").querySelector(".worktrees-route-mark")).not.toBeNull()
    expect(label(row("b"))).toContain("feat/b into JIRA-123")
  })

  it("ends its detail line in its owner's handle, or no agent", () => {
    const { row } = show([work("a"), work("b", { terminalId: null })], {
      handles: new Map([["t-a", "moth"]]),
    })
    expect(row("a").querySelector(".sidebar-item-handle")?.textContent).toBe("@moth")
    expect(row("b").querySelector(".sidebar-item-handle")?.textContent).toBe("no agent")
  })

  it("brightens the branch while lines are unread", () => {
    const { row } = show([work("a"), work("b", { unreadAdded: 0, unreadRemoved: 0 })])
    expect(row("a").querySelector<HTMLElement>(".worktrees-branch")?.dataset.unread).toBe("true")
    expect(row("b").querySelector<HTMLElement>(".worktrees-branch")?.dataset.unread).toBeUndefined()
  })

  it("orders rows newest first, by when they were first seen", () => {
    const { rows } = show([
      work("old", { firstSeenAt: 1 }),
      work("new", { firstSeenAt: 3 }),
      work("mid", { firstSeenAt: 2 }),
    ])
    expect(rows().map((each) => each.dataset.worktreesRow)).toEqual(["/w/new", "/w/mid", "/w/old"])
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

describe("a row's glyph and need mark", () => {
  const glyph = (row: HTMLElement) => {
    const mark = row.querySelector<HTMLElement>(".phase-glyph")!
    return [mark.dataset.phase, mark.dataset.failed ?? null, mark.dataset.wakeFill ?? null]
  }
  const need = (row: HTMLElement) =>
    row.querySelector<HTMLElement>(".need-mark")?.dataset.need ?? null

  it("draws what the worktree does in the tab's glyphs", () => {
    const day = 24 * 60 * 60_000
    const { row } = show([
      work("changing", { working: true, uncommitted: 1 }),
      work("checks", { uncommitted: 1, pullRequest: pull("open", { ci: "running" }) }),
      clean("empty", { uncommitted: 0, unpushed: 0 }),
      work("rest", { uncommitted: 1, changedAt: Date.now() }),
      work("dormant", { uncommitted: 1, changedAt: Date.now() - day - 1 }),
      clean("landed", { merged: true, uncommitted: 0 }),
      work("failed", { uncommitted: 1, pullRequest: pull("open", { ci: "failing" }) }),
      work("over", { uncommitted: 0, pullRequest: pull("closed") }),
      work("unknown"),
    ])
    expect(glyph(row("changing"))).toEqual(["running", null, null])
    expect(glyph(row("checks"))).toEqual(["waiting", null, "1"])
    expect(glyph(row("empty"))).toEqual(["starting", null, null])
    expect(glyph(row("rest"))).toEqual(["idle", null, null])
    expect(glyph(row("dormant"))).toEqual(["sleeping", null, null])
    expect(glyph(row("landed"))).toEqual(["done", null, null])
    expect(glyph(row("failed"))).toEqual(["done", "true", null])
    expect(glyph(row("over"))).toEqual(["ended", null, null])
    expect(row("over").dataset.ended).toBe("true")
    expect(glyph(row("unknown"))).toEqual(["unheard", null, null])
    expect(label(row("landed"))).toContain("landed in main")
  })

  it("marks ! where its work can't go on, and says why", () => {
    const { row } = show(
      [
        work("conflict", { uncommitted: 1, conflicts: [{ with: "main" }] }),
        clean("left", { merged: true, safe: false, uncommitted: 2 }),
        work("alone", { terminalId: null, uncommitted: 3 }),
        clean("landed", { merged: true, safe: true, conflicts: [{ with: "main" }] }),
      ],
      { open: ["t-conflict", "t-left", "t-landed"] },
    )
    expect(need(row("conflict"))).toBe("unblock")
    expect(label(row("conflict"))).toContain("Conflicts with main")
    expect(need(row("left"))).toBe("unblock")
    expect(label(row("left"))).toContain("Landed in main; 2 files not committed here")
    expect(need(row("alone"))).toBe("unblock")
    expect(label(row("alone"))).toContain("3 files only here, and no agent on it")
    // Landed wins over a conflict its old branch may still have with what main changed since.
    expect(need(row("landed"))).toBeNull()
  })

  it("asks ? once an open pull request's checks passed, not a draft's", () => {
    const { row } = show([
      work("open", { uncommitted: 0, pullRequest: pull("open", { ci: "passed" }) }),
      work("draft", { uncommitted: 0, pullRequest: pull("draft", { ci: "passed" }) }),
    ])
    expect(need(row("open"))).toBe("ask")
    expect(need(row("draft"))).toBeNull()
  })
})

describe("a row's pull request", () => {
  const segments = (row: HTMLElement) =>
    [...row.querySelectorAll<HTMLElement>(".worktrees-checks i")].map((each) => each.dataset.check)

  it("shows its number tinted by its state, with no link inside the row's button", () => {
    const { row } = show([work("a", { pullRequest: pull("draft") })])
    const number = row("a").querySelector<HTMLElement>(".worktrees-pr")!
    expect(number.textContent).toBe("#812")
    expect(number.dataset.state).toBe("draft")
    expect(row("a").querySelector(".sidebar-item-select a")).toBeNull()
    expect(label(row("a"))).toContain("#812, draft pull request")
  })

  it("draws a bar of its checks, passed first, then its review", () => {
    const { row } = show([
      work("a", {
        pullRequest: pull("open", {
          ci: "running",
          checks: [
            { name: "e2e", state: "waiting" },
            { name: "lint", state: "passed" },
            { name: "test", state: "running" },
            { name: "types", state: "failed" },
          ],
          review: "changes_requested",
        }),
      }),
    ])
    expect(segments(row("a"))).toEqual(["passed", "failed", "running", "waiting"])
    expect(row("a").querySelector<HTMLElement>(".worktrees-checks b")?.dataset.review).toBe(
      "changes_requested",
    )
    expect(label(row("a"))).toContain(
      "1 of 4 checks passed, 1 failed, 1 running, 1 waiting; changes requested",
    )
  })

  it("draws no bar once it is merged or closed", () => {
    const { row } = show([clean("a", { merged: true, pullRequest: pull("merged") })])
    expect(row("a").querySelector(".worktrees-checks")).toBeNull()
  })

  it("opens its page from the row's actions, in the browser", () => {
    const { row } = show([work("a", { pullRequest: pull("open") })])
    const link = row("a").querySelector<HTMLAnchorElement>(".sidebar-item-actions a")!
    expect(link.href).toBe("https://github.com/acme/app/pull/812")
    expect(link.target).toBe("_blank")
    expect(link.getAttribute("aria-label")).toBe("Open #812 in the browser")
  })
})

describe("the trash button on a row", () => {
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
    expect(alert.textContent).toContain("feat/a")
    expect(alert.textContent).toContain("Novadeck couldn't read git status, so it stays.")
    act(() => alert.querySelector("button")!.click())
    expect(page.container.querySelector("[role=alert]")).toBeNull()
  })

  it("lets a refusal and a question go with their row, as when another project opens", async () => {
    const { cross, page, listing } = show([clean("a")], {
      close: () => Promise.reject(new Error("Novadeck couldn't read git status, so it stays.")),
    })
    act(() => cross("a").click())
    await eventually(() => expect(page.container.querySelector("[role=alert]")).not.toBeNull())
    listing([work("b", { projectId: "q" })])
    expect(page.container.querySelector("[role=alert]")).toBeNull()
    listing([clean("a")])
    expect(page.container.querySelector("[role=alert]")).toBeNull()

    const asked = show([work("c")], {
      close: async () => ({ closed: false, holds: "1 commit the main branch doesn't have" }),
    })
    act(() => asked.cross("c").click())
    await eventually(() => expect(dialog()).not.toBeNull())
    asked.listing([work("d", { projectId: "q" })])
    await eventually(() => expect(dialog()).toBeNull())
  })
})

describe("the Worktrees panel with no worktrees", () => {
  it("describes tracked worktrees", () => {
    const { page } = show([])
    expect(page.container.querySelector(".worktrees-empty")?.textContent).toContain(
      "When an agent opens or takes a git worktree",
    )
  })

  context("before the backend has reported them", () => {
    it("says neither that there are none nor how many", () => {
      const { page } = show([], { reported: false })
      expect(page.container.querySelector(".worktrees-empty")).toBeNull()
      expect(page.container.querySelector(".sidebar-panel-count")).toBeNull()
    })

    it("lists the works it already has, with their count", () => {
      const { rows, page } = show([work("a")], { reported: false })
      expect(rows()).toHaveLength(1)
      expect(page.container.querySelector(".sidebar-panel-count")?.textContent).toBe("1")
    })
  })
})

describe("Trash N in the header", () => {
  it("trashes every safe row after one confirm, unforced, and leaves the rest", async () => {
    const { page, onCloseWork } = show([
      clean("merged", { firstSeenAt: 3, merged: true, safe: true }),
      work("closed", { firstSeenAt: 2, pullRequest: pull("closed"), safe: true }),
      clean("held", { firstSeenAt: 1, merged: true, safe: false, uncommitted: 2 }),
    ])
    const sweep = page.container.querySelector<HTMLButtonElement>(".worktrees-sweep")!
    expect(sweep.closest(".sidebar-panel-header")).not.toBeNull()
    expect(sweep.textContent).toBe("2")
    expect(sweep.getAttribute("aria-label")).toBe("Trash 2 safe worktrees")
    act(() => sweep.click())
    await eventually(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain("Trash 2 worktrees?")
    expect(dialog()!.textContent).toContain("Their branches stay.")
    act(() => answer("Trash them").click())
    await eventually(() => expect(onCloseWork).toHaveBeenCalledTimes(2))
    expect(onCloseWork.mock.calls).toEqual([
      ["/w/merged", false],
      ["/w/closed", false],
    ])
  })

  it("isn't drawn while no row is safe", () => {
    const { page } = show([work("a")])
    expect(page.container.querySelector(".worktrees-sweep")).toBeNull()
  })

  it("says why a row that stopped being safe stays", async () => {
    const { page } = show([clean("merged", { merged: true, safe: true })], {
      close: async () => ({ closed: false, holds: "1 uncommitted or untracked path" }),
    })
    act(() => page.container.querySelector<HTMLButtonElement>(".worktrees-sweep")!.click())
    await eventually(() => expect(dialog()).not.toBeNull())
    expect(dialog()!.textContent).toContain("Its branch stays.")
    act(() => answer("Trash it").click())
    await eventually(() =>
      expect(page.container.querySelector("[role=alert]")?.textContent).toContain(
        "stays: it holds 1 uncommitted or untracked path.",
      ),
    )
  })
})

describe("Trash N, while it works", () => {
  const sweep = (page: Rendered) =>
    page.container.querySelector<HTMLButtonElement>(".worktrees-sweep")

  it("leaves out a safe row whose agent is working in it", () => {
    const { page } = show([
      clean("a", { merged: true, safe: true }),
      clean("b", { merged: true, safe: true, working: true }),
    ])
    expect(sweep(page)?.textContent).toBe("1")
  })

  it("takes the rows it closes out of its count until they are closed", async () => {
    let finish: () => void = () => {}
    const { page } = show([clean("a", { merged: true, safe: true })], {
      close: () =>
        new Promise((resolve) => {
          finish = () => resolve({ closed: true, branchDeleted: false })
        }),
    })
    act(() => sweep(page)!.click())
    await eventually(() => expect(dialog()).not.toBeNull())
    act(() => answer("Trash it").click())
    await eventually(() => expect(sweep(page)).toBeNull())
    await act(async () => finish())
  })

  it("names every row that stayed, with the first one's reason", async () => {
    const { page } = show(
      [
        clean("a", { firstSeenAt: 2, merged: true, safe: true }),
        clean("b", { firstSeenAt: 1, merged: true, safe: true }),
      ],
      { close: async () => ({ closed: false, holds: "1 uncommitted or untracked path" }) },
    )
    act(() => sweep(page)!.click())
    await eventually(() => expect(dialog()).not.toBeNull())
    act(() => answer("Trash them").click())
    await eventually(() =>
      expect(page.container.querySelector("[role=alert]")?.textContent).toBe(
        "feat/a, feat/b stay: it holds 1 uncommitted or untracked path.",
      ),
    )
  })
})

describe("the panel's origin line", () => {
  it("says how old the remote's main is, amber after an hour, and fetches it", async () => {
    const fetch = vi.fn<() => Promise<void>>(async () => {})
    const { page } = show(
      [work("a", { base: "origin/main", fetchedAt: Date.now() - 2 * 60 * 60_000 })],
      { fetch },
    )
    const line = page.container.querySelector<HTMLElement>(".worktrees-origin")!
    expect(line.textContent).toContain("origin/main, 2 h ago")
    expect(line.dataset.stale).toBe("true")
    act(() => line.querySelector<HTMLButtonElement>("button")!.click())
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("says when a fetch failed, and offers it again", async () => {
    const { page } = show(
      [work("a", { base: "origin/main", fetchedAt: Date.now() - 5 * 60_000 })],
      { fetch: async () => Promise.reject(new Error("Could not resolve host")) },
    )
    const line = page.container.querySelector<HTMLElement>(".worktrees-origin")!
    act(() => line.querySelector<HTMLButtonElement>("button")!.click())
    await eventually(() => expect(line.textContent).toContain("fetch failed"))
    expect(line.querySelector("button")?.textContent).toBe("Retry")
  })

  it("isn't drawn where nothing was fetched", () => {
    const { page } = show([work("a")])
    expect(page.container.querySelector(".worktrees-origin")).toBeNull()
  })
})
