import type { FileContent } from "@novadeck/core/items"
import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../../test"
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
})
