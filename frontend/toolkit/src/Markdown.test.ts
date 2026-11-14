import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { Markdown } from "./Markdown"
import { context, describe, expect, it } from "./test"

const mounted: (() => void)[] = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
})

const mount = (text: string) => {
  const view = render(createElement(Markdown, { text }))
  mounted.push(view.unmount)
  return view
}

// The parser loads on first use, which a cold, busy runner may take a while over.
const loaded = { timeout: 5000 }

const fenced = (lang: string): string => `\`\`\`${lang}\nconst answer = 42\n\`\`\``

describe("a fenced code block", () => {
  // Coloured runs: the highlighter's spans inside the block.
  const coloured = (container: HTMLElement): number =>
    container.querySelectorAll("pre code span[class]").length

  it("colours its lines once its language's parser has loaded", async () => {
    const view = mount(fenced("ts"))
    await expect.poll(() => coloured(view.container), loaded).toBeGreaterThan(0)
  })

  it("shows coloured at once when drawn again, as a chat is when its view changes", async () => {
    const text = "```ts\nconst again = 7\n```"
    const first = mount(text)
    await expect.poll(() => coloured(first.container), loaded).toBeGreaterThan(0)
    first.unmount()
    expect(coloured(mount(text).container)).toBeGreaterThan(0)
  })

  context("whose language changes over the same text", () => {
    it("drops the old colours at once", async () => {
      const view = mount(fenced("ts"))
      await expect.poll(() => coloured(view.container), loaded).toBeGreaterThan(0)
      view.rerender(createElement(Markdown, { text: fenced("python") }))
      expect(coloured(view.container)).toBe(0)
      await expect.poll(() => coloured(view.container), loaded).toBeGreaterThan(0)
    })

    it("shows plain text for a language it doesn't highlight", async () => {
      const view = mount(fenced("ts"))
      await expect.poll(() => coloured(view.container), loaded).toBeGreaterThan(0)
      view.rerender(createElement(Markdown, { text: fenced("text") }))
      expect(coloured(view.container)).toBe(0)
      expect(view.container.querySelector("pre code")!.textContent).toBe("const answer = 42")
    })
  })
})
