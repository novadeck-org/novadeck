import { afterEach } from "vitest"

import { screenReaderOn } from "./screen-reader"
import { describe, expect, it } from "./test"

const root = document.documentElement
afterEach(() => root.removeAttribute("data-screen-reader"))

describe("screenReaderOn", () => {
  it("follows the page's setting", () => {
    root.dataset.screenReader = "off"
    expect(screenReaderOn()).toBe(false)
    root.dataset.screenReader = "on"
    expect(screenReaderOn()).toBe(true)
  })

  it("keeps a reader's text on a page that doesn't say", () => {
    expect(screenReaderOn()).toBe(true)
  })
})
