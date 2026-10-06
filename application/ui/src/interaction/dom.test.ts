import { afterEach } from "vitest"

import { context, describe, expect, it } from "../test"
import { classifyKeyTarget, insideOwnKeys } from "./dom"

afterEach(() => document.body.replaceChildren())

const mount = (html: string): HTMLElement => {
  document.body.innerHTML = html
  return document.querySelector<HTMLElement>("[data-target]")!
}

describe("key targets", () => {
  context("inside a region that takes its own keys", () => {
    it("leaves its keys and clicks to it, as it does for a field", () => {
      const target = mount(
        '<aside data-own-keys><button data-target type="button">Go</button></aside>',
      )
      expect(classifyKeyTarget(target).editing).toBe(true)
    })

    it("claims clicks off its controls too, as on its header", () => {
      const target = mount("<aside data-own-keys><header data-target>Debug</header></aside>")
      expect(insideOwnKeys(target)).toBe(true)
    })
  })

  context("on a plain button in the page's chrome", () => {
    it("lets the workspace take its keys", () => {
      const target = mount('<header><button data-target type="button">Go</button></header>')
      expect(classifyKeyTarget(target).editing).toBe(false)
      expect(insideOwnKeys(target)).toBe(false)
    })
  })
})
