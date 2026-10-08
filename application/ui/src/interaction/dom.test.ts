import { afterEach } from "vitest"

import { context, describe, expect, it } from "../test"
import { classifyKeyTarget, focusZenCreate, insideOwnKeys } from "./dom"

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

describe("focusing Zen's controls after they mount", () => {
  it("focuses the control when focus was left on the page", () => {
    mount('<button data-workspace-zen-create data-target type="button">New</button>')
    focusZenCreate()
    expect(document.activeElement).toBe(document.querySelector("[data-target]"))
  })

  it("takes it from the control it replaces, as it unmounts", () => {
    mount(
      '<button data-workspace-zen-create data-target type="button">New</button><button data-workspace-zen-enter type="button">Zen</button>',
    )
    document.querySelector<HTMLElement>("[data-workspace-zen-enter]")!.focus()
    focusZenCreate()
    expect(document.activeElement).toBe(document.querySelector("[data-target]"))
  })

  it("takes it from a control that became inert", () => {
    mount(
      '<button data-workspace-zen-create data-target type="button">New</button><div inert><button data-other type="button">Prefs</button></div>',
    )
    const hidden = document.querySelector<HTMLElement>("[data-other]")!
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => hidden })
    try {
      focusZenCreate()
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
    }
    expect(document.activeElement).toBe(document.querySelector("[data-target]"))
  })

  it("takes it from a control that became disabled", () => {
    mount(
      '<button data-workspace-zen-create data-target type="button">New</button><button data-other disabled type="button">Switch</button>',
    )
    const disabled = document.querySelector<HTMLElement>("[data-other]")!
    Object.defineProperty(document, "activeElement", { configurable: true, get: () => disabled })
    try {
      focusZenCreate()
    } finally {
      delete (document as { activeElement?: unknown }).activeElement
    }
    expect(document.activeElement).toBe(document.querySelector("[data-target]"))
  })

  it("leaves focus where a key moved it before the frame", () => {
    mount(
      '<button data-workspace-zen-create type="button">New</button><button data-target type="button">Other</button>',
    )
    document.querySelector<HTMLElement>("[data-target]")!.focus()
    focusZenCreate()
    expect(document.activeElement).toBe(document.querySelector("[data-target]"))
  })
})
