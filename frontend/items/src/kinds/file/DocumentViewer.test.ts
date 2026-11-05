import type { FileContent } from "@novadeck/core/items"
import { render } from "@novadeck/test-kit/render"
import { EditorSelection } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../../test"
import { DocumentViewer } from "./DocumentViewer"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const lines = ["# Brand voice", "", "## Words", "Plain. <!-- novadeck: shorter -->"]
const content: FileContent = {
  kind: "file",
  path: "docs/brand-voice.md",
  firstLine: 1,
  lines,
  from: 1,
  to: lines.length,
  total: lines.length,
  clamped: false,
  truncated: false,
}

describe("a Markdown file's document", () => {
  it("reads in a Markdown document, read-only, with its outline and none of a plan's notes", async () => {
    const { container, unmount } = render(
      createElement(DocumentViewer, { id: "voice", name: "brand-voice.md", content }),
    )
    unmounts.push(unmount)
    await act(async () => {
      await vi.dynamicImportSettled()
    })
    const editor = container.querySelector(".document-editor")
    expect(editor?.hasAttribute("data-readonly")).toBe(true)
    expect(editor?.querySelector(".cm-editor")).not.toBeNull()
    expect(editor?.querySelector(".cm-plan-note-gutter")).toBeNull()
    expect(
      [...container.querySelectorAll(".spine button")].map((each) => each.textContent),
    ).toEqual(["Words"])
  })

  it("is labelled by the file's name", async () => {
    const { container, unmount } = render(
      createElement(DocumentViewer, { id: "voice", name: "brand-voice.md", content }),
    )
    unmounts.push(unmount)
    await act(async () => {
      await vi.dynamicImportSettled()
    })
    expect(container.querySelector(".cm-content")?.getAttribute("aria-label")).toBe(
      "brand-voice.md",
    )
  })

  context("when its item is shown another file, as the project window's is", () => {
    const changelog: FileContent = {
      ...content,
      path: "docs/CHANGELOG.md",
      lines: ["# Changelog", "", "## 1.0", "First."],
    }
    // The document's editor, once it has loaded.
    const open = async (shown: FileContent) => {
      const rendered = render(
        createElement(DocumentViewer, { id: "source", name: "doc", content: shown }),
      )
      await act(async () => {
        await vi.dynamicImportSettled()
      })
      const editor = rendered.container.querySelector<HTMLElement>(".cm-editor")!
      return { ...rendered, view: EditorView.findFromDOM(editor)! }
    }
    // The person leaves the cursor at the document's end and it closes.
    const leave = async (shown: FileContent) => {
      const { view, unmount } = await open(shown)
      act(() => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) }))
      act(() => unmount())
    }

    it("opens the new file at its start, not as the last one was left", async () => {
      await leave(content)
      const { view, unmount } = await open(changelog)
      unmounts.push(unmount)
      expect(view.state.doc.toString()).toBe(changelog.lines.join("\n"))
      expect(view.state.selection.main.head).toBe(0)
    })

    it("opens a file shown again as it was left", async () => {
      await leave(content)
      await leave(changelog)
      const { view, unmount } = await open(content)
      unmounts.push(unmount)
      expect(view.state.selection.main.head).toBe(view.state.doc.length)
    })
  })
})
