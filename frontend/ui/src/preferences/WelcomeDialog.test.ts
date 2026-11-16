import { render, type Rendered } from "@novadeck/test-kit/render"
import { createElement, type ComponentProps } from "react"
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
