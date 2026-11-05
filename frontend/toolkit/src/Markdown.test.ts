import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"

import { Markdown } from "./Markdown"
import { context, describe, expect, it } from "./test"

const fenced = (lang: string): string => `\`\`\`${lang}\nconst answer = 42\n\`\`\``

describe("a fenced code block", () => {
  // Coloured runs: the highlighter's spans inside the block.
  const coloured = (container: HTMLElement): number =>
    container.querySelectorAll("pre code span[class]").length

  it("colours its lines once its language's parser has loaded", async () => {
    const view = render(createElement(Markdown, { text: fenced("ts") }))
    await expect.poll(() => coloured(view.container)).toBeGreaterThan(0)
    view.unmount()
  })

  context("whose language changes over the same text", () => {
    it("drops the old colours at once", async () => {
      const view = render(createElement(Markdown, { text: fenced("ts") }))
      await expect.poll(() => coloured(view.container)).toBeGreaterThan(0)
      view.rerender(createElement(Markdown, { text: fenced("python") }))
      expect(coloured(view.container)).toBe(0)
      await expect.poll(() => coloured(view.container)).toBeGreaterThan(0)
      view.unmount()
    })

    it("shows plain text for a language it doesn't highlight", async () => {
      const view = render(createElement(Markdown, { text: fenced("ts") }))
      await expect.poll(() => coloured(view.container)).toBeGreaterThan(0)
      view.rerender(createElement(Markdown, { text: fenced("text") }))
      expect(coloured(view.container)).toBe(0)
      expect(view.container.querySelector("pre code")!.textContent).toBe("const answer = 42")
      view.unmount()
    })
  })
})
