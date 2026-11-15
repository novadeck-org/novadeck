import { render, type Rendered } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { WelcomePreview } from "./WelcomePreview"

vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const mounted: Rendered[] = []
beforeEach(() => vi.stubGlobal("matchMedia", () => ({ matches: true })))
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  vi.unstubAllGlobals()
})

const show = (connected: { claude: boolean; codex: boolean; agy: boolean }): void => {
  mounted.push(render(createElement(WelcomePreview, { connected })))
}

const terminal = (name: string): Element | undefined =>
  [...document.querySelectorAll(".welcome-terminal")].find((each) =>
    each.textContent?.includes(name),
  )

describe("the welcome dialog's preview", () => {
  it("shows a terminal for Antigravity beside Claude Code's and Codex's", () => {
    show({ claude: false, codex: false, agy: false })
    expect(terminal("Another way in")?.classList.contains("agy")).toBe(true)
    expect(document.querySelectorAll(".welcome-terminal")).toHaveLength(4)
  })

  it("marks each agent's terminal connected when it is chosen, Antigravity's too", () => {
    show({ claude: false, codex: false, agy: true })
    expect(terminal("Another way in")?.querySelector("[data-connected]")).not.toBeNull()
    expect(terminal("Another way in")?.querySelector(".welcome-scan")).not.toBeNull()
    expect(terminal("Build something great")?.querySelector("[data-connected]")).toBeNull()
    expect(terminal("A fresh perspective")?.querySelector("[data-connected]")).toBeNull()
  })

  it("shows Antigravity not connected when it is not chosen", () => {
    show({ claude: true, codex: true, agy: false })
    expect(terminal("Another way in")?.querySelector("[data-connected]")).toBeNull()
  })
})
