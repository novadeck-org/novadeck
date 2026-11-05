import { EditorSelection } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import type { FileContent } from "@novadeck/core/items"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { MarkdownDocument } from "../../document/MarkdownDocument"
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
    // The editor in `container`, once it has loaded.
    const editorIn = async (container: HTMLElement) => {
      await act(async () => {
        await vi.dynamicImportSettled()
      })
      return EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!
    }
    // The document `id` shows, and its editor.
    const open = async (id: string, shown: FileContent) => {
      const rendered = render(createElement(DocumentViewer, { id, name: "doc", content: shown }))
      return { ...rendered, view: await editorIn(rendered.container) }
    }
    // The person leaves the cursor at the document's end and it closes.
    const leave = async (id: string, shown: FileContent) => {
      const { view, unmount } = await open(id, shown)
      act(() => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) }))
      act(() => unmount())
    }

    it("opens the new file at its start, not as the last one was left", async () => {
      await leave("source-1", content)
      const { view, unmount } = await open("source-1", changelog)
      unmounts.push(unmount)
      expect(view.state.doc.toString()).toBe(changelog.lines.join("\n"))
      expect(view.state.selection.main.head).toBe(0)
    })

    it("opens the new file at its start when it comes while the document is open", async () => {
      const { view, rerender, container, unmount } = await open("source-2", content)
      unmounts.push(unmount)
      act(() => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) }))
      rerender(createElement(DocumentViewer, { id: "source-2", name: "doc", content: changelog }))
      const next = await editorIn(container)
      expect(next.state.doc.toString()).toBe(changelog.lines.join("\n"))
      expect(next.state.selection.main.head).toBe(0)
    })

    it("opens the same file, shown again, as it was left", async () => {
      await leave("source-3", content)
      const { view, unmount } = await open("source-3", content)
      unmounts.push(unmount)
      expect(view.state.selection.main.head).toBe(view.state.doc.length)
    })

    it("keeps a plan's editor as it was left, however many files are read meanwhile", async () => {
      const plan = render(
        createElement(MarkdownDocument, {
          id: "plan",
          text: "# Plan\n\nSteps.",
          label: "Plan",
          onReady: () => {},
        }),
      )
      const view = await editorIn(plan.container)
      act(() => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) }))
      act(() => plan.unmount())
      for (let each = 0; each < 13; each += 1) await leave(`file-${each}`, content)
      const again = render(
        createElement(MarkdownDocument, {
          id: "plan",
          text: "# Plan\n\nSteps.",
          label: "Plan",
          onReady: () => {},
        }),
      )
      unmounts.push(again.unmount)
      const reopened = await editorIn(again.container)
      expect(reopened.state.selection.main.head).toBe(reopened.state.doc.length)
    })
  })
})
