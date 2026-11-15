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
