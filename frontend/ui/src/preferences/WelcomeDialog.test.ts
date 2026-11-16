import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement, type ComponentProps } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { WelcomeDialog } from "./WelcomeDialog"

vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const mounted: Rendered[] = []
beforeEach(() => vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {} })))
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  vi.unstubAllGlobals()
})

const show = (props: Partial<ComponentProps<typeof WelcomeDialog>>): void => {
  mounted.push(
    render(
      createElement(WelcomeDialog, {
        open: true,
        agents: [
          { agent: "claude", available: true, connected: false, busy: false },
          {
            agent: "agy",
            available: false,
            connected: false,
            busy: false,
            installer: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
          },
        ],
        onChange: () => {},
        onDone: () => {},
        ...props,
      }),
    ),
  )
}

const checkbox = (name: string): HTMLInputElement | null =>
  document.querySelector(`input[type="checkbox"][value="${name}"]`)
const install = (): Element | null =>
  document.querySelector('button[aria-label="Install Antigravity"]')

describe("an agent that is not installed, in the welcome dialog", () => {
  it("offers Install with its command where the dialog can install", () => {
    show({ onInstall: () => {} })
    expect(install()?.textContent).toBe("Install")
    expect(document.body.textContent).toContain(
      "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    )
  })

  it("offers it as a seat to fill, its command read out with Install and shown on asking", () => {
    show({ onInstall: () => {} })
    const toggle = [...document.querySelectorAll("button")].find((each) =>
      each.textContent?.includes("Show install command"),
    )!
    expect(document.body.textContent).toContain("Add Antigravity")
    expect(document.getElementById(install()!.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Not installed. Install runs curl -fsSL https://antigravity.google/cli/install.sh | bash",
    )
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(document.querySelector(".welcome-install-command")).toBeNull()
    act(() => toggle.click())
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(toggle.textContent).toBe("Hide install command")
    expect(document.querySelector(".welcome-install-command")?.textContent).toBe(
      "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    )
  })

  it("keeps a disabled checkbox where the dialog has no way to install", () => {
    show({})
    expect(install()).toBeNull()
    expect(checkbox("agy")?.disabled).toBe(true)
    expect(checkbox("claude")?.disabled).toBe(false)
  })
})

describe("the chat view, in the welcome dialog", () => {
  const chatView = (): HTMLInputElement | null =>
    document.querySelector('input[type="checkbox"][name="chat-view"]')
  const button = (text: string): HTMLButtonElement | undefined =>
    [...document.querySelectorAll("button")].find((each) => each.textContent?.includes(text))

  it("isn't offered where the backend reads no conversations", () => {
    show({})
    expect(chatView()).toBeNull()
  })

  it("starts chosen, and turns the chat view on as the person starts", () => {
    const changes: boolean[] = []
    show({ chatView: { enabled: false, onChange: (on) => changes.push(on) } })
    expect(chatView()?.checked).toBe(true)
    button("Let’s build something")!.click()
    expect(changes).toEqual([true])
  })

  it("leaves it off when the person unchecks it", () => {
    const changes: boolean[] = []
    show({ chatView: { enabled: false, onChange: (on) => changes.push(on) } })
    chatView()!.click()
    expect(chatView()?.checked).toBe(false)
    button("Let’s build something")!.click()
    expect(changes).toEqual([])
  })

  it("changes nothing when the person skips", () => {
    const changes: boolean[] = []
    show({ chatView: { enabled: false, onChange: (on) => changes.push(on) } })
    button("Skip for now")!.click()
    expect(changes).toEqual([])
  })
})

describe("the chat view's preview, in the welcome dialog", () => {
  const spotlit = (): boolean =>
    document.querySelector(".welcome-stage")?.getAttribute("data-spotlight") === "chat"
  const card = (): HTMLElement =>
    document.querySelector('input[name="chat-view"]')!.closest<HTMLElement>(".choice-card")!

  it("shows the agents as a chat while the choice is checked, and terminals once it isn't", () => {
    show({ chatView: { enabled: false, onChange: () => {} } })
    expect(document.querySelector(".welcome-chat")).not.toBeNull()
    act(() => document.querySelector<HTMLInputElement>('input[name="chat-view"]')!.click())
    expect(document.querySelector(".welcome-chat")).toBeNull()
  })

  it("marks what the choice changes while it has focus, though the pointer leaves it", () => {
    show({ chatView: { enabled: false, onChange: () => {} } })
    expect(spotlit()).toBe(false)
    act(() => card().dispatchEvent(new PointerEvent("pointerover", { bubbles: true })))
    act(() => document.querySelector<HTMLInputElement>('input[name="chat-view"]')!.focus())
    expect(spotlit()).toBe(true)
    act(() => card().dispatchEvent(new PointerEvent("pointerout", { bubbles: true })))
    expect(spotlit()).toBe(true)
    act(() => document.querySelector<HTMLInputElement>('input[name="chat-view"]')!.blur())
    expect(spotlit()).toBe(false)
  })
})

describe("the scheme, in the welcome dialog", () => {
  const scheme = (label: string): HTMLInputElement | null =>
    document.querySelector(
      `[role="radiogroup"][aria-label="Appearance"] input[aria-label="${label}"]`,
    )

  it("isn't offered where the theme comes in one scheme", () => {
    show({})
    expect(document.querySelector('[role="radiogroup"][aria-label="Appearance"]')).toBeNull()
  })

  // Picking one, and its applying at once, is the welcome spec's: the group answers pointer
  // events, which jsdom doesn't send.
  it("shows the chosen scheme where the theme comes in more than one", () => {
    show({ scheme: { value: "dark", onChange: () => {} } })
    expect(scheme("Dark")?.checked).toBe(true)
    expect(scheme("System")?.checked).toBe(false)
  })
})
