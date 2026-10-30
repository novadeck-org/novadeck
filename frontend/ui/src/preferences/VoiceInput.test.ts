import type { Voice, VoiceState } from "@novadeck/core/addons/voice"
import { render } from "@novadeck/test-kit/render"
import { createElement, createRef } from "react"

import { describe, expect, it } from "../test"
import { VoiceInput } from "./VoiceInput"

const base: VoiceState = {
  available: true,
  installed: [],
  enabled: false,
  wanted: true,
  model: "small",
  aim: "turbo",
  engineInstalled: false,
  language: "auto",
  sizes: { engine: 28, turbo: 574, small: 190 },
  installing: null,
  check: null,
  failure: null,
  refused: null,
}

const actions: Pick<Voice, "install" | "cancel" | "uninstall" | "set"> = {
  install: () => Promise.resolve(),
  cancel: () => {},
  uninstall: () => {},
  set: () => {},
}

const card = (state: VoiceState) =>
  createElement(VoiceInput, {
    voice: { state, actions },
    open: true,
    portalContainer: createRef<HTMLElement>(),
  })

const labels = (container: HTMLElement): string[] =>
  [...container.querySelectorAll("button, [role=switch]")].map(
    (each) => each.textContent || each.getAttribute("aria-labelledby") || "",
  )

describe("voice input's card in Addons", () => {
  it("shows the switch off and disabled before an install, though voice input is wanted", () => {
    const view = render(card({ ...base, wanted: true }))
    const toggle = view.container.querySelector<HTMLButtonElement>("[role=switch]")
    expect(toggle?.getAttribute("aria-checked")).toBe("false")
    expect(toggle?.disabled).toBe(true)
    expect(view.container.textContent).toContain("Turns on when you install it.")
    view.unmount()
  })

  it("offers Install, not a bare switch, for a model a cancel left on disk unchecked", () => {
    const view = render(card({ ...base, installed: ["small"] }))
    expect(labels(view.container)).toContain("Install")
    // What is on disk can still be reclaimed.
    expect(labels(view.container)).toContain("Uninstall")
    expect(view.container.textContent).toContain("Frees")
    view.unmount()
  })

  it("says to finish setting up, not a size, when nothing is left to download, and holds still while removing", () => {
    const view = render(
      card({ ...base, engineInstalled: true, installed: ["small"], aim: "small" }),
    )
    expect(view.container.textContent).toContain("Finish setting up voice input.")
    expect(view.container.textContent).not.toContain("0 MB")
    view.unmount()
  })

  it("offers Uninstall for an engine alone, and nothing to remove for an empty disk", () => {
    const engine = render(card({ ...base, engineInstalled: true }))
    expect(labels(engine.container)).toContain("Uninstall")
    engine.unmount()
    const none = render(card(base))
    expect(labels(none.container)).not.toContain("Uninstall")
    none.unmount()
  })

  it("offers Uninstall once the model passed its check", () => {
    const check = { model: "small", milliseconds: 3000 } as const
    const view = render(card({ ...base, installed: ["small"], enabled: true, check }))
    expect(labels(view.container)).toContain("Uninstall")
    expect(labels(view.container)).not.toContain("Install")
    view.unmount()
  })
})
