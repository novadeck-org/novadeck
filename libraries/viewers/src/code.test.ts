import "./code.css"
import { afterEach, describe, expect, it } from "vitest"

import { highlightLines, mountCode, type CodeContent } from "./code.js"
import type { Viewer } from "./index.js"

const numbered = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `const line${at + 1} = ${at + 1}`)

const panes: HTMLElement[] = []
afterEach(() => {
  for (const pane of panes.splice(0)) pane.remove()
})

// An element to mount into, sized so a long listing scrolls.
const paneIn = (document: Document = window.document): HTMLElement => {
  const pane = document.createElement("div")
  pane.style.cssText = "display: flex; flex-direction: column; height: 200px; width: 400px"
  document.body.append(pane)
  panes.push(pane)
  return pane
}

const listingOf = (pane: HTMLElement): HTMLElement => pane.querySelector(".code-viewer")!
const rowsOf = (pane: HTMLElement): HTMLElement[] => [...listingOf(pane).children] as HTMLElement[]

const mount = (content: CodeContent, pane = paneIn()): Viewer<CodeContent> =>
  mountCode(pane, { content, label: "src/app.ts" })

describe("the code viewer", () => {
  it("shows each line as plain text at once, numbered from the first line", () => {
    const pane = paneIn()
    mount({ lines: ["one", "two"], firstLine: 41, path: "notes.txt" }, pane)
    const listing = listingOf(pane)
    expect(listing.getAttribute("role")).toBe("region")
    expect(listing.getAttribute("aria-label")).toBe("src/app.ts")
    expect(rowsOf(pane).map((row) => row.textContent)).toEqual(["41one", "42two"])
  })

  it("highlights the lines once their language's parser loads, keeping their text", async () => {
    const pane = paneIn()
    const lines = ['{ "slug": "harbour-press" }']
    mount({ lines, firstLine: 1, path: "projects.json" }, pane)
    await expect.poll(() => pane.querySelector(".tok-propertyName")?.textContent).toBe('"slug"')
    expect(rowsOf(pane)[0]!.lastElementChild!.textContent).toBe(lines[0])
  })

  it("takes the language it's given over its file's", async () => {
    const pane = paneIn()
    mount({ lines: ["let x = 1"], firstLine: 1, path: "notes.txt", language: "typescript" }, pane)
    await expect.poll(() => pane.querySelector(".tok-keyword")?.textContent).toBe("let")
  })

  it("reads as plain text in a language it has no parser for", async () => {
    const pane = paneIn()
    const lines = ["let x = 1"]
    const viewer = mount({ lines, firstLine: 1, path: "a.ts" }, pane)
    await expect.poll(() => pane.querySelector(".tok-keyword")).not.toBeNull()
    viewer.update({ lines, firstLine: 1, path: "a.ts", language: "ruby" })
    await expect.poll(() => pane.querySelector(".tok-keyword")).toBeNull()
  })

  it("emphasizes the lines in its range, both ends included", () => {
    const pane = paneIn()
    mount({ lines: numbered(5), firstLine: 10, emphasis: { from: 11, to: 13 } }, pane)
    expect(rowsOf(pane).map((row) => row.hasAttribute("data-emphasized"))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ])
  })

  it("first shows its emphasized lines, when they start out of view", () => {
    const pane = paneIn()
    mount({ lines: numbered(300), firstLine: 1, emphasis: { from: 200, to: 202 } }, pane)
    const listing = listingOf(pane)
    const row = rowsOf(pane)[199]!
    expect(row.offsetTop).toBeGreaterThanOrEqual(listing.scrollTop)
    expect(row.offsetTop + row.offsetHeight).toBeLessThanOrEqual(
      listing.scrollTop + listing.clientHeight,
    )
  })

  it("shows its emphasized lines once it has a size, when it mounts out of sight", async () => {
    const pane = paneIn()
    pane.style.display = "none"
    mount({ lines: numbered(300), firstLine: 1, emphasis: { from: 200, to: 202 } }, pane)
    // Longer than a moment: a parked terminal stays out of sight for as long as it likes.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    pane.style.display = "flex"
    const row = rowsOf(pane)[199]!
    const listing = listingOf(pane)
    await expect.poll(() => listing.scrollTop).toBeGreaterThan(0)
    expect(row.offsetTop).toBeGreaterThan(listing.scrollTop)
    expect(row.offsetTop + row.offsetHeight).toBeLessThan(listing.scrollTop + listing.clientHeight)
  })

  it("stays at the top when its emphasized lines already show", () => {
    const pane = paneIn()
    mount({ lines: numbered(300), firstLine: 1, emphasis: { from: 2, to: 3 } }, pane)
    expect(listingOf(pane).scrollTop).toBe(0)
  })

  it("picks up where an earlier viewer was from its state", () => {
    const first = paneIn()
    const content = { lines: numbered(300), firstLine: 1 }
    const viewer = mount(content, first)
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()
    expect(first.children).toHaveLength(0)

    const second = paneIn()
    mountCode(second, { content, label: "src/app.ts", saved: state })
    expect(listingOf(second).scrollTop).toBe(1234)
  })

  it("puts its saved place back once it has a size, when restored out of sight", async () => {
    const first = paneIn()
    const content = { lines: numbered(300), firstLine: 1 }
    const viewer = mount(content, first)
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()

    const hidden = paneIn()
    hidden.style.display = "none"
    mountCode(hidden, { content, label: "src/app.ts", saved: state })
    hidden.style.display = "flex"
    await expect.poll(() => listingOf(hidden).scrollTop).toBe(1234)
  })

  it("leaves its place to the person once they scroll, while it settles", async () => {
    const first = paneIn()
    const content = { lines: numbered(300), firstLine: 1 }
    const viewer = mount(content, first)
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()

    const hidden = paneIn()
    hidden.style.display = "none"
    mountCode(hidden, { content, label: "src/app.ts", saved: state })
    listingOf(hidden).dispatchEvent(new WheelEvent("wheel"))
    hidden.style.display = "flex"
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(listingOf(hidden).scrollTop).toBe(0)
  })

  it("leaves its place to whatever scrolls it while it settles, before the scroll's event", async () => {
    const first = paneIn()
    const content = { lines: numbered(300), firstLine: 1 }
    const viewer = mount(content, first)
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()

    const pane = paneIn()
    mountCode(pane, { content, label: "src/app.ts", saved: state })
    // A scroll and a resize in an animation frame: the frame's resize observers run before
    // the scroll's event, which comes with the next frame.
    await new Promise((resolve) =>
      requestAnimationFrame(() => {
        listingOf(pane).scrollTop = 40
        pane.style.height = "250px"
        resolve(undefined)
      }),
    )
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(listingOf(pane).scrollTop).toBe(40)
  })

  it("takes no place from another file's state", () => {
    const first = paneIn()
    const viewer = mountCode(first, {
      content: { lines: numbered(300), firstLine: 1, path: "a.ts" },
      label: "a.ts",
    })
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()
    const other = paneIn()
    mountCode(other, {
      content: { lines: numbered(300), firstLine: 1, path: "b.ts" },
      label: "b.ts",
      saved: state,
    })
    expect(listingOf(other).scrollTop).toBe(0)
    // The same file picks up where it was.
    const same = paneIn()
    mountCode(same, {
      content: { lines: numbered(300), firstLine: 1, path: "a.ts" },
      label: "a.ts",
      saved: state,
    })
    expect(listingOf(same).scrollTop).toBe(1234)
  })

  it("jumps where it's asked, over a saved place still settling", async () => {
    const first = paneIn()
    const content = { lines: numbered(300), firstLine: 1 }
    const viewer = mount(content, first)
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()

    const hidden = paneIn()
    hidden.style.display = "none"
    const next = mountCode(hidden, { content, label: "src/app.ts", saved: state })
    hidden.style.display = "flex"
    await expect.poll(() => listingOf(hidden).scrollTop).toBe(1234)
    next.jumpTo({ line: 1 })
    hidden.style.height = "250px"
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(listingOf(hidden).scrollTop).toBe(0)
  })

  it("prefers its saved place to its emphasized lines", () => {
    const pane = paneIn()
    const content = { lines: numbered(300), firstLine: 1, emphasis: { from: 200, to: 202 } }
    const viewer = mount(content, pane)
    listingOf(pane).scrollTop = 0
    const state = viewer.state()
    viewer.destroy()
    mountCode(pane, { content, label: "src/app.ts", saved: state })
    expect(listingOf(pane).scrollTop).toBe(0)
  })

  it("keeps its place and its rows when only the emphasis changes, to lines in view", () => {
    const pane = paneIn()
    const lines = numbered(300)
    const viewer = mount({ lines, firstLine: 1 }, pane)
    listingOf(pane).scrollTop = 500
    const before = rowsOf(pane)
    const inView = before.findIndex((row) => row.offsetTop > 520)
    viewer.update({
      lines: [...lines],
      firstLine: 1,
      emphasis: { from: inView + 1, to: inView + 1 },
    })
    expect(rowsOf(pane)[inView]).toBe(before[inView])
    expect(before[inView]!.hasAttribute("data-emphasized")).toBe(true)
    expect(listingOf(pane).scrollTop).toBe(500)
  })

  it("shows other lines emphasized, as when its agent points elsewhere in the file", () => {
    const pane = paneIn()
    const lines = numbered(300)
    const viewer = mount({ lines, firstLine: 1, emphasis: { from: 2, to: 3 } }, pane)
    expect(listingOf(pane).scrollTop).toBe(0)
    viewer.update({ lines, firstLine: 1, emphasis: { from: 250, to: 251 } })
    const row = rowsOf(pane)[249]!
    const listing = listingOf(pane)
    expect(row.offsetTop).toBeGreaterThan(listing.scrollTop)
    expect(row.offsetTop + row.offsetHeight).toBeLessThan(listing.scrollTop + listing.clientHeight)
  })

  it("stays where the person scrolled when the same lines come again, emphasis and all", () => {
    const pane = paneIn()
    const content = { lines: numbered(300), firstLine: 1, emphasis: { from: 2, to: 3 } }
    const viewer = mount(content, pane)
    listingOf(pane).scrollTop = 3000
    viewer.update({ ...content, lines: [...content.lines], emphasis: { from: 2, to: 3 } })
    expect(listingOf(pane).scrollTop).toBe(3000)
  })

  it("still shows its emphasized lines once it has a size, though updated out of sight", async () => {
    const pane = paneIn()
    pane.style.display = "none"
    const content = { lines: numbered(300), firstLine: 1, emphasis: { from: 200, to: 202 } }
    const viewer = mount(content, pane)
    viewer.update({ ...content, lines: [...content.lines] })
    pane.style.display = "flex"
    await expect.poll(() => listingOf(pane).scrollTop).toBeGreaterThan(0)
  })

  it("still picks up its saved place once it has a size, though its lines change out of sight", async () => {
    const first = paneIn()
    const viewer = mount({ lines: numbered(300), firstLine: 1 }, first)
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()

    const hidden = paneIn()
    hidden.style.display = "none"
    const next = mountCode(hidden, {
      content: { lines: numbered(300), firstLine: 1 },
      label: "src/app.ts",
      saved: state,
    })
    next.update({ lines: numbered(310), firstLine: 1 })
    hidden.style.display = "flex"
    await expect.poll(() => listingOf(hidden).scrollTop).toBe(1234)
  })

  it("keeps its place when the lines change", () => {
    const pane = paneIn()
    const viewer = mount({ lines: numbered(300), firstLine: 1 }, pane)
    listingOf(pane).scrollTop = 500
    viewer.update({ lines: numbered(310), firstLine: 1 })
    expect(rowsOf(pane)).toHaveLength(310)
    expect(listingOf(pane).scrollTop).toBe(500)
  })

  it("jumps to a line by its number, or by an offset into the text", () => {
    const pane = paneIn()
    const lines = numbered(300)
    const viewer = mount({ lines, firstLine: 101 }, pane)
    const listing = listingOf(pane)
    const showing = (index: number) => {
      const row = rowsOf(pane)[index]!
      return (
        row.offsetTop >= listing.scrollTop &&
        row.offsetTop + row.offsetHeight <= listing.scrollTop + listing.clientHeight
      )
    }
    viewer.jumpTo({ line: 350 })
    expect(showing(249)).toBe(true)
    viewer.jumpTo({ offset: 0 })
    expect(listing.scrollTop).toBe(0)
    const offset = lines.slice(0, 150).join("\n").length + 1
    viewer.jumpTo({ offset })
    expect(showing(150)).toBe(true)
  })

  it("lands a jump made out of sight once it has a size", async () => {
    const pane = paneIn()
    pane.style.display = "none"
    const viewer = mount({ lines: numbered(300), firstLine: 1 }, pane)
    viewer.jumpTo({ line: 250 })
    pane.style.display = "flex"
    const row = rowsOf(pane)[249]!
    const listing = listingOf(pane)
    await expect.poll(() => listing.scrollTop).toBeGreaterThan(0)
    expect(row.offsetTop + row.offsetHeight).toBeLessThan(listing.scrollTop + listing.clientHeight)
  })

  it("takes focus without scrolling", () => {
    const pane = paneIn()
    const viewer = mount({ lines: numbered(3), firstLine: 1 }, pane)
    viewer.focus()
    expect(document.activeElement).toBe(listingOf(pane))
  })

  it("paints nothing once destroyed, though its highlighting finishes after", async () => {
    const pane = paneIn()
    // Text no other test highlights, so none of it is highlighted already.
    const viewer = mount({ lines: ["let late = 1"], firstLine: 1, path: "late.ts" }, pane)
    const listing = listingOf(pane)
    viewer.destroy()
    // Another listing in the same language, mounted after, is highlighted by then.
    const other = paneIn()
    mount({ lines: ["let y = 2"], firstLine: 1, path: "other.ts" }, other)
    await expect.poll(() => other.querySelector(".tok-keyword")).not.toBeNull()
    expect(listing.isConnected).toBe(false)
    expect(listing.querySelector("[class^=tok-]")).toBeNull()
  })

  it("paints only the latest lines' highlighting, whichever finishes first", async () => {
    const pane = paneIn()
    const viewer = mount({ lines: ["let x = 1"], firstLine: 1, path: "first.ts" }, pane)
    viewer.update({ lines: ['{ "a": 1 }'], firstLine: 1, path: "second.json" })
    await expect.poll(() => pane.querySelector(".tok-propertyName")).not.toBeNull()
    // Past the first listing's highlighting too.
    await highlightLines("typescript", ["let x = 1"])
    expect(rowsOf(pane)[0]!.lastElementChild!.textContent).toBe('{ "a": 1 }')
    expect(pane.querySelector(".tok-keyword")).toBeNull()
  })

  it("goes back to plain text for the same lines in a language it doesn't highlight", async () => {
    const pane = paneIn()
    const lines = ["let x = 1"]
    const viewer = mount({ lines, firstLine: 1, path: "a.ts" }, pane)
    await expect.poll(() => pane.querySelector(".tok-keyword")).not.toBeNull()
    viewer.update({ lines, firstLine: 1, path: "a.txt" })
    expect(pane.querySelector(".tok-keyword")).toBeNull()
    expect(rowsOf(pane)[0]!.textContent).toBe("1let x = 1")
  })

  it("builds in the document its element belongs to", () => {
    const frame = document.createElement("iframe")
    document.body.append(frame)
    panes.push(frame)
    const inner = frame.contentDocument!
    const pane = paneIn(inner)
    mount({ lines: ["one"], firstLine: 1 }, pane)
    expect(listingOf(pane).ownerDocument).toBe(inner)
  })
})
