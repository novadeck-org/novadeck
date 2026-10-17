import "./markdown.css"
import { undo } from "@codemirror/commands"
import { EditorView } from "@codemirror/view"
import { afterEach, describe, expect, it } from "vitest"

import type { Viewer, ViewerState } from "./index.js"
import { mountMarkdown, type ClassedRange, type MarkdownContent } from "./markdown.js"
import planV1 from "./markdown/fixtures/plan-v1.md?raw"
import planV2 from "./markdown/fixtures/plan-v2.md?raw"
import { outline } from "./text.js"

const hosts: HTMLElement[] = []
const viewers: Viewer<MarkdownContent>[] = []
afterEach(() => {
  for (const viewer of viewers.splice(0)) viewer.destroy()
  for (const host of hosts.splice(0)) host.remove()
})

// A scroller to mount into, as a host's pane is: it scrolls, the viewer doesn't.
const hostIn = (): HTMLElement => {
  const host = document.createElement("div")
  host.style.cssText = "height: 300px; width: 600px; overflow: auto"
  document.body.append(host)
  hosts.push(host)
  return host
}

type Edit = { text: string; ranges: readonly ClassedRange[] }

const mount = (
  content: MarkdownContent,
  {
    host = hostIn(),
    editable = true,
    saved,
  }: { host?: HTMLElement; editable?: boolean; saved?: ViewerState } = {},
) => {
  const edits: Edit[] = []
  const viewer = mountMarkdown(host, {
    content,
    label: "Notes",
    editable,
    ...(saved === undefined ? {} : { saved }),
    onEdit: (text, ranges) => edits.push({ text, ranges }),
  })
  viewers.push(viewer)
  const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!
  return { viewer, host, view, edits }
}

const type = (view: EditorView, insert: string, at = 0): void =>
  view.dispatch({ changes: { from: at, insert }, userEvent: "input.type" })

describe("the markdown viewer", () => {
  it("shows the text as a document, under its name", () => {
    const { host } = mount({ text: "# Title\n\nSome **bold** text\n" })
    expect(host.querySelector(".cm-content")!.getAttribute("aria-label")).toBe("Notes")
    expect(host.querySelector(".cm-md-h1")).not.toBeNull()
    expect(host.querySelector(".cm-md-strong")!.textContent).toBe("bold")
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
    const { host, view, edits } = mount({
      text,
      ranges: [{ from: 4, to: 7, className: "marked" }],
    })
    expect([...host.querySelectorAll(".marked")].map((line) => line.textContent)).toEqual(["two"])
    type(view, "zero\n")
    expect(edits[0]!.ranges).toEqual([{ from: 9, to: 12, className: "marked" }])
  })

  it("is read-only until switched, without a remount", () => {
    const { viewer, host, view, edits } = mount({ text: "one\n" }, { editable: false })
    const editor = host.querySelector(".cm-editor")
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
    expect(host.querySelector(".cm-editor")).toBe(editor)
  })

  it("draws a table's fields to follow whether it takes edits", () => {
    const { viewer, host } = mount(
      { text: "| a | b |\n| - | - |\n| c | d |\n" },
      { editable: false },
    )
    const readOnly = (): boolean => host.querySelector<HTMLTextAreaElement>(".cm-md-cell")!.readOnly
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

    // Meanwhile the host's text moved on: the saved edit is still in it, with more.
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
    await expect.poll(() => first.host.scrollHeight).toBeGreaterThan(first.host.clientHeight + 500)
    first.host.dispatchEvent(new WheelEvent("wheel"))
    first.host.scrollTop = 1200
    await expect.poll(() => first.host.scrollTop).toBe(1200)
    // The viewer notes where it is as the scroller scrolls.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const saved = first.viewer.state()
    first.viewer.destroy()
    viewers.splice(viewers.indexOf(first.viewer), 1)
    first.host.remove()

    const second = mount({ text }, { saved })
    await expect.poll(() => Math.abs(second.host.scrollTop - 1200)).toBeLessThan(30)
  })

  it("jumps to an offset or a line", async () => {
    const text = Array.from({ length: 120 }, (_, at) => `Line ${at + 1}`).join("\n\n")
    const { viewer, host } = mount({ text })
    await expect.poll(() => host.scrollHeight).toBeGreaterThan(host.clientHeight + 500)
    viewer.jumpTo({ offset: text.indexOf("Line 100") })
    await expect.poll(() => host.scrollTop, { timeout: 4000 }).toBeGreaterThan(1000)
    const there = host.scrollTop
    viewer.jumpTo({ line: 1 })
    await expect.poll(() => host.scrollTop, { timeout: 4000 }).toBeLessThan(there / 2)
  })

  it("takes everything it added out of its element", () => {
    const { viewer, host } = mount({ text: "one\n" })
    viewer.destroy()
    viewers.pop()
    expect(host.children).toHaveLength(0)
  })
})

describe("the outline", () => {
  it("lists second- and third-level headings with where they start, skipping fences", () => {
    const text = "# Title\n\n## One\n```\n## Not\n```\n### Two\n"
    expect(outline(text)).toEqual([
      { text: "One", at: text.indexOf("## One"), depth: 2 },
      { text: "Two", at: text.indexOf("### Two"), depth: 3 },
    ])
  })
})
