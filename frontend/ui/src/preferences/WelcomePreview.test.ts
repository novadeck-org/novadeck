import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
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
  // The preview has no card of opencode's or pi's: its terminals are the three agents' and a shell's.
  mounted.push(
    render(
      createElement(WelcomePreview, { connected: { ...connected, opencode: false, pi: false } }),
    ),
  )
}

const terminal = (name: string): Element | undefined =>
  [...document.querySelectorAll(".welcome-terminal")].find((each) =>
    each.textContent?.includes(name),
  )

describe("the welcome dialog's preview", () => {
  it("shows a terminal for Antigravity beside Claude Code's and Codex's", () => {
    show({ claude: false, codex: false, agy: false })
    expect(terminal("Planner")?.classList.contains("agy")).toBe(true)
    expect(document.querySelectorAll(".welcome-terminal")).toHaveLength(4)
  })

  it("marks each agent's terminal connected when it is chosen, Antigravity's too", () => {
    show({ claude: false, codex: false, agy: true })
    expect(terminal("Planner")?.querySelector("[data-connected]")).not.toBeNull()
    expect(terminal("Planner")?.querySelector(".welcome-scan")).not.toBeNull()
    expect(terminal("Build something great")?.querySelector("[data-connected]")).toBeNull()
    expect(terminal("A fresh perspective")?.querySelector("[data-connected]")).toBeNull()
  })

  it("shows Antigravity not connected when it is not chosen", () => {
    show({ claude: true, codex: true, agy: false })
    expect(terminal("Planner")?.querySelector("[data-connected]")).toBeNull()
  })
})

describe("the chat view, in the welcome dialog's preview", () => {
  const connected = { claude: true, codex: true, agy: false, opencode: false, pi: false }
  const caption = (): string =>
    document.querySelector(".welcome-caption")?.textContent?.trim() ?? ""

  it("draws the agents' cards as a chat, each with its box, and leaves a plain terminal be", () => {
    mounted.push(render(createElement(WelcomePreview, { connected, chat: true })))
    for (const [title, harness] of [
      ["Build something great", "Claude Code"],
      ["A fresh perspective", "Codex"],
      ["Planner", "Antigravity"],
    ] as const) {
      expect(terminal(title)?.querySelector(".welcome-chat")).not.toBeNull()
      expect(terminal(title)?.textContent).toContain(`Message ${harness}…`)
      expect(terminal(title)?.textContent).not.toContain("❯")
    }
    expect(terminal("Dev server")?.querySelector(".welcome-chat")).toBeNull()
    expect(terminal("Dev server")?.textContent).toContain("$ pnpm dev")
  })

  it("draws terminals while the chat view isn't chosen", () => {
    show(connected)
    expect(document.querySelector(".welcome-chat")).toBeNull()
    expect(terminal("Build something great")?.textContent).toContain("❯ Let’s bring this idea")
  })

  it("says what the choice changed as it changes, until a layout is picked", () => {
    const page = render(createElement(WelcomePreview, { connected, chat: true }))
    mounted.push(page)
    expect(caption()).toBe("Spread out on a zoomable canvas.")
    page.rerender(createElement(WelcomePreview, { connected, chat: false }))
    expect(caption()).toBe("Agents keep their own terminal screens.")
    expect(document.querySelector(".welcome-chat")).toBeNull()
    page.rerender(createElement(WelcomePreview, { connected, chat: true }))
    expect(caption()).toBe("Agents read as a chat: your words, their replies and steps.")
    const grid = [...document.querySelectorAll("button")].find(
      (each) => each.textContent === "Grid",
    )
    act(() => grid!.click())
    expect(caption()).toBe("Everything side by side.")
  })

  it("marks the cards the chat view changes while its choice is looked at", () => {
    const page = render(createElement(WelcomePreview, { connected, chat: true }))
    mounted.push(page)
    const stage = (): Element | null => document.querySelector(".welcome-stage")
    expect(stage()?.getAttribute("data-spotlight")).toBeNull()
    page.rerender(createElement(WelcomePreview, { connected, chat: true, spotlight: true }))
    expect(stage()?.getAttribute("data-spotlight")).toBe("chat")
  })
})
