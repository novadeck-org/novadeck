import { EditorView } from "@codemirror/view"
import { findTables, mountMarkdown, rowAnnotations } from "@novadeck/viewers/markdown"
import { afterEach } from "vitest"

import { context, describe, expect, it } from "../../../test"
import { planNotes, rowNotes } from "./plan-notes"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const table = "| Page | Why |\n| --- | --- |\n| Home | Lead in |\n"
const noted = "| Page | Why |\n| --- | --- |\n| About | Contact <!-- novadeck: Old --> |\n"

const open = (text: string) => {
  const container = document.createElement("div")
  document.body.append(container)
  const viewer = mountMarkdown(container, {
    content: { text },
    label: "Plan",
    editable: true,
    extensions: [planNotes, rowAnnotations.of(rowNotes)],
  })
  unmounts.push(() => {
    viewer.destroy()
    container.remove()
  })
  const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!
  return { container, view }
}

describe("a plan's table row notes", () => {
  context("when a row has one", () => {
    it("reads its text out of Novadeck's comment, not into the row's cells", () => {
      const [found] = findTables(noted, rowNotes)
      expect(found!.annotations[1]!.text).toBe("Old")
      expect(found!.rows[1]!.map((cell) => cell.text)).toEqual(["About", "Contact"])
    })

    it("shows it under the row, named by the row", () => {
      const { container } = open(noted)
      const field = container.querySelector<HTMLTextAreaElement>(".cm-md-annotation-input")!
      expect(field.value).toBe("Old")
      expect(field.getAttribute("aria-label")).toBe("Note on row 2")
    })
  })

  context("when a row gets a note", () => {
    it("offers a control on every row, named for the row or the table, in the app's button looks", () => {
      const { container } = open(table)
      const buttons = [...container.querySelectorAll<HTMLElement>(".cm-md-annotation-add")]
      expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
        "Add a note on the table",
        "Add a note on this row",
      ])
      expect(buttons.every((button) => button.classList.contains("icon-button"))).toBe(true)
    })

    it("writes it as a comment at the end of the row's last cell, escaping pipes and a closing mark", () => {
      const { container, view } = open(table)
      container
        .querySelectorAll<HTMLElement>(".cm-md-annotation-add")[1]!
        .dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
      expect(view.state.doc.toString()).toContain("| Home | Lead in <!-- novadeck:  --> |")
      const field = container.querySelector<HTMLTextAreaElement>(".cm-md-annotation-input")!
      field.value = "email | phone --> now"
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      expect(view.state.doc.toString()).toContain(
        "| Home | Lead in <!-- novadeck: email \\| phone -> now --> |",
      )
    })
  })
})
