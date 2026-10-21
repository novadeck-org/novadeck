import "./code.css"
import "./diff.css"
import { afterEach, describe, expect, it } from "vitest"

import { mountDiff, type DiffContent, type DiffFile, type DiffHunk } from "./diff.js"

const context = describe

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

const frame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

const hunkOf = (start: number, lines: DiffHunk["lines"]): DiffHunk => ({
  oldStart: start,
  oldCount: lines.filter((line) => line.kind !== "add").length,
  newStart: start,
  newCount: lines.filter((line) => line.kind !== "remove").length,
  lines,
})

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

// A file of `count` kept lines, each saying which file and line it is.
const sized = (path: string, count: number, text = ""): DiffFile =>
  file(path, {
    hunks: [
      hunkOf(
        1,
        Array.from({ length: count }, (_, at) => ({
          kind: "context" as const,
          text: `${path} line ${at + 1}${text}`,
        })),
      ),
    ],
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

const mount = (content: DiffContent, host = hostIn()) => {
  const viewer = mountDiff(host, { content, label: "Changes" })
  return { host, viewer, root: host.querySelector<HTMLElement>(".diff-viewer")! }
}

const numbers = (host: HTMLElement): string[][] =>
  [...host.querySelectorAll(".diff-line")].map((row) =>
    [...row.querySelectorAll(".diff-number")].map((each) => each.textContent!),
  )

// The text of the first row showing at the top of the viewer.
const topRow = (root: HTMLElement): string => {
  const base = root.getBoundingClientRect().top
  return (
    [...root.querySelectorAll(".diff-line")]
      .find((row) => row.getBoundingClientRect().bottom > base + 1)
      ?.textContent?.trim() ?? ""
  )
}

// Many files of different sizes, alternating long and short.
const many = (changed = ""): DiffFile[] =>
  Array.from({ length: 60 }, (_, at) =>
    sized(`f${at}.txt`, at % 2 === 0 ? 80 : 2, at === 59 ? changed : ""),
  )

describe("the diff viewer", () => {
  context("what it shows", () => {
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

    it("sizes the number gutters to the largest number", () => {
      const small = mount(change([edited]))
      const large = mount(
        change([file("big.txt", { hunks: [hunkOf(999_990, [{ kind: "context", text: "x" }])] })]),
      )
      expect(small.root.style.getPropertyValue("--diff-digits")).toBe("2")
      expect(large.root.style.getPropertyValue("--diff-digits")).toBe("6")
      expect(
        large.host.querySelector<HTMLElement>(".diff-number")!.getBoundingClientRect().width,
      ).toBeGreaterThan(
        small.host.querySelector<HTMLElement>(".diff-number")!.getBoundingClientRect().width,
      )
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
      expect(renamed!.querySelector(".diff-note")!.textContent).toBe("Renamed, no changes in it.")
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
  })

  context("the list of files", () => {
    it("names each file with what it changed, and scrolls only the viewer to it", async () => {
      const { host, root } = mount(change(many()))
      const outer = document.createElement("div")
      outer.style.cssText = "height: 100px; overflow: auto"
      outer.append(host)
      document.body.append(outer)
      hosts.push(outer)
      const links = host.querySelectorAll<HTMLButtonElement>(".diff-file-link")
      expect(links).toHaveLength(60)
      expect(links[3]!.getAttribute("aria-label")).toBe("f3.txt, 0 added, 0 removed")
      await frame()
      links[30]!.click()
      await expect.poll(() => root.scrollTop).toBeGreaterThan(0)
      expect(outer.scrollTop).toBe(0)
      await expect.poll(() => topRow(root)).toContain("f30.txt")
    })
  })

  context("with highlighting", () => {
    const json = (text: string) => file("a.json", { hunks: [hunkOf(1, [{ kind: "add", text }])] })

    it("colours a file by its language once the parser loads, keeping its text", async () => {
      const { host } = mount(change([json('{ "slug": 1 }')]))
      await expect.poll(() => host.querySelector(".tok-propertyName")?.textContent).toBe('"slug"')
      expect(host.querySelector(".diff-text")!.textContent).toBe('{ "slug": 1 }')
    })

    it("parses the old and the new side apart", async () => {
      const lines: DiffHunk["lines"] = [
        { kind: "remove", text: 'const a = "open' },
        { kind: "add", text: "const a = 1" },
        { kind: "context", text: "const b = 2" },
      ]
      const { host } = mount(
        change([
          file("a.ts", { hunks: [{ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines }] }),
        ]),
      )
      await expect.poll(() => host.querySelectorAll(".tok-keyword").length).toBeGreaterThan(0)
      // The string opened by the removed line doesn't swallow the added line's number.
      await expect
        .poll(() => host.querySelectorAll('.diff-line[data-kind="add"] .tok-number').length)
        .toBe(1)
    })

    it("keeps the colours of the files that didn't change, as a new change arrives", async () => {
      const content = change([json('{ "slug": 1 }'), sized("plain.txt", 3)])
      const { host, viewer } = mount(content)
      await expect.poll(() => host.querySelector(".tok-propertyName")?.textContent).toBe('"slug"')
      viewer.update(change([json('{ "slug": 1 }'), sized("plain.txt", 4)]))
      // At once: its rows were kept, not drawn plain and parsed again.
      expect(host.querySelector(".tok-propertyName")?.textContent).toBe('"slug"')
      expect(host.querySelectorAll(".diff-file")[1]!.querySelectorAll(".diff-line")).toHaveLength(4)
    })

    it("shows a hunk highlighted at once when a new viewer has seen it", async () => {
      const content = change([json('{ "kept": 1 }')])
      const first = mount(content)
      await expect.poll(() => first.host.querySelector(".tok-propertyName")).not.toBeNull()
      first.viewer.destroy()
      const second = mount(content)
      await expect.poll(() => second.host.querySelector(".tok-propertyName")).not.toBeNull()
    })
  })

  context("with lines wider than the viewer", () => {
    const wide = (): DiffContent =>
      change([sized("long.txt", 40, ` ${"x".repeat(400)}`), sized("short.txt", 40)])

    const scrollers = (root: HTMLElement) =>
      [...root.querySelectorAll<HTMLElement>(".diff-lines")] as [HTMLElement, HTMLElement]

    it("scrolls the file's own lines sideways, not the viewer", async () => {
      const { root } = mount(wide())
      await frame()
      const [long, short] = scrollers(root)
      expect(long.scrollWidth).toBeGreaterThan(long.clientWidth + 300)
      expect(root.scrollWidth).toBe(root.clientWidth)
      long.scrollLeft = 10_000
      expect(long.scrollLeft).toBeGreaterThan(300)
      // A file whose lines fit is as it was.
      expect(short.scrollWidth).toBe(short.clientWidth)
      expect(short.scrollLeft).toBe(0)
      root.scrollLeft = 100
      expect(root.scrollLeft).toBe(0)
    })

    it("keeps the line numbers, the headers and the list of files where they are", async () => {
      const { root } = mount(wide())
      await frame()
      const place = () =>
        Object.fromEntries(
          [".diff-files", ".diff-file-head", ".diff-hunk-head", ".diff-number"].map((selector) => {
            const rect = root.querySelector(selector)!.getBoundingClientRect()
            return [selector, [Math.round(rect.left) + 0, Math.round(rect.width)]]
          }),
        )
      const before = place()
      const [long] = scrollers(root)
      long.scrollLeft = 10_000
      await frame()
      expect(place()).toEqual(before)
      // The text slid under the numbers, which show on the ground of the lines.
      const text = root.querySelector<HTMLElement>(".diff-text")!
      expect(text.getBoundingClientRect().left).toBeLessThan(
        before[".diff-number"]![0]! + before[".diff-number"]![1]!,
      )
    })

    it("tints an added line all the way across the file's widest line", async () => {
      const long = file("a.txt", {
        hunks: [
          hunkOf(1, [
            { kind: "add", text: "y".repeat(500) },
            { kind: "add", text: "short" },
          ]),
        ],
      })
      const { root } = mount(change([long]))
      await frame()
      const [first, second] = [...root.querySelectorAll<HTMLElement>(".diff-line")]
      expect(second!.getBoundingClientRect().width).toBe(first!.getBoundingClientRect().width)
      expect(first!.getBoundingClientRect().width).toBeGreaterThan(root.clientWidth)
    })

    it("can be focused to scroll it by keyboard", () => {
      const { root } = mount(wide())
      const [long] = scrollers(root)
      expect(long.tabIndex).toBe(0)
    })
  })

  context("keeping its place", () => {
    // At line 4 of file f16, among files of 80 and 2 lines.
    const scrolled = async (content = change(many())) => {
      const shown = mount(content)
      await frame()
      const link = shown.host.querySelectorAll<HTMLButtonElement>(".diff-file-link")[16]!
      link.click()
      await expect.poll(() => topRow(shown.root)).toContain("f16.txt line 1")
      shown.root.scrollTop += 3 * 22
      await frame()
      return { ...shown, row: topRow(shown.root) }
    }

    it("is where it was in a new viewer for the same change, among files of other sizes", async () => {
      const first = await scrolled()
      expect(first.row).toContain("f16.txt")
      const state = first.viewer.state()
      first.viewer.destroy()
      const host = hostIn()
      mountDiff(host, { content: change(many()), label: "Changes", saved: state })
      const root = host.querySelector<HTMLElement>(".diff-viewer")!
      await expect.poll(() => topRow(root)).toBe(first.row)
    })

    it("stays at the same file and row when the change is updated, a later file changing", async () => {
      const first = await scrolled()
      first.viewer.update(change(many(" changed")))
      await frame()
      expect(topRow(first.root)).toBe(first.row)
      first.viewer.update(change(many(" changed again")))
      await frame()
      expect(topRow(first.root)).toBe(first.row)
    })

    it("is kept by an update while the viewer has no size", async () => {
      const first = await scrolled()
      // The scroll event that records where it is comes a frame later.
      await frame()
      first.host.style.display = "none"
      first.viewer.update(change(many(" changed")))
      first.host.style.display = "flex"
      await expect.poll(() => topRow(first.root)).toBe(first.row)
    })

    it("keeps each file's sideways scroll, by its path", async () => {
      const content = change([sized("a.txt", 40, ` ${"x".repeat(400)}`), sized("b.txt", 40)])
      const first = mount(content)
      await frame()
      const scroller = first.root.querySelector<HTMLElement>(".diff-lines")!
      scroller.scrollLeft = 200
      const state = first.viewer.state()
      // An update keeps it too.
      first.viewer.update(change([sized("a.txt", 40, ` ${"x".repeat(400)}`), sized("b.txt", 41)]))
      await frame()
      expect(scroller.scrollLeft).toBe(200)
      first.viewer.destroy()
      const host = hostIn()
      mountDiff(host, { content, label: "Changes", saved: state })
      const root = host.querySelector<HTMLElement>(".diff-viewer")!
      await expect.poll(() => root.querySelector<HTMLElement>(".diff-lines")!.scrollLeft).toBe(200)
    })
  })

  context("with a long change", () => {
    const long = (): DiffFile => {
      const lines = Array.from({ length: 20_000 }, (_, at) => ({
        kind: (at % 3 === 0 ? "add" : "context") as "add" | "context",
        text: `const value${at} = ${at}`,
      }))
      return file("big.ts", {
        added: 6667,
        hunks: Array.from({ length: 200 }, (_, at) =>
          hunkOf(at * 100 + 1, lines.slice(at * 100, at * 100 + 100)),
        ),
      })
    }

    it("draws a part at a time, without blocking the page", async () => {
      const started = performance.now()
      const { host, viewer } = mount(change([long()]))
      expect(performance.now() - started).toBeLessThan(1000)
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
      const { root, viewer } = mount(change([long()]))
      viewer.destroy()
      const drawn = root.querySelectorAll(".diff-line").length
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(root.querySelectorAll(".diff-line").length).toBe(drawn)
      expect(drawn).toBeLessThan(20_000)
    })

    it("carries on drawing a file it kept when the change is updated", async () => {
      const { host, viewer } = mount(change([long()]))
      viewer.update(change([long(), sized("small.txt", 3)]))
      await expect
        .poll(() => host.querySelectorAll(".diff-line").length, { timeout: 15_000 })
        .toBe(20_003)
      viewer.destroy()
    })
  })
})
