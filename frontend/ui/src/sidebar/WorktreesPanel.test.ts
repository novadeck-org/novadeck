import type { Work, WorkClosing, WorkFile } from "@novadeck/core/works"
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
    // Whether a work's files open as previews (main has them); they do by default.
    canOpen?: boolean
    // Whether the backend has reported the works yet; it has by default.
    reported?: boolean
    // Handles by terminal id, as people see them.
    handles?: ReadonlyMap<string, string>
    // Whether a forge is on; one is by default.
    forges?: boolean
    fetch?: () => Promise<void>
  } = {},
) => {
  const onSelect = vi.fn<(work: Work, on: string | undefined) => Promise<void>>(
    options.select ?? (async () => {}),
  )
  const onOpenFile = vi.fn<(work: Work, path: string) => void>()
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
    canOpenFile: () => options.canOpen ?? true,
    onOpenFile,
    onCloseWork,
    ...(options.handles ? { handles: options.handles } : {}),
    ...(options.forges === undefined ? {} : { forges: options.forges }),
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
  return { page, rows, row, cross, listing, onSelect, onOpenFile, onCloseWork }
}

const dialog = () => document.querySelector<HTMLElement>("[role=alertdialog]")
const answer = (name: string) =>
  [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent === name)!

describe("the Worktrees panel's rows", () => {
  it("opens a file, added ones too, as a preview, without selecting the row", () => {
    const added: WorkFile = { ...file(0, 0), path: "new.ts", status: "added" }
    const { row, onOpenFile, onSelect } = show([work("a", { files: [file(0, 0), added] })])
    const open = row("a").querySelectorAll<HTMLButtonElement>(".worktrees-file-open")
    expect(open).toHaveLength(2)
    // Beside the row's select button, not inside it.
    expect(open[0]!.closest("button:not(.worktrees-file-open)")).toBeNull()
    open[0]!.click()
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ root: "/w/a" }), "a.ts")
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("marks a work's pull request with a link to its page, after its state in words", () => {
    const pullRequest = {
      number: 812,
      url: "https://github.com/acme/shop/pull/812",
      title: "Checkout",
      state: "draft" as const,
    }
    const { row, onSelect } = show([work("a", { pullRequest }), work("b")])
    const link = row("a").querySelector<HTMLAnchorElement>("a.worktrees-pr")!
    expect(link.textContent).toBe("#812")
    expect(link.getAttribute("aria-label")).toBe("#812, draft pull request, opens in browser")
    expect(link.href).toBe(pullRequest.url)
    expect(link.target).toBe("_blank")
    expect(link.rel).toBe("noopener noreferrer")
    // Not inside the select button, so it is a control of its own, reached by Tab; right after
    // the fact that says the pull request's state, and none on a row without one.
    expect(link.closest("button")).toBeNull()
    expect(link.closest(".worktrees-fact")?.textContent).toBe("Draft#812")
    expect(row("b").querySelector("a.worktrees-pr")).toBeNull()
    expect(row("a").dataset.pullRequest).toBe("draft")
    link.addEventListener("click", (event) => event.preventDefault())
    link.click()
    expect(onSelect).not.toHaveBeenCalled()
    expect(row("b").querySelector(".worktrees-pr")).toBeNull()
  })

  it("marks each state by its glyph, and keeps a merged work's own merged state", () => {
    const state = (name: "open" | "merged" | "closed") => ({
      number: 7,
      url: "https://example.dev/7",
      title: "t",
      state: name,
    })
    const { row } = show([
      work("a", { pullRequest: state("open") }),
      work("b", { merged: true, pullRequest: state("merged") }),
      work("c", { pullRequest: state("closed") }),
    ])
    const glyph = (name: string) =>
      row(name)
        .querySelector(".worktrees-pr svg")
        ?.getAttribute("class")
        ?.match(/lucide-git-[a-z-]+/)?.[0]
    expect([glyph("a"), glyph("b"), glyph("c")]).toEqual([
      "lucide-git-pull-request",
      "lucide-git-merge",
      "lucide-git-pull-request-closed",
    ])
    expect(row("a").querySelector(".worktrees-pr")?.textContent).toBe("#7")
    expect(row("b").dataset.merged).toBe("true")
  })

  it("offers no preview of files it can't open", () => {
    const { row } = show([work("a")], { canOpen: false })
    expect(row("a").querySelector(".worktrees-file-open")).toBeNull()
  })

  it("names a row by its owner's title, with its branch on the detail line", () => {
    const { row } = show([work("a")])
    expect(row("a").querySelector("strong")?.textContent).toBe("Title t-a")
    expect(row("a").querySelector(".sidebar-item-detail")?.textContent).toBe("feat/a")
  })

  it("shows the work's total lines on the row and on each file, never gray for being read", () => {
    const { row } = show([work("a", { unreadAdded: 0, unreadRemoved: 0, files: [file(0, 0)] })])
    expect(row("a").querySelector(".worktrees-size")?.textContent).toBe("+4−1")
    expect(row("a").querySelector(".worktrees-trail")?.textContent).toBe("+4−1")
    expect(row("a").querySelector("[data-read]")).toBeNull()
    expect(row("a").dataset.read).toBeUndefined()
    expect(row("a").dataset.readStart).toBeUndefined()
    expect(row("a").dataset.arrived).toBeUndefined()
  })

  it("orders rows newest first, by when they were first seen, with no line between", () => {
    const { rows } = show([work("a", { firstSeenAt: 1 }), work("b", { firstSeenAt: 2 })])
    expect(rows().map((each) => each.dataset.worktreesRow)).toEqual(["/w/b", "/w/a"])
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

  it("lets merged win over a conflict", () => {
    const { row, page } = show([work("c", { merged: true, conflicts: [{ with: "main" }] })])
    expect(row("c").dataset.merged).toBe("true")
    expect(row("c").dataset.conflict).toBeUndefined()
    expect(label(page)).toContain("merged")
    expect(label(page)).not.toContain("conflicts with main")
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
    expect(alert.textContent).toContain("Title t-a")
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

describe("the Worktrees panel's groups", () => {
  afterEach(() => localStorage.removeItem("novadeck.worktrees.done-folded"))
  const pull = (state: "draft" | "open" | "merged" | "closed", extra = {}) => ({
    number: 812,
    url: "https://github.com/acme/app/pull/812",
    title: "Work",
    state,
    ...extra,
  })
  const listed = (page: Rendered) =>
    [...page.container.querySelectorAll<HTMLElement>("[role=list]")].map((list) => [
      list.getAttribute("aria-label"),
      [...list.querySelectorAll<HTMLElement>("[data-worktrees-row]")].map((row) =>
        row.dataset.worktreesRow!.slice(3),
      ),
    ])

  it("lists works by what is next: needs you, in progress, in review, done", () => {
    const { page } = show([
      work("conflict", { firstSeenAt: 6, conflicts: [{ with: "main" }] }),
      work("failing", { firstSeenAt: 5, pullRequest: pull("open", { ci: "failing" }) }),
      work("plain", { firstSeenAt: 4 }),
      work("draft", { firstSeenAt: 3, pullRequest: pull("draft") }),
      clean("merged", { firstSeenAt: 2, merged: true, conflicts: [{ with: "main" }] }),
      work("closed", { firstSeenAt: 1, pullRequest: pull("closed") }),
    ])
    expect(listed(page)).toEqual([
      ["Needs you", ["conflict", "failing"]],
      ["In progress", ["plain"]],
      ["In review", ["draft"]],
      ["Done", ["merged", "closed"]],
    ])
    expect(
      [...page.container.querySelectorAll("h3")].map((heading) => heading.textContent),
    ).toEqual(["Needs you2", "In progress1", "In review1", "Done2"])
  })

  it("draws no group that has no work", () => {
    const { page } = show([work("plain")])
    expect(listed(page)).toEqual([["In progress", ["plain"]]])
  })

  it("folds Done, and keeps it folded the next time", () => {
    const { page } = show([work("plain"), clean("merged", { merged: true })])
    const fold = page.container.querySelector<HTMLButtonElement>(".worktrees-group-fold")!
    expect(fold.getAttribute("aria-expanded")).toBe("true")
    act(() => fold.click())
    expect(fold.getAttribute("aria-expanded")).toBe("false")
    expect(listed(page)).toEqual([["In progress", ["plain"]]])
    const again = show([work("plain"), clean("merged", { merged: true })])
    expect(listed(again.page)).toEqual([["In progress", ["plain"]]])
  })

  it("trashes every safe row after one confirm, unforced, and leaves the rest", async () => {
    const { page, onCloseWork } = show([
      clean("merged", { firstSeenAt: 3, merged: true, safe: true }),
      work("closed", { firstSeenAt: 2, pullRequest: pull("closed"), safe: true }),
      clean("held", { firstSeenAt: 1, merged: true, safe: false, uncommitted: 2 }),
    ])
    const sweep = page.container.querySelector<HTMLButtonElement>(".worktrees-sweep")!
    expect(sweep.textContent).toBe("Trash 2 safe")
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

describe("Trash N safe, while it works", () => {
  const sweep = (page: Rendered) =>
    page.container.querySelector<HTMLButtonElement>(".worktrees-sweep")

  it("leaves out a safe row whose agent is working in it", () => {
    const { page } = show([
      clean("a", { merged: true, safe: true }),
      clean("b", { merged: true, safe: true, working: true }),
    ])
    expect(sweep(page)?.textContent).toBe("Trash 1 safe")
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
        "Title t-a (feat/a), Title t-b (feat/b) stay: it holds 1 uncommitted or untracked path.",
      ),
    )
  })
})

describe("what a row says", () => {
  const pull = (state: "draft" | "open" | "merged" | "closed", extra = {}) => ({
    number: 812,
    url: "https://github.com/acme/app/pull/812",
    title: "Work",
    state,
    ...extra,
  })
  const facts = (row: HTMLElement) =>
    [...row.querySelectorAll<HTMLElement>(".worktrees-fact")].map((fact) => [
      fact.querySelector("[aria-hidden]:not(svg)")?.textContent,
      fact.dataset.tone,
    ])

  it("names its owner's handle before its branch", () => {
    const { row } = show([work("a")], { handles: new Map([["t-a", "@moth"]]) })
    expect(row("a").querySelector(".worktrees-handle")?.textContent).toBe("@moth")
    expect(row("a").querySelector(".worktrees-branch")?.textContent).toBe("feat/a")
  })

  it("says where it stands in words, red only for what needs the person", () => {
    const { row } = show([
      work("a", { base: "origin/main", conflicts: [{ with: "main" }], unpushed: 2 }),
      work("b", { pullRequest: pull("open", { ci: "failing" }) }),
      work("c", { pullRequest: pull("draft", { ci: "none" }), working: true }),
    ])
    expect(facts(row("a"))).toEqual([
      ["Conflicts with origin/main", "bad"],
      ["No PR yet", "muted"],
      ["2 commits not pushed", "warn"],
    ])
    expect(row("a").dataset.standing).toBe("conflict")
    expect(facts(row("b"))).toEqual([
      ["CI failing", "bad"],
      ["Ready for review", "ink"],
    ])
    expect(row("b").dataset.standing).toBe("ci-failing")
    expect(facts(row("c"))).toEqual([
      ["Working", "ink"],
      ["Draft", "muted"],
      ["no CI", "muted"],
    ])
    expect(row("c").dataset.standing).toBe("working")
    expect(row("c").dataset.terminalPhase).toBe("running")
  })

  it("says a done one is safe, or what it holds", () => {
    const { row } = show([
      clean("safe", { merged: true, safe: true }),
      clean("held", { merged: true, safe: false, uncommitted: 1 }),
    ])
    expect(facts(row("safe"))).toEqual([
      ["Merged", "ok"],
      ["safe to trash", "ok"],
    ])
    expect(row("safe").dataset.safe).toBe("true")
    expect(facts(row("held"))).toEqual([
      ["Merged", "muted"],
      ["1 file not committed", "warn"],
    ])
    expect(row("held").dataset.safe).toBeUndefined()
  })

  it("selects its row on a click on its words, as the row's button would", async () => {
    const { row, onSelect } = show([work("a")])
    act(() => row("a").querySelector<HTMLElement>(".worktrees-facts")!.click())
    await eventually(() => expect(onSelect).toHaveBeenCalledOnce())
  })

  it("says nothing of a pull request while no forge is on", () => {
    const { row } = show([work("a")], { forges: false })
    expect(facts(row("a"))).toEqual([])
  })

  it("names its facts in its accessible label", () => {
    const { row } = show([work("a", { pullRequest: pull("open", { ci: "passed" }) })], {
      handles: new Map([["t-a", "@moth"]]),
    })
    expect(row("a").querySelector(".sidebar-item-select")?.getAttribute("aria-label")).toBe(
      "Title t-a, @moth, feat/a, 1 file changed, 4 lines added, 1 removed, ready for review, CI passed",
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
