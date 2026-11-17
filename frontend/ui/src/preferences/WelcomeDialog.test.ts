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

describe("leaving the welcome dialog", () => {
  const start = (): HTMLButtonElement =>
    [...document.querySelectorAll("button")].find((each) =>
      each.textContent?.includes("Let’s build something"),
    )!
  const open = (): boolean => document.querySelector('[role="dialog"]') !== null

  it("offers no skip, and says what is chosen can be changed later", () => {
    show({})
    expect(document.body.textContent).not.toContain("Skip")
    expect(document.body.textContent).toContain("You can change any of this later in Preferences.")
  })

  it("stays open on Escape and on a click on the backdrop, finishing nothing", () => {
    const done = vi.fn<() => void>()
    show({ onDone: done })
    act(() => {
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    act(() => {
      const backdrop = document.querySelector(".welcome-overlay")!
      backdrop.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
      backdrop.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
    expect(open()).toBe(true)
    expect(done).not.toHaveBeenCalled()
  })

  it("applies what is shown chosen: the installed agents, transcripts and the chat view", () => {
    const connected: [string, boolean][] = []
    const transcripts: boolean[] = []
    const chat: boolean[] = []
    const done = vi.fn<() => void>()
    show({
      agents: [
        { agent: "claude", available: true, connected: false, busy: false },
        { agent: "codex", available: true, connected: false, busy: false },
        { agent: "agy", available: false, connected: false, busy: false },
      ],
      onChange: (agent, on) => connected.push([agent, on]),
      transcripts: { enabled: false, available: true, onChange: (on) => transcripts.push(on) },
      chatView: { enabled: false, onChange: (on) => chat.push(on) },
      onDone: done,
    })
    start().click()
    expect(connected).toEqual([
      ["claude", true],
      ["codex", true],
    ])
    expect(transcripts).toEqual([true])
    expect(chat).toEqual([true])
    expect(done).toHaveBeenCalledOnce()
  })

  it("applies what is unticked as unticked", () => {
    const connected: [string, boolean][] = []
    const transcripts: boolean[] = []
    const chat: boolean[] = []
    show({
      agents: [
        { agent: "claude", available: true, connected: true, busy: false },
        { agent: "codex", available: true, connected: false, busy: false },
      ],
      onChange: (agent, on) => connected.push([agent, on]),
      transcripts: { enabled: true, available: true, onChange: (on) => transcripts.push(on) },
      chatView: { enabled: true, onChange: (on) => chat.push(on) },
    })
    for (const [name, value] of [
      ["agents", "claude"],
      ["agents", "codex"],
      ["transcripts", "on"],
      ["chat-view", "on"],
    ] as const)
      document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!.click()
    start().click()
    expect(connected).toEqual([["claude", false]])
    expect(transcripts).toEqual([false])
    expect(chat).toEqual([false])
  })

  it("finishes while an agent is installing, one is missing and transcripts are unavailable", () => {
    const connected: [string, boolean][] = []
    const done = vi.fn<() => void>()
    show({
      agents: [
        { agent: "claude", available: true, connected: false, busy: true },
        { agent: "codex", available: true, connected: false, busy: false },
        { agent: "agy", available: false, connected: false, busy: false },
      ],
      onChange: (agent, on) => connected.push([agent, on]),
      transcripts: { enabled: false, available: false, onChange: () => {} },
      onDone: done,
    })
    expect(start().disabled).toBe(false)
    start().click()
    // The busy one is left to its own switch; the rest is applied.
    expect(connected).toEqual([["codex", true]])
    expect(done).toHaveBeenCalledOnce()
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
