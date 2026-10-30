import "./markdown.css"
import { undo } from "@codemirror/commands"
import { EditorView } from "@codemirror/view"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Viewer, ViewerState } from "./index.js"
import { mountMarkdown, type ClassedRange, type MarkdownContent } from "./markdown.js"
import planV1 from "./markdown/fixtures/plan-v1.md?raw"
import planV2 from "./markdown/fixtures/plan-v2.md?raw"

const panes: HTMLElement[] = []
const viewers: Viewer<MarkdownContent>[] = []
afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy()
  for (const pane of panes.splice(0)) pane.remove()
})

// A scroller to mount into, as an app's pane is: it scrolls, the viewer doesn't.
const paneIn = (): HTMLElement => {
  const pane = document.createElement("div")
  pane.style.cssText = "height: 300px; width: 600px; overflow: auto"
  document.body.append(pane)
  panes.push(pane)
  return pane
}

type Edit = { text: string; ranges: readonly ClassedRange[] }

const mount = (
  content: MarkdownContent,
  {
    pane = paneIn(),
    editable = true,
    saved,
  }: { pane?: HTMLElement; editable?: boolean; saved?: ViewerState } = {},
) => {
  const edits: Edit[] = []
  const viewer = mountMarkdown(pane, {
    content,
    label: "Notes",
    editable,
    ...(saved === undefined ? {} : { saved }),
    onEdit: (text, ranges) => edits.push({ text, ranges }),
  })
  viewers.push(viewer)
  const view = EditorView.findFromDOM(pane.querySelector<HTMLElement>(".cm-editor")!)!
  return { viewer, pane, view, edits }
}

const type = (view: EditorView, insert: string, at = 0): void =>
  view.dispatch({ changes: { from: at, insert }, userEvent: "input.type" })

describe("the markdown viewer", () => {
  it("shows the text as a document, under its name", () => {
    const { pane } = mount({ text: "# Title\n\nSome **bold** text\n" })
    expect(pane.querySelector(".cm-content")!.getAttribute("aria-label")).toBe("Notes")
    expect(pane.querySelector(".cm-md-h1")).not.toBeNull()
    expect(pane.querySelector(".cm-md-strong")!.textContent).toBe("bold")
  })

  it("keeps the person's place and history when the text changes outside", () => {
    const { viewer, view, edits } = mount({ text: planV1 })
    type(view, "Mine. ")
    view.dispatch({ selection: { anchor: 8 } })
    viewer.update({ text: "Mine. " + planV2 })
    expect(view.state.doc.toString()).toBe("Mine. " + planV2)
    expect(view.state.selection.main.head).toBe(8)
    // The outside change isn't theirs to undo; their own typing still is.
    undo(view)
    expect(view.state.doc.toString()).toBe(planV2)
    expect(edits.map((edit) => edit.text).at(-1)).toBe(planV2)
  })

  it("reports only the person's edits, never update()'s", () => {
    const { viewer, view, edits } = mount({ text: "one\n" })
    viewer.update({ text: "one\ntwo\n" })
    expect(edits).toEqual([])
    type(view, "zero\n")
    expect(edits.map((edit) => edit.text)).toEqual(["zero\none\ntwo\n"])
  })

  it("moves ranges along with the person's edits and reports them", () => {
    const text = "one\ntwo\nthree\n"
    const { pane, view, edits } = mount({
      text,
      ranges: [{ from: 4, to: 7, className: "marked" }],
    })
    expect([...pane.querySelectorAll(".marked")].map((line) => line.textContent)).toEqual(["two"])
    type(view, "zero\n")
    expect(edits[0]!.ranges).toEqual([{ from: 9, to: 12, className: "marked" }])
  })

  it("is read-only until switched, without a remount", () => {
    const { viewer, pane, view, edits } = mount({ text: "one\n" }, { editable: false })
    const editor = pane.querySelector(".cm-editor")
    type(view, "x")
    expect(view.state.doc.toString()).toBe("one\n")
    expect(edits).toEqual([])
    // The outside's changes still land.
    viewer.update({ text: "two\n" })
    expect(view.state.doc.toString()).toBe("two\n")

    viewer.editable(true)
    type(view, "x")
    expect(view.state.doc.toString()).toBe("xtwo\n")
    viewer.editable(false)
    type(view, "y")
    expect(view.state.doc.toString()).toBe("xtwo\n")
    expect(pane.querySelector(".cm-editor")).toBe(editor)
  })

  it("draws a table's fields to follow whether it takes edits", () => {
    const { viewer, pane } = mount(
      { text: "| a | b |\n| - | - |\n| c | d |\n" },
      { editable: false },
    )
    const readOnly = (): boolean => pane.querySelector<HTMLTextAreaElement>(".cm-md-cell")!.readOnly
    expect(readOnly()).toBe(true)
    viewer.editable(true)
    expect(readOnly()).toBe(false)
  })

  it("opens a saved state with its undo history, taking the new viewer's behaviour", () => {
    const first = mount({ text: "one\n" })
    type(first.view, "typed ")
    const saved = first.viewer.state()
    first.viewer.destroy()
    viewers.splice(viewers.indexOf(first.viewer), 1)

    const second = mount({ text: "typed one\n" }, { saved, editable: false })
    expect(second.view.state.doc.toString()).toBe("typed one\n")
    undo(second.view)
    // Read-only now: the history is there, but the filter holds.
    expect(second.view.state.doc.toString()).toBe("typed one\n")
    second.viewer.editable(true)
    undo(second.view)
    expect(second.view.state.doc.toString()).toBe("one\n")
    // The saved viewer's edits don't reach the old callback, but the new one.
    type(second.view, "again ")
    expect(second.edits.at(-1)!.text).toBe("again one\n")
    expect(first.edits.map((edit) => edit.text)).toEqual(["typed one\n"])
  })

  it("restores a state on a live viewer, keeping the content it has", () => {
    const first = mount({ text: "one\n" })
    type(first.view, "typed ")
    first.view.dispatch({ selection: { anchor: 3 } })
    const saved = first.viewer.state()

    // Meanwhile the app's text moved on: the saved edit is still in it, with more.
    const live = mount({ text: "typed one\nmore\n" })
    live.viewer.restore(saved)
    expect(live.view.state.doc.toString()).toBe("typed one\nmore\n")
    expect(live.view.state.selection.main.head).toBe(3)
    // Nothing was the person's edit.
    expect(live.edits).toEqual([])
    undo(live.view)
    expect(live.view.state.doc.toString()).toBe("one\nmore\n")
  })

  it("restores a state whose edits the content no longer has, as an outside change", () => {
    const first = mount({ text: "one\n" })
    type(first.view, "typed ")
    const saved = first.viewer.state()

    const live = mount({ text: "other\n" })
    live.viewer.restore(saved)
    expect(live.view.state.doc.toString()).toBe("other\n")
    expect(live.edits).toEqual([])
    // Its history held an edit the text doesn't have; undoing must not damage what does.
    undo(live.view)
    expect(live.view.state.doc.toString()).toBe("other\n")
  })

  it("applies what changed outside while it was away, outside the history", () => {
    const first = mount({ text: "one\n" })
    const saved = first.viewer.state()
    first.viewer.destroy()
    viewers.splice(viewers.indexOf(first.viewer), 1)
    const second = mount({ text: "one\ntwo\n" }, { saved })
    expect(second.view.state.doc.toString()).toBe("one\ntwo\n")
    expect(second.edits).toEqual([])
  })

  it("restores its scroll with its state", async () => {
    const text = Array.from({ length: 200 }, (_, at) => `Line ${at + 1}`).join("\n\n")
    const first = mount({ text })
    await expect.poll(() => first.pane.scrollHeight).toBeGreaterThan(first.pane.clientHeight + 500)
    first.pane.dispatchEvent(new WheelEvent("wheel"))
    first.pane.scrollTop = 1200
    await expect.poll(() => first.pane.scrollTop).toBe(1200)
    // The viewer notes where it is as the scroller scrolls.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const saved = first.viewer.state()
    first.viewer.destroy()
    viewers.splice(viewers.indexOf(first.viewer), 1)
    first.pane.remove()

    const second = mount({ text }, { saved })
    await expect.poll(() => Math.abs(second.pane.scrollTop - 1200)).toBeLessThan(30)
  })

  it("jumps to an offset or a line", async () => {
    const text = Array.from({ length: 120 }, (_, at) => `Line ${at + 1}`).join("\n\n")
    const { viewer, pane } = mount({ text })
    await expect.poll(() => pane.scrollHeight).toBeGreaterThan(pane.clientHeight + 500)
    viewer.jumpTo({ offset: text.indexOf("Line 100") })
    await expect.poll(() => pane.scrollTop, { timeout: 4000 }).toBeGreaterThan(1000)
    const there = pane.scrollTop
    viewer.jumpTo({ line: 1 })
    await expect.poll(() => pane.scrollTop, { timeout: 4000 }).toBeLessThan(there / 2)
  })

  it("jumps smoothly where motion isn't reduced, landing on its line", async () => {
    // The tests run with reduced motion, which jumps at once; a person who hasn't asked for
    // it gets the smooth scroll and its correction once it ends.
    const real = window.matchMedia.bind(window)
    vi.stubGlobal("matchMedia", (query: string) =>
      query.includes("prefers-reduced-motion") ? { matches: false, media: query } : real(query),
    )
    try {
      const text = Array.from({ length: 120 }, (_, at) => `Line ${at + 1}`).join("\n\n")
      const { viewer, pane } = mount({ text })
      await expect.poll(() => pane.scrollHeight).toBeGreaterThan(pane.clientHeight + 500)
      viewer.jumpTo({ offset: text.indexOf("Line 100") })
      await expect.poll(() => pane.scrollTop).toBeGreaterThan(1000)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("draws a quote's bar clear of its text, in a list too, its wrapped rows included", () => {
    const long = "words that run on ".repeat(6)
    const { pane } = mount({
      text: [
        `> On top, ${long}`,
        "",
        "- [ ] A task",
        "  - Its prompt:",
        "",
        `    > Under both, ${long}`,
        `    > and ${long}`,
        "    lazily too.",
        "",
        "- a",
        "  - b",
        "    - c",
        "",
        `      > Deep, ${long}`,
        "",
        `- > On the item's own line, ${long}`,
        "",
        "> A list in a quote:",
        `> - an item, ${long}`,
        "",
      ].join("\n"),
    })
    const quotes = [...pane.querySelectorAll<HTMLElement>(".cm-md-quote")]
    expect(quotes).toHaveLength(8)
    // Where the bar is drawn: the line's border, or its own mark beside the text.
    const barEnd = (line: HTMLElement): number => {
      const left = line.getBoundingClientRect().left
      const bar = getComputedStyle(line, "::before")
      if (bar.content !== "none") return left + parseFloat(bar.left) + parseFloat(bar.width)
      return left + parseFloat(getComputedStyle(line).borderLeftWidth)
    }
    for (const quote of quotes) {
      const text = document.createRange()
      text.selectNodeContents(quote)
      const rows = [...text.getClientRects()].filter((row) => row.width > 0)
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) expect(row.left).toBeGreaterThanOrEqual(barEnd(quote) + 8)
    }
    // A quote that wraps does so under its text.
    const wrapped = quotes[1]!
    expect(wrapped.getBoundingClientRect().height).toBeGreaterThan(40)
    // A list in a quote keeps the quote's bar where its other lines have it.
    const [intro, item] = quotes.slice(-2).map(barEnd)
    expect(item).toBe(intro)
  })

  it("draws a code block in a list at the item's hang, its rows and wrapped rows inside it", () => {
    const long = "words that run on ".repeat(8)
    const { pane } = mount({
      text: [
        "- [ ] A task, its prompt:",
        "",
        "  ```",
        `  ${long}`,
        `    ${long}`,
        "  ```",
        "",
        "- An item:",
        "",
        "  ```",
        `  ${long}`,
        "  ```",
        "",
        "```",
        `${long}`,
        "```",
        "",
      ].join("\n"),
    })
    const lines = [...pane.querySelectorAll<HTMLElement>(".cm-md-codeblock:not(.cm-md-fence)")]
    expect(lines).toHaveLength(4)
    const rowsOf = (line: HTMLElement): DOMRect[] => {
      const text = document.createRange()
      text.selectNodeContents(line)
      return [...text.getClientRects()].filter((row) => row.width > 0)
    }
    // Where the box is drawn: past the hang in a list, the whole line elsewhere.
    const boxStart = (line: HTMLElement): number =>
      line.getBoundingClientRect().left +
      (line.classList.contains("cm-md-codeblock-listed")
        ? parseFloat(getComputedStyle(line).getPropertyValue("--_hang"))
        : 0)
    const [task, indented, item, top] = lines.map((line) => ({
      box: boxStart(line),
      rows: rowsOf(line).map((row) => row.left),
    }))
    for (const { box, rows } of [task!, indented!, item!, top!]) {
      // Each one wraps, every row inside the box and under the first.
      expect(rows.length).toBeGreaterThan(1)
      for (const row of rows) expect(row).toBeGreaterThanOrEqual(box + 8)
      expect(new Set(rows.map(Math.round)).size).toBe(1)
    }
    // The nesting indent is hidden; the code's own indent stays.
    expect(item!.rows[0]).toBe(top!.rows[0]! + 22)
    expect(task!.rows[0]).toBe(top!.rows[0]! + 44)
    expect(lines.map((line) => /^ */.exec(line.textContent!)![0].length)).toEqual([0, 2, 0, 0])
  })

  it("takes everything it added out of its element", () => {
    const { viewer, pane } = mount({ text: "one\n" })
    viewer.destroy()
    viewers.pop()
    expect(pane.children).toHaveLength(0)
  })
})
