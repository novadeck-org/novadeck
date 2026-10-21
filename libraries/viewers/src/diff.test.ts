import "./code.css"
import "./diff.css"
import { afterEach, describe, expect, it } from "vitest"

import { mountDiff, type DiffContent, type DiffFile } from "./diff.js"

const hosts: HTMLElement[] = []
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove()
})

const hostIn = (): HTMLElement => {
  const host = document.createElement("div")
  host.style.cssText = "display: flex; flex-direction: column; height: 300px; width: 600px"
  document.body.append(host)
  hosts.push(host)
  return host
}

const file = (path: string, rest: Partial<DiffFile> = {}): DiffFile => ({
  path,
  oldPath: null,
  status: "modified",
  added: 0,
  removed: 0,
  binary: false,
  held: false,
  listed: false,
  hunks: [],
  ...rest,
})

const change = (files: DiffFile[], rest: Partial<DiffContent> = {}): DiffContent => ({
  base: "HEAD",
  files,
  truncated: false,
  ...rest,
})

const edited = file("notes.txt", {
  added: 2,
  removed: 1,
  hunks: [
    {
      oldStart: 3,
      oldCount: 3,
      newStart: 3,
      newCount: 4,
      lines: [
        { kind: "context", text: "keep" },
        { kind: "remove", text: "old" },
        { kind: "add", text: "new" },
        { kind: "add", text: "newer" },
        { kind: "context", text: "end" },
      ],
    },
    {
      oldStart: 40,
      oldCount: 1,
      newStart: 41,
      newCount: 1,
      lines: [{ kind: "context", text: "later" }],
    },
  ],
})

const frame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

const mount = (content: DiffContent, host = hostIn()) => {
  const viewer = mountDiff(host, { content, label: "Changes" })
  return { host, viewer, root: host.querySelector<HTMLElement>(".diff-viewer")! }
}

const numbers = (host: HTMLElement): string[][] =>
  [...host.querySelectorAll(".diff-line")].map((row) =>
    [...row.querySelectorAll(".diff-number")].map((each) => each.textContent!),
  )

describe("the diff viewer", () => {
  it("shows each file as a section under its header, with its hunks", () => {
    const { host, root } = mount(change([edited, file("a.txt", { status: "added", added: 1 })]))
    expect(root.getAttribute("role")).toBe("region")
    expect(root.getAttribute("aria-label")).toBe("Changes")
    const sections = [...host.querySelectorAll(".diff-file")]
    expect(sections).toHaveLength(2)
    const head = sections[0]!.querySelector(".diff-file-head")!
    expect(head.querySelector(".diff-new-path")!.textContent).toBe("notes.txt")
    expect(head.querySelector(".diff-status")!.textContent).toBe("Modified")
    expect(head.querySelector(".diff-added")!.textContent).toBe("+2")
    expect(head.querySelector(".diff-removed")!.textContent).toBe("−1")
    expect(
      [...sections[0]!.querySelectorAll(".diff-hunk-head")].map((each) => each.textContent),
    ).toEqual(["@@ -3,3 +3,4 @@", "@@ -40,1 +41,1 @@"])
    expect(sections[1]!.getAttribute("data-status")).toBe("added")
  })

  it("numbers the old and new lines from each hunk's start, by kind", () => {
    const { host } = mount(change([edited]))
    expect(numbers(host)).toEqual([
      ["3", "3"],
      ["4", ""],
      ["", "4"],
      ["", "5"],
      ["5", "6"],
      ["40", "41"],
    ])
    expect(
      [...host.querySelectorAll(".diff-line")].map((row) => row.getAttribute("data-kind")),
    ).toEqual(["context", "remove", "add", "add", "context", "context"])
    expect(host.querySelectorAll(".diff-text")[1]!.textContent).toBe("old")
  })

  it("says where a renamed file came from, and how each file changed", () => {
    const { host } = mount(
      change([
        file("new.ts", { status: "renamed", oldPath: "old.ts" }),
        file("gone.ts", { status: "deleted", removed: 3 }),
      ]),
    )
    const [renamed, deleted] = [...host.querySelectorAll(".diff-file")]
    expect(renamed!.querySelector(".diff-old-path")!.textContent).toBe("old.ts")
    expect(renamed!.querySelector(".diff-status")!.textContent).toBe("Renamed")
    expect(deleted!.querySelector(".diff-status")!.textContent).toBe("Deleted")
    expect(deleted!.querySelector(".diff-old-path")).toBeNull()
  })

  it("shows only the header and a note for a binary, held or listed file", () => {
    const { host } = mount(
      change([
        file("logo.png", { binary: true }),
        file(".env", { held: true }),
        file("big.sql", { listed: true }),
      ]),
    )
    const notes = [...host.querySelectorAll(".diff-file")].map(
      (each) => each.querySelector(".diff-note")!.textContent,
    )
    expect(notes).toEqual([
      "Binary file — not shown.",
      "May hold secrets — not shown.",
      "Past this change's size, listed by name.",
    ])
    expect(host.querySelector(".diff-line")).toBeNull()
  })

  it("says so when nothing changed, and when the change is larger than shown", () => {
    expect(mount(change([])).root.textContent).toBe("No changes against HEAD")
    const { root } = mount(change([edited], { truncated: true }))
    expect(root.querySelector(".diff-truncated")!.textContent).toBe(
      "This change is larger than shown.",
    )
  })

  it("lists the files at the top, each scrolling to its section", () => {
    const files = Array.from({ length: 40 }, (_, at) =>
      file(`f${at}.txt`, {
        hunks: [
          {
            oldStart: 1,
            oldCount: 20,
            newStart: 1,
            newCount: 20,
            lines: Array.from({ length: 20 }, () => ({ kind: "context" as const, text: "x" })),
          },
        ],
      }),
    )
    const { host, root } = mount(change(files))
    const links = host.querySelectorAll<HTMLButtonElement>(".diff-file-link")
    expect(links).toHaveLength(40)
    links[30]!.click()
    expect(root.scrollTop).toBeGreaterThan(0)
  })

  it("highlights a file by its language once the parser loads, keeping its text", async () => {
    const ts = file("a.json", {
      hunks: [
        {
          oldStart: 1,
          oldCount: 1,
          newStart: 1,
          newCount: 1,
          lines: [{ kind: "add", text: '{ "slug": 1 }' }],
        },
      ],
    })
    const { host } = mount(change([ts]))
    await expect.poll(() => host.querySelector(".tok-propertyName")?.textContent).toBe('"slug"')
    expect(host.querySelector(".diff-text")!.textContent).toBe('{ "slug": 1 }')
  })

  it("keeps its scroll across a new viewer for the same change, and an update", async () => {
    const lines = Array.from({ length: 300 }, (_, at) => ({
      kind: "context" as const,
      text: `line ${at}`,
    }))
    const hunk = { oldStart: 1, oldCount: 300, newStart: 1, newCount: 300, lines }
    const content = change([file("a.txt", { hunks: [hunk] })])
    const first = mount(content)
    // The page works out what is on screen at its next frame, before which it can't scroll far.
    await frame()
    first.root.scrollTop = 500
    expect(first.root.scrollTop).toBe(500)
    const state = first.viewer.state()
    first.viewer.destroy()
    expect(first.host.children).toHaveLength(0)
    const host = hostIn()
    mountDiff(host, { content, label: "Changes", saved: state })
    const restored = host.querySelector<HTMLElement>(".diff-viewer")!
    await expect.poll(() => restored.scrollTop).toBe(500)
    first.viewer.destroy()
    const second = mount(content)
    await frame()
    second.root.scrollTop = 300
    second.viewer.update({ ...content, files: [...content.files] })
    await frame()
    expect(second.root.scrollTop).toBe(300)
  })

  it("draws a long change a part at a time, without blocking the page", async () => {
    const lines = Array.from({ length: 20_000 }, (_, at) => ({
      kind: (at % 3 === 0 ? "add" : "context") as "add" | "context",
      text: `const value${at} = ${at}`,
    }))
    const hunks = Array.from({ length: 200 }, (_, at) => ({
      oldStart: at * 100 + 1,
      oldCount: 100,
      newStart: at * 100 + 1,
      newCount: 100,
      lines: lines.slice(at * 100, at * 100 + 100),
    }))
    const started = performance.now()
    const { host, viewer } = mount(change([file("big.ts", { hunks, added: 6667 })]))
    const first = performance.now() - started
    // The first part is there at once, and the rest follows while the page stays alive.
    expect(first).toBeLessThan(1000)
    expect(host.querySelectorAll(".diff-line").length).toBeLessThan(20_000)
    let ticks = 0
    const timer = setInterval(() => (ticks += 1), 5)
    await expect
      .poll(() => host.querySelectorAll(".diff-line").length, { timeout: 15_000 })
      .toBe(20_000)
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(0)
    viewer.destroy()
  })

  it("stops drawing when it is destroyed", async () => {
    const lines = Array.from({ length: 5_000 }, () => ({ kind: "context" as const, text: "x" }))
    const hunk = { oldStart: 1, oldCount: 5000, newStart: 1, newCount: 5000, lines }
    const { host, viewer } = mount(
      change([file("a.txt", { hunks: [hunk, hunk, hunk, hunk, hunk, hunk] })]),
    )
    viewer.destroy()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(host.querySelector(".diff-viewer")).toBeNull()
  })
})
