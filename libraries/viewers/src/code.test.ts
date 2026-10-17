import "./code.css"
import { afterEach, describe, expect, it } from "vitest"

import { highlightLines, mountCode, type CodeContent } from "./code.js"
import type { Viewer } from "./index.js"

const numbered = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `const line${at + 1} = ${at + 1}`)

const hosts: HTMLElement[] = []
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove()
})

// An element to mount into, sized so a long listing scrolls.
const hostIn = (document: Document = window.document): HTMLElement => {
  const host = document.createElement("div")
  host.style.cssText = "display: flex; flex-direction: column; height: 200px; width: 400px"
  document.body.append(host)
  hosts.push(host)
  return host
}

const listingOf = (host: HTMLElement): HTMLElement => host.querySelector(".code-viewer")!
const rowsOf = (host: HTMLElement): HTMLElement[] => [...listingOf(host).children] as HTMLElement[]

const mount = (content: CodeContent, host = hostIn()): Viewer<CodeContent> =>
  mountCode(host, { content, label: "src/app.ts" })

describe("the code viewer", () => {
  it("shows each line as plain text at once, numbered from the first line", () => {
    const host = hostIn()
    mount({ lines: ["one", "two"], firstLine: 41, path: "notes.txt" }, host)
    const listing = listingOf(host)
    expect(listing.getAttribute("role")).toBe("region")
    expect(listing.getAttribute("aria-label")).toBe("src/app.ts")
    expect(rowsOf(host).map((row) => row.textContent)).toEqual(["41one", "42two"])
  })

  it("highlights the lines once their language's parser loads, keeping their text", async () => {
    const host = hostIn()
    const lines = ['{ "slug": "harbour-press" }']
    mount({ lines, firstLine: 1, path: "projects.json" }, host)
    await expect.poll(() => host.querySelector(".tok-propertyName")?.textContent).toBe('"slug"')
    expect(rowsOf(host)[0]!.lastElementChild!.textContent).toBe(lines[0])
  })

  it("takes the language it's given over its file's", async () => {
    const host = hostIn()
    mount({ lines: ["let x = 1"], firstLine: 1, path: "notes.txt", language: "typescript" }, host)
    await expect.poll(() => host.querySelector(".tok-keyword")?.textContent).toBe("let")
  })

  it("reads as plain text in a language it has no parser for", async () => {
    const host = hostIn()
    const lines = ["let x = 1"]
    const viewer = mount({ lines, firstLine: 1, path: "a.ts" }, host)
    await expect.poll(() => host.querySelector(".tok-keyword")).not.toBeNull()
    viewer.update({ lines, firstLine: 1, path: "a.ts", language: "ruby" })
    await expect.poll(() => host.querySelector(".tok-keyword")).toBeNull()
  })

  it("emphasizes the lines in its range, both ends included", () => {
    const host = hostIn()
    mount({ lines: numbered(5), firstLine: 10, emphasis: { from: 11, to: 13 } }, host)
    expect(rowsOf(host).map((row) => row.hasAttribute("data-emphasized"))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ])
  })

  it("first shows its emphasized lines, when they start out of view", () => {
    const host = hostIn()
    mount({ lines: numbered(300), firstLine: 1, emphasis: { from: 200, to: 202 } }, host)
    const listing = listingOf(host)
    const row = rowsOf(host)[199]!
    expect(row.offsetTop).toBeGreaterThanOrEqual(listing.scrollTop)
    expect(row.offsetTop + row.offsetHeight).toBeLessThanOrEqual(
      listing.scrollTop + listing.clientHeight,
    )
  })

  it("shows its emphasized lines once it has a size, when it mounts out of sight", async () => {
    const host = hostIn()
    host.style.display = "none"
    mount({ lines: numbered(300), firstLine: 1, emphasis: { from: 200, to: 202 } }, host)
    // Longer than a moment: a parked terminal stays out of sight for as long as it likes.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    host.style.display = "flex"
    const row = rowsOf(host)[199]!
    const listing = listingOf(host)
    await expect.poll(() => listing.scrollTop).toBeGreaterThan(0)
    expect(row.offsetTop).toBeGreaterThan(listing.scrollTop)
    expect(row.offsetTop + row.offsetHeight).toBeLessThan(listing.scrollTop + listing.clientHeight)
  })

  it("stays at the top when its emphasized lines already show", () => {
    const host = hostIn()
    mount({ lines: numbered(300), firstLine: 1, emphasis: { from: 2, to: 3 } }, host)
    expect(listingOf(host).scrollTop).toBe(0)
  })

  it("picks up where an earlier viewer was from its state", () => {
    const first = hostIn()
    const content = { lines: numbered(300), firstLine: 1 }
    const viewer = mount(content, first)
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()
    expect(first.children).toHaveLength(0)

    const second = hostIn()
    mountCode(second, { content, label: "src/app.ts", saved: state })
    expect(listingOf(second).scrollTop).toBe(1234)
  })

  it("puts its saved place back once it has a size, when restored out of sight", async () => {
    const first = hostIn()
    const content = { lines: numbered(300), firstLine: 1 }
    const viewer = mount(content, first)
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()

    const hidden = hostIn()
    hidden.style.display = "none"
    mountCode(hidden, { content, label: "src/app.ts", saved: state })
    hidden.style.display = "flex"
    await expect.poll(() => listingOf(hidden).scrollTop).toBe(1234)
  })

  it("leaves its place to the person once they scroll, while it settles", async () => {
    const first = hostIn()
    const content = { lines: numbered(300), firstLine: 1 }
    const viewer = mount(content, first)
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()

    const hidden = hostIn()
    hidden.style.display = "none"
    mountCode(hidden, { content, label: "src/app.ts", saved: state })
    listingOf(hidden).dispatchEvent(new WheelEvent("wheel"))
    hidden.style.display = "flex"
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(listingOf(hidden).scrollTop).toBe(0)
  })

  it("leaves its place to whatever scrolls it while it settles, before the scroll's event", async () => {
    const first = hostIn()
    const content = { lines: numbered(300), firstLine: 1 }
    const viewer = mount(content, first)
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()

    const host = hostIn()
    mountCode(host, { content, label: "src/app.ts", saved: state })
    // A scroll and a resize in an animation frame: the frame's resize observers run before
    // the scroll's event, which comes with the next frame.
    await new Promise((resolve) =>
      requestAnimationFrame(() => {
        listingOf(host).scrollTop = 40
        host.style.height = "250px"
        resolve(undefined)
      }),
    )
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(listingOf(host).scrollTop).toBe(40)
  })

  it("takes no place from another file's state", () => {
    const first = hostIn()
    const viewer = mountCode(first, {
      content: { lines: numbered(300), firstLine: 1, path: "a.ts" },
      label: "a.ts",
    })
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()
    const other = hostIn()
    mountCode(other, {
      content: { lines: numbered(300), firstLine: 1, path: "b.ts" },
      label: "b.ts",
      saved: state,
    })
    expect(listingOf(other).scrollTop).toBe(0)
    // The same file picks up where it was.
    const same = hostIn()
    mountCode(same, {
      content: { lines: numbered(300), firstLine: 1, path: "a.ts" },
      label: "a.ts",
      saved: state,
    })
    expect(listingOf(same).scrollTop).toBe(1234)
  })

  it("jumps where it's asked, over a saved place still settling", async () => {
    const first = hostIn()
    const content = { lines: numbered(300), firstLine: 1 }
    const viewer = mount(content, first)
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()

    const hidden = hostIn()
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
    const host = hostIn()
    const content = { lines: numbered(300), firstLine: 1, emphasis: { from: 200, to: 202 } }
    const viewer = mount(content, host)
    listingOf(host).scrollTop = 0
    const state = viewer.state()
    viewer.destroy()
    mountCode(host, { content, label: "src/app.ts", saved: state })
    expect(listingOf(host).scrollTop).toBe(0)
  })

  it("keeps its place and its rows when only the emphasis changes, to lines in view", () => {
    const host = hostIn()
    const lines = numbered(300)
    const viewer = mount({ lines, firstLine: 1 }, host)
    listingOf(host).scrollTop = 500
    const before = rowsOf(host)
    const inView = before.findIndex((row) => row.offsetTop > 520)
    viewer.update({
      lines: [...lines],
      firstLine: 1,
      emphasis: { from: inView + 1, to: inView + 1 },
    })
    expect(rowsOf(host)[inView]).toBe(before[inView])
    expect(before[inView]!.hasAttribute("data-emphasized")).toBe(true)
    expect(listingOf(host).scrollTop).toBe(500)
  })

  it("shows other lines emphasized, as when its agent points elsewhere in the file", () => {
    const host = hostIn()
    const lines = numbered(300)
    const viewer = mount({ lines, firstLine: 1, emphasis: { from: 2, to: 3 } }, host)
    expect(listingOf(host).scrollTop).toBe(0)
    viewer.update({ lines, firstLine: 1, emphasis: { from: 250, to: 251 } })
    const row = rowsOf(host)[249]!
    const listing = listingOf(host)
    expect(row.offsetTop).toBeGreaterThan(listing.scrollTop)
    expect(row.offsetTop + row.offsetHeight).toBeLessThan(listing.scrollTop + listing.clientHeight)
  })

  it("stays where the person scrolled when the same lines come again, emphasis and all", () => {
    const host = hostIn()
    const content = { lines: numbered(300), firstLine: 1, emphasis: { from: 2, to: 3 } }
    const viewer = mount(content, host)
    listingOf(host).scrollTop = 3000
    viewer.update({ ...content, lines: [...content.lines], emphasis: { from: 2, to: 3 } })
    expect(listingOf(host).scrollTop).toBe(3000)
  })

  it("still shows its emphasized lines once it has a size, though updated out of sight", async () => {
    const host = hostIn()
    host.style.display = "none"
    const content = { lines: numbered(300), firstLine: 1, emphasis: { from: 200, to: 202 } }
    const viewer = mount(content, host)
    viewer.update({ ...content, lines: [...content.lines] })
    host.style.display = "flex"
    await expect.poll(() => listingOf(host).scrollTop).toBeGreaterThan(0)
  })

  it("still picks up its saved place once it has a size, though its lines change out of sight", async () => {
    const first = hostIn()
    const viewer = mount({ lines: numbered(300), firstLine: 1 }, first)
    listingOf(first).scrollTop = 1234
    const state = viewer.state()
    viewer.destroy()

    const hidden = hostIn()
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
    const host = hostIn()
    const viewer = mount({ lines: numbered(300), firstLine: 1 }, host)
    listingOf(host).scrollTop = 500
    viewer.update({ lines: numbered(310), firstLine: 1 })
    expect(rowsOf(host)).toHaveLength(310)
    expect(listingOf(host).scrollTop).toBe(500)
  })

  it("jumps to a line by its number, or by an offset into the text", () => {
    const host = hostIn()
    const lines = numbered(300)
    const viewer = mount({ lines, firstLine: 101 }, host)
    const listing = listingOf(host)
    const showing = (index: number) => {
      const row = rowsOf(host)[index]!
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
    const host = hostIn()
    host.style.display = "none"
    const viewer = mount({ lines: numbered(300), firstLine: 1 }, host)
    viewer.jumpTo({ line: 250 })
    host.style.display = "flex"
    const row = rowsOf(host)[249]!
    const listing = listingOf(host)
    await expect.poll(() => listing.scrollTop).toBeGreaterThan(0)
    expect(row.offsetTop + row.offsetHeight).toBeLessThan(listing.scrollTop + listing.clientHeight)
  })

  it("takes focus without scrolling", () => {
    const host = hostIn()
    const viewer = mount({ lines: numbered(3), firstLine: 1 }, host)
    viewer.focus()
    expect(document.activeElement).toBe(listingOf(host))
  })

  it("paints nothing once destroyed, though its highlighting finishes after", async () => {
    const host = hostIn()
    // Text no other test highlights, so none of it is highlighted already.
    const viewer = mount({ lines: ["let late = 1"], firstLine: 1, path: "late.ts" }, host)
    const listing = listingOf(host)
    viewer.destroy()
    // Another listing in the same language, mounted after, is highlighted by then.
    const other = hostIn()
    mount({ lines: ["let y = 2"], firstLine: 1, path: "other.ts" }, other)
    await expect.poll(() => other.querySelector(".tok-keyword")).not.toBeNull()
    expect(listing.isConnected).toBe(false)
    expect(listing.querySelector("[class^=tok-]")).toBeNull()
  })

  it("paints only the latest lines' highlighting, whichever finishes first", async () => {
    const host = hostIn()
    const viewer = mount({ lines: ["let x = 1"], firstLine: 1, path: "first.ts" }, host)
    viewer.update({ lines: ['{ "a": 1 }'], firstLine: 1, path: "second.json" })
    await expect.poll(() => host.querySelector(".tok-propertyName")).not.toBeNull()
    // Past the first listing's highlighting too.
    await highlightLines("typescript", ["let x = 1"])
    expect(rowsOf(host)[0]!.lastElementChild!.textContent).toBe('{ "a": 1 }')
    expect(host.querySelector(".tok-keyword")).toBeNull()
  })

  it("goes back to plain text for the same lines in a language it doesn't highlight", async () => {
    const host = hostIn()
    const lines = ["let x = 1"]
    const viewer = mount({ lines, firstLine: 1, path: "a.ts" }, host)
    await expect.poll(() => host.querySelector(".tok-keyword")).not.toBeNull()
    viewer.update({ lines, firstLine: 1, path: "a.txt" })
    expect(host.querySelector(".tok-keyword")).toBeNull()
    expect(rowsOf(host)[0]!.textContent).toBe("1let x = 1")
  })

  it("builds in the document its element belongs to", () => {
    const frame = document.createElement("iframe")
    document.body.append(frame)
    hosts.push(frame)
    const inner = frame.contentDocument!
    const host = hostIn(inner)
    mount({ lines: ["one"], firstLine: 1 }, host)
    expect(listingOf(host).ownerDocument).toBe(inner)
  })
})
