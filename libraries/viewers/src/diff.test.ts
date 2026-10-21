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

// The text of the line at the top of the viewer, without its numbers.
const topText = (root: HTMLElement): string => {
  const base = root.getBoundingClientRect().top
  return (
    [...root.querySelectorAll(".diff-line")]
      .find((row) => row.getBoundingClientRect().bottom > base + 1)
      ?.querySelector(".diff-text")?.textContent ?? ""
  )
}

// Many files of different sizes, alternating long and short; `edits` replace some by index.
const many = (edits: Record<number, DiffFile> = {}): DiffFile[] =>
  Array.from({ length: 60 }, (_, at) => edits[at] ?? sized(`f${at}.txt`, at % 2 === 0 ? 80 : 2))

// A file of `count` lines like `sized`, with `extra` lines of its own at `at`.
const withLines = (path: string, count: number, extra: number, at: number): DiffFile => {
  const base = sized(path, count).hunks[0]!.lines
  const lines = [
    ...base.slice(0, at),
    ...Array.from({ length: extra }, (_, each) => ({
      kind: "add" as const,
      text: `${path} new ${each}`,
    })),
    ...base.slice(at),
  ]
  return file(path, { hunks: [hunkOf(1, lines)] })
}

// A file like `sized`, from which the first `drop` lines are gone.
const withoutFirst = (path: string, count: number, drop: number): DiffFile =>
  file(path, { hunks: [hunkOf(drop + 1, sized(path, count).hunks[0]!.lines.slice(drop))] })

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

  context("with two files of one path", () => {
    it("shows and highlights both, and keeps them apart across an update", async () => {
      const one = file("a.json", { hunks: [hunkOf(1, [{ kind: "add", text: '{ "one": 1 }' }])] })
      const two = file("a.json", { hunks: [hunkOf(1, [{ kind: "add", text: '{ "two": 2 }' }])] })
      const { host, viewer } = mount(change([one, two]))
      await expect.poll(() => host.querySelectorAll(".tok-propertyName").length).toBe(2)
      viewer.update(change([one, two, sized("b.txt", 2)]))
      expect(
        [...host.querySelectorAll(".tok-propertyName")].map((each) => each.textContent),
      ).toEqual(['"one"', '"two"'])
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

    it("is a tab stop only for a file whose lines overflow, to scroll it by keyboard", async () => {
      const { root } = mount(wide())
      const [long, short] = scrollers(root)
      await expect.poll(() => long.getAttribute("tabindex")).toBe("0")
      expect(short.hasAttribute("tabindex")).toBe(false)
    })

    it("pins each line's marker with its numbers", async () => {
      const added = file("a.txt", {
        hunks: [hunkOf(1, [{ kind: "add", text: "y".repeat(500) }])],
      })
      const { root } = mount(change([added]))
      await frame()
      const mark = root.querySelectorAll<HTMLElement>(".diff-number")[1]!
      expect(getComputedStyle(mark, "::after").content).toBe('"+"')
      const before = mark.getBoundingClientRect().left
      root.querySelector<HTMLElement>(".diff-lines")!.scrollLeft = 300
      await frame()
      expect(mark.getBoundingClientRect().left).toBe(before)
    })
  })

  context("keeping its place", () => {
    const rowHeight = (root: HTMLElement): number => {
      const [one, two] = root.querySelectorAll(".diff-line")
      return two!.getBoundingClientRect().top - one!.getBoundingClientRect().top
    }

    // Around line 34 of file f16, among files of 80 and 2 lines.
    const reading = async (content = change(many())) => {
      const shown = mount(content)
      await frame()
      shown.host.querySelectorAll<HTMLButtonElement>(".diff-file-link")[16]!.click()
      await expect.poll(() => topRow(shown.root)).toContain("f16.txt line 1")
      shown.root.scrollTop += 33 * rowHeight(shown.root)
      await frame()
      await frame()
      return { ...shown, row: topRow(shown.root) }
    }

    it("is where it was in a new viewer for the same change, among files of other sizes", async () => {
      const first = await reading()
      expect(first.row).toContain("f16.txt line 3")
      const state = first.viewer.state()
      first.viewer.destroy()
      const host = hostIn()
      mountDiff(host, { content: change(many()), label: "Changes", saved: state })
      const root = host.querySelector<HTMLElement>(".diff-viewer")!
      await expect.poll(() => topRow(root)).toBe(first.row)
    })

    it("stays at the row when files above and below change, and the file read grows or shrinks", async () => {
      const first = await reading()
      const versions: DiffFile[] = [
        sized("f16.txt", 120),
        sized("f16.txt", 50),
        withLines("f16.txt", 80, 5, 60),
      ]
      for (const read of versions) {
        first.viewer.update(
          change(many({ 3: sized("f3.txt", 90), 16: read, 40: sized("f40.txt", 10) })),
        )
        // eslint-disable-next-line no-await-in-loop -- Each update settles before the next.
        await frame()
        // eslint-disable-next-line no-await-in-loop -- Each update settles before the next.
        await frame()
        expect(topRow(first.root)).toBe(first.row)
      }
    })

    it("keeps the same line on top when lines come or go above it in the file read", async () => {
      const first = await reading()
      const line = topText(first.root)
      expect(line).toContain("f16.txt line 3")
      for (const read of [
        withLines("f16.txt", 80, 10, 10),
        withoutFirst("f16.txt", 80, 12),
        withLines("f16.txt", 80, 3, 0),
      ]) {
        first.viewer.update(change(many({ 16: read })))
        // eslint-disable-next-line no-await-in-loop -- Each update settles before the next.
        await frame()
        // eslint-disable-next-line no-await-in-loop -- Each update settles before the next.
        await frame()
        expect(topText(first.root)).toBe(line)
      }
    })

    it("keeps the same line on top when lines are committed above it", async () => {
      const first = await reading()
      const line = topText(first.root)
      for (const committed of [1, 20]) {
        // Lines above went into HEAD: the old numbers move up, the new ones stay.
        const kept = sized("f16.txt", 80).hunks[0]!
        const hunk = { ...kept, oldStart: 1 + committed }
        first.viewer.update(change(many({ 16: file("f16.txt", { hunks: [hunk] }) })))
        // eslint-disable-next-line no-await-in-loop -- Each update settles before the next.
        await frame()
        // eslint-disable-next-line no-await-in-loop -- Each update settles before the next.
        await frame()
        expect(topText(first.root)).toBe(line)
      }
    })

    it("goes to the top of the file that takes the place of the one read, when it is gone", async () => {
      const first = await reading()
      const without = (gone: number) => many().filter((_, at) => at !== gone)
      first.viewer.update(change(without(16)))
      await frame()
      await frame()
      // The next file in order, whose top is on show.
      expect(topRow(first.root)).toContain("f17.txt")
      first.viewer.update(change(many()))
      await frame()
      // None after it now: the one before.
      first.viewer.update(change(many().slice(0, 17)))
      await frame()
      await frame()
      expect(topRow(first.root)).toContain("f16.txt")
    })

    it("starts a file at the left again when it comes back by the same path", async () => {
      const wide = sized("a.txt", 40, ` ${"x".repeat(400)}`)
      const first = mount(change([wide, sized("b.txt", 5)]))
      await frame()
      first.root.querySelector<HTMLElement>(".diff-lines")!.scrollLeft = 200
      await frame()
      first.viewer.update(change([sized("b.txt", 5)]))
      first.viewer.update(change([wide, sized("b.txt", 5)]))
      await frame()
      await frame()
      expect(first.root.querySelector<HTMLElement>(".diff-lines")!.scrollLeft).toBe(0)
    })

    it("is kept by an update while the viewer has no size, the file read changing", async () => {
      const first = await reading()
      // The scroll event that records where it is comes a frame later.
      await frame()
      first.host.style.display = "none"
      first.viewer.update(change(many({ 16: sized("f16.txt", 120), 2: sized("f2.txt", 70) })))
      first.viewer.update(change(many({ 16: sized("f16.txt", 130), 2: sized("f2.txt", 70) })))
      first.host.style.display = "flex"
      await expect.poll(() => topRow(first.root)).toBe(first.row)
      await frame()
      await frame()
      expect(topRow(first.root)).toBe(first.row)
    })

    it("raises no window error when it is hidden, updated and shown", async () => {
      const errors: string[] = []
      const listener = (event: ErrorEvent): void => void errors.push(event.message)
      window.addEventListener("error", listener, true)
      const big = (path: string, version: number): DiffFile =>
        file(path, {
          hunks: [
            hunkOf(
              1,
              Array.from({ length: 300 }, (_, at) => ({
                kind: at % 5 ? ("context" as const) : ("add" as const),
                text: `line ${at} ${version} ${"x".repeat(200)}`,
              })),
            ),
          ],
        })
      try {
        for (let round = 0; round < 4; round += 1) {
          const files = [big("a.txt", 0), big("b.txt", 0), big("c.txt", 0)]
          const { host, root, viewer } = mount(change(files))
          // eslint-disable-next-line no-await-in-loop -- Each round is its own viewer.
          await frame()
          root.scrollTop = 1000
          root.querySelector<HTMLElement>(".diff-lines")!.scrollLeft = 300
          // eslint-disable-next-line no-await-in-loop -- Each round is its own viewer.
          await new Promise((resolve) => setTimeout(resolve, 100))
          for (const changed of [false, true]) {
            host.style.display = "none"
            // eslint-disable-next-line no-await-in-loop -- Each step settles before the next.
            await frame()
            viewer.update(
              change([changed ? big("a.txt", 7) : files[0]!, big("b.txt", round + 1), files[2]!]),
            )
            // eslint-disable-next-line no-await-in-loop -- Each step settles before the next.
            await frame()
            host.style.display = "flex"
            // eslint-disable-next-line no-await-in-loop -- Each step settles before the next.
            await new Promise((resolve) => setTimeout(resolve, 1200))
          }
          viewer.destroy()
        }
        expect(errors.filter((message) => message.includes("ResizeObserver"))).toEqual([])
      } finally {
        window.removeEventListener("error", listener, true)
      }
    }, 60_000)

    it("keeps each file's sideways scroll, by its path, across updates, hiding and a new viewer", async () => {
      const wide = () => [
        sized("a.txt", 40, ` ${"x".repeat(400)}`),
        sized("b.txt", 40),
        sized("a.txt", 40, ` ${"y".repeat(400)}`),
      ]
      const first = mount(change(wide()))
      await frame()
      const [one, , other] = first.root.querySelectorAll<HTMLElement>(".diff-lines")
      one!.scrollLeft = 200
      other!.scrollLeft = 120
      await frame()
      first.host.style.display = "none"
      first.viewer.update(change([...wide(), sized("c.txt", 3)]))
      const state = first.viewer.state()
      first.host.style.display = "flex"
      await expect
        .poll(() =>
          [...first.root.querySelectorAll<HTMLElement>(".diff-lines")].map(
            (each) => each.scrollLeft,
          ),
        )
        .toEqual([200, 0, 120, 0])
      first.viewer.destroy()
      const host = hostIn()
      mountDiff(host, { content: change(wide()), label: "Changes", saved: state })
      const root = host.querySelector<HTMLElement>(".diff-viewer")!
      // A file's sideways scroll is put back as it comes into view.
      await expect.poll(() => root.querySelector<HTMLElement>(".diff-lines")!.scrollLeft).toBe(200)
      root.scrollTop = root.scrollHeight
      await expect
        .poll(() =>
          [...root.querySelectorAll<HTMLElement>(".diff-lines")].map((each) => each.scrollLeft),
        )
        .toEqual([200, 0, 120])
    })
  })

  context("with many files", () => {
    it("updates and reports its place without laying out the files out of sight", async () => {
      const files = Array.from({ length: 100 }, (_, at) => sized(`f${at}.txt`, 1_000))
      const { host, viewer } = mount(change(files))
      await expect
        .poll(() => host.querySelectorAll(".diff-line").length, { timeout: 30_000 })
        .toBe(100_000)
      await frame()
      host.querySelector<HTMLElement>(".diff-viewer")!.scrollTop = 50_000
      await frame()
      const measured = performance.now()
      viewer.state()
      const state = performance.now() - measured
      const next = [...files]
      next[70] = sized("f70.txt", 1_001)
      const updated = performance.now()
      viewer.update(change(next))
      const update = performance.now() - updated
      // Laying out every file took seconds here (1.3–9.5 s); the bounds catch that with room
      // for a slow shared CI machine, where this takes 60–160 ms.
      expect(state).toBeLessThan(500)
      expect(update).toBeLessThan(750)
      viewer.destroy()
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
