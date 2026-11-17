import { nextFrame, render, type Rendered } from "@novadeck/test-kit/render"
import { createElement, type ComponentProps } from "react"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { Preferences } from "./Preferences"
import { readPreferences } from "./preferences-storage"

// jsdom has no layout: observe no resizes.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const mounted: Rendered[] = []
afterEach(() => mounted.splice(0).forEach((page) => page.unmount()))

const show = async (addons: Partial<ComponentProps<typeof Preferences>>): Promise<void> => {
  const page = render(
    createElement(Preferences, {
      open: true,
      tab: "addons",
      onTabChange: () => {},
      value: readPreferences(),
      onChange: () => {},
      onClose: () => {},
      ...addons,
    }),
  )
  mounted.push(page)
  // The tabs' segment group measures its indicator a frame later: let that frame pass here.
  await nextFrame()
}

const tabs = (): string[] =>
  [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? "")
const selected = (): string | null =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null

describe("the preferences of a backend with no addons", () => {
  it("opens General, not the Addons panel, when a URL names Addons", async () => {
    await show({})

    expect(tabs()).not.toContain("Addons")
    expect(selected()).toBe("General")
    expect(document.querySelector('[role="tabpanel"][aria-labelledby$="addons"]')).toBeNull()
  })

  it("has no Addons tab for the chat view, which is in Appearance", async () => {
    await show({ chat: true })

    expect(tabs()).not.toContain("Addons")
    expect(selected()).toBe("General")
  })
})

describe("a tab the narrow window's list has scrolled out of sight", () => {
  it("is brought into view when the dialog opens on it, and when another is chosen", async () => {
    const brought: (string | null)[] = []
    const scrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (this: Element) {
      brought.push(this.textContent)
    }
    const props = (open: boolean, tab: ComponentProps<typeof Preferences>["tab"]) => ({
      open,
      tab,
      version: "0.4.2",
      onTabChange: () => {},
      value: readPreferences(),
      onChange: () => {},
      onClose: () => {},
    })
    try {
      // The dialog mounts its content only once it opens.
      const page = render(createElement(Preferences, props(false, "about")))
      mounted.push(page)
      await nextFrame()
      expect(brought).toEqual([])

      page.rerender(createElement(Preferences, props(true, "about")))
      await nextFrame()
      expect(brought).toEqual(["About"])

      page.rerender(createElement(Preferences, props(true, "general")))
      await nextFrame()
      expect(brought).toEqual(["About", "General"])
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView
    }
  })
})

describe("the Agents tab", () => {
  const agent = (name: "claude" | "codex" | "agy") => ({
    agent: name,
    available: true,
    connected: false,
    busy: false,
  })
  const panel = (): Element | null =>
    document.querySelector('[role="tabpanel"][aria-labelledby$="agents"]')

  it("comes first, and a URL naming it opens it", async () => {
    await show({
      tab: "agents",
      agents: { list: [agent("claude")], onChange: () => {} },
    })

    expect(tabs().slice(0, 3)).toEqual(["Agents", "Appearance", "General"])
    expect(selected()).toBe("Agents")
  })

  it("holds the agents' switches and when to stop the idle ones", async () => {
    await show({
      tab: "agents",
      agents: { list: [agent("claude"), agent("codex"), agent("agy")], onChange: () => {} },
      hibernation: { minutes: 60, onChange: () => {} },
    })

    expect(panel()?.querySelectorAll('ul[aria-label="Agents"] [role=switch]')).toHaveLength(3)
    expect(panel()?.textContent).toContain("Stop idle agents after")
    const general = document.querySelector('[role="tabpanel"][aria-labelledby$="general"]')
    expect(general?.textContent).not.toContain("Stop idle agents after")
    expect(general?.querySelector('ul[aria-label="Agents"]')).toBeNull()
  })

  it("is absent where the backend has neither agents nor a wait, and a URL naming it opens General", async () => {
    await show({ tab: "agents" })

    expect(tabs()).not.toContain("Agents")
    expect(selected()).toBe("General")
  })

  it("is there for the idle wait alone", async () => {
    await show({ tab: "agents", hibernation: { minutes: null, onChange: () => {} } })

    expect(selected()).toBe("Agents")
    expect(panel()?.textContent).toContain("Stop idle agents after")
  })
})

describe("the tab Preferences opens on when none is named", () => {
  const agent = { agent: "claude" as const, available: true, connected: false, busy: false }

  it("is Agents, the first tab, where there are agents", async () => {
    await show({ tab: null, agents: { list: [agent], onChange: () => {} } })

    expect(selected()).toBe("Agents")
  })

  it("is Agents where there is only the idle wait", async () => {
    await show({ tab: null, hibernation: { minutes: 60, onChange: () => {} } })

    expect(selected()).toBe("Agents")
  })

  it("is General where the backend has no agents", async () => {
    await show({ tab: null })

    expect(tabs()).not.toContain("Agents")
    expect(selected()).toBe("General")
  })

  it("is General where General is named, though Agents is first", async () => {
    await show({ tab: "general", agents: { list: [agent], onChange: () => {} } })

    expect(selected()).toBe("General")
  })
})

describe("the Agent Chat choice", () => {
  const choice = (label: "Chat" | "Terminal"): HTMLInputElement | null =>
    [...document.querySelectorAll<HTMLInputElement>('input[name="agent-presentation"]')].find(
      (input) => input.closest("label")?.textContent === label,
    ) ?? null

  it("sits under Appearance's Layout, without Experimental, and shows the saved choice", async () => {
    await show({
      tab: "appearance",
      chat: true,
      value: { ...readPreferences(), chatView: true },
    })

    expect(tabs()).not.toContain("Experimental")
    const panel = document.querySelector('[role="tabpanel"][aria-labelledby$="appearance"]')
    expect(panel?.contains(choice("Chat"))).toBe(true)
    expect(panel?.textContent).toContain("Agent Chat")
    expect(choice("Chat")?.checked).toBe(true)
    expect(choice("Terminal")?.checked).toBe(false)
  })

  it("saves Terminal as the chat view off, and Chat as it on", async () => {
    const saved: boolean[] = []
    await show({
      tab: "appearance",
      chat: true,
      value: { ...readPreferences(), chatView: true },
      onChange: ({ chatView }) => saved.push(chatView),
    })

    choice("Terminal")!.click()
    expect(saved).toEqual([false])
    mounted.splice(0).forEach((page) => page.unmount())

    await show({
      tab: "appearance",
      chat: true,
      value: { ...readPreferences(), chatView: false },
      onChange: ({ chatView }) => saved.push(chatView),
    })
    choice("Chat")!.click()
    expect(saved).toEqual([false, true])
  })

  it("is absent where the backend reads no conversations", async () => {
    await show({ tab: "appearance" })

    expect(choice("Chat")).toBeNull()
    expect(document.body.textContent).not.toContain("Agent Chat")
    expect(document.body.textContent).toContain("View modes")
  })
})

describe("the About tab", () => {
  it("is absent where the backend has no version, updates, logs or removal", async () => {
    await show({ tab: "about" })

    expect(tabs()).not.toContain("About")
    expect(selected()).toBe("General")
  })

  it("holds the version, the Experimental switch and the logs, which General doesn't", async () => {
    await show({
      tab: "about",
      version: "0.4.2",
      logs: () => {},
      experimental: { on: false, onChange: () => {} },
    })

    expect(selected()).toBe("About")
    const panel = document.querySelector('[role="tabpanel"][aria-labelledby$="about"]')
    expect(panel?.textContent).toContain("0.4.2")
    expect(
      panel?.querySelector('[role="switch"][aria-labelledby="experimental-label"]'),
    ).not.toBeNull()
    expect(panel?.textContent).toContain("Open logs folder")
    const general = document.querySelector('[role="tabpanel"][aria-labelledby$="general"]')
    expect(general?.textContent).not.toContain("0.4.2")
    expect(general?.textContent).not.toContain("Experimental")
  })
})

describe("the Experimental tab", () => {
  const experimental = (on: boolean | undefined) => ({ on, onChange: () => {} })

  it("is absent while the Experimental switch is off, and a URL naming it opens General", async () => {
    await show({ tab: "experimental", experimental: experimental(false) })

    expect(tabs()).not.toContain("Experimental")
    expect(selected()).toBe("General")
  })

  it("is absent until the app has said whether the switch is on", async () => {
    await show({ tab: "experimental", experimental: experimental(undefined) })

    expect(tabs()).not.toContain("Experimental")
  })

  it("shows, last, while the switch is on, with agent avatars but not the chat view", async () => {
    await show({ tab: "experimental", chat: true, experimental: experimental(true) })

    expect(tabs().at(-1)).toBe("Experimental")
    expect(selected()).toBe("Experimental")
    const panel = document.querySelector('[role="tabpanel"][aria-labelledby$="experimental"]')
    expect(panel?.querySelector('input[name="agent-presentation"]')).toBeNull()
    expect(
      panel?.querySelector('[role="switch"][aria-labelledby="agent-avatars-label"]'),
    ).not.toBeNull()
  })

  it("holds the onboarding tour switch, off until switched on, which writes the preference", async () => {
    const written: boolean[] = []
    await show({
      tab: "experimental",
      experimental: experimental(true),
      tour: true,
      onChange: (value) => written.push(value.onboardingTour),
    })
    const tourSwitch = document.querySelector<HTMLElement>(
      '[role="switch"][aria-labelledby="onboarding-tour-label"]',
    )

    expect(tourSwitch?.getAttribute("aria-checked")).toBe("false")
    tourSwitch?.click()
    expect(written).toEqual([true])
  })

  it("holds the onboarding tour switch disabled, not available, where the backend has no tour", async () => {
    await show({ tab: "experimental", experimental: experimental(true) })
    const tourSwitch = document.querySelector(
      '[role="switch"][aria-labelledby="onboarding-tour-label"]',
    )

    expect(tourSwitch?.getAttribute("aria-checked")).toBe("false")
    expect(tourSwitch?.hasAttribute("disabled")).toBe(true)
    expect(document.getElementById("onboarding-tour-description")?.textContent).toBe(
      "Not available here.",
    )
  })

  const worktreesSwitch = (): HTMLElement | null =>
    document.querySelector('[role="switch"][aria-labelledby="agent-worktrees-label"]')

  it("holds the agent worktrees switch, which writes the backend's setting", async () => {
    const changes: boolean[] = []
    await show({
      tab: "experimental",
      experimental: experimental(true),
      worktrees: { enabled: false, onChange: (enabled) => changes.push(enabled) },
    })

    expect(worktreesSwitch()?.getAttribute("aria-checked")).toBe("false")
    expect(worktreesSwitch()?.hasAttribute("disabled")).toBe(false)
    worktreesSwitch()?.click()
    expect(changes).toEqual([true])
  })

  it("shows agent worktrees on, and disabled where the backend has none", async () => {
    await show({
      tab: "experimental",
      experimental: experimental(true),
      worktrees: { enabled: true, onChange: () => {} },
    })
    expect(worktreesSwitch()?.getAttribute("aria-checked")).toBe("true")
    mounted.splice(0).forEach((page) => page.unmount())

    await show({ tab: "experimental", experimental: experimental(true) })
    expect(worktreesSwitch()?.getAttribute("aria-checked")).toBe("false")
    expect(
      worktreesSwitch()?.hasAttribute("disabled") ||
        worktreesSwitch()?.getAttribute("aria-disabled") === "true" ||
        worktreesSwitch()?.hasAttribute("data-disabled"),
    ).toBe(true)
    expect(document.body.textContent).toContain("Not available here.")
  })

  it("sits in the Experimental panel, which General's selection hides", async () => {
    await show({
      tab: "general",
      experimental: experimental(true),
      worktrees: { enabled: false, onChange: () => {} },
    })
    expect(selected()).toBe("General")
    const panel = worktreesSwitch()?.closest('[role="tabpanel"]')
    expect(panel?.getAttribute("aria-labelledby")).toMatch(/experimental$/)
    expect(panel?.hasAttribute("hidden")).toBe(true)
  })
})

describe("the Appearance tab", () => {
  const panel = (): Element | null =>
    document.querySelector('[role="tabpanel"][aria-labelledby$="appearance"]')

  it("comes second, and a URL naming it opens it", async () => {
    await show({ tab: "appearance" })

    expect(tabs().slice(0, 2)).toEqual(["Appearance", "General"])
    expect(selected()).toBe("Appearance")
  })

  it("holds the theme, the layout and the text, and no bell", async () => {
    await show({ tab: "appearance", notices: true })

    expect(panel()?.textContent).toContain("Theme")
    expect(panel()?.textContent).toContain("View modes")
    expect(panel()?.textContent).toContain("Text size")
    expect(panel()?.textContent).toContain("Ligatures")
    expect(panel()?.textContent).not.toContain("Bell")
    expect(panel()?.textContent).not.toContain("Hear it")
  })
})

describe("the General tab", () => {
  const panel = (): Element | null =>
    document.querySelector('[role="tabpanel"][aria-labelledby$="general"]')

  it("holds the notifications and the transcripts, and none of the text or agents", async () => {
    await show({
      tab: "general",
      transcripts: { enabled: true, available: true, onChange: () => {} },
      agents: { list: [], onChange: () => {} },
    })

    expect(panel()?.textContent).toContain("Notify when an agent needs you")
    expect(panel()?.textContent).toContain("Notify when an agent finishes")
    expect(panel()?.textContent).toContain("Transcripts")
    expect(panel()?.textContent).not.toContain("Text size")
    expect(panel()?.textContent).not.toContain("View modes")
  })

  it("holds no bell where the backend shows no desktop notifications", async () => {
    await show({ tab: "general" })

    expect(panel()?.textContent).not.toContain("Bell")
    expect(panel()?.textContent).not.toContain("Hear it")
  })

  it("holds the bell, led by the theme's own sound, where it does", async () => {
    await show({ tab: "general", notices: true })

    expect(panel()?.textContent).toContain("Ring the bell")
    expect(panel()?.textContent).toContain("Theme's bell (Felt)")
    expect(panel()?.textContent).toContain("Hear it")
  })

  it("names the sound of the theme in effect", async () => {
    await show({
      tab: "general",
      notices: true,
      value: {
        ...readPreferences(),
        appearance: { theme: "phosphor-green", scheme: "dark" },
      },
    })

    expect(panel()?.textContent).toContain("Theme's bell (Afterglow)")
  })
})

describe("coming from a row that needs an agent connected", () => {
  it("brings that agent's switch into view and focuses it, once", async () => {
    let done = 0
    const agent = (name: "claude" | "codex") => ({
      agent: name,
      available: true,
      connected: false,
      busy: false,
    })
    await show({
      tab: "agents",
      agents: { list: [agent("claude"), agent("codex")], onChange: () => {} },
      focusAgent: "codex",
      onFocusedAgent: () => done++,
    })
    const frames = async (left: number): Promise<void> => {
      if (left === 0) return
      await nextFrame()
      await frames(left - 1)
    }
    await frames(8)

    expect(document.activeElement?.getAttribute("aria-labelledby")).toBe("agent-codex")
    expect(done).toBe(1)
  })
})

describe("an agent that is not installed, in Preferences", () => {
  const command = "curl -fsSL https://claude.ai/install.sh | bash"
  const missing = {
    agent: "claude" as const,
    available: false,
    connected: false,
    busy: false,
    installer: command,
  }
  const install = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>("button[data-agent-install]")

  it("offers Install with its command in place of its switch", async () => {
    const asked: [string, string][] = []
    await show({
      tab: "agents",
      agents: {
        list: [missing],
        onChange: () => {},
        onInstall: (agent, given) => asked.push([agent, given]),
      },
    })

    expect(install()?.getAttribute("aria-label")).toBe("Install Claude Code")
    expect(document.getElementById("agent-claude-note")?.textContent).toContain(command)
    expect(document.querySelector('ul[aria-label="Agents"] [role=switch]')).toBeNull()
    install()?.click()
    expect(asked).toEqual([["claude", command]])
  })

  it("reads as installing, and takes no clicks, while its installer runs", async () => {
    let asked = 0
    await show({
      tab: "agents",
      agents: {
        list: [missing],
        onChange: () => {},
        onInstall: () => asked++,
        installing: new Set(["claude"]),
      },
    })

    expect(install()?.textContent).toBe("Installing…")
    // Still in the tab order, as a pending switch is.
    expect(install()?.getAttribute("aria-disabled")).toBe("true")
    expect(install()?.disabled).toBe(false)
    install()?.click()
    expect(asked).toBe(0)
  })

  it("keeps a disabled switch where nothing can install it", async () => {
    await show({ tab: "agents", agents: { list: [missing], onChange: () => {} } })

    expect(install()).toBeNull()
    expect(
      document.querySelector('ul[aria-label="Agents"] [role=switch]')?.hasAttribute("disabled"),
    ).toBe(true)
    expect(document.getElementById("agent-claude-note")?.textContent).toBe("Not installed")
  })

  it("is focused by its Install from a row that needs it connected", async () => {
    await show({
      tab: "agents",
      agents: { list: [missing], onChange: () => {}, onInstall: () => {} },
      focusAgent: "claude",
      onFocusedAgent: () => {},
    })
    await Array.from({ length: 8 }).reduce<Promise<void>>(
      (frames) => frames.then(nextFrame),
      Promise.resolve(),
    )

    expect(document.activeElement).toBe(install())
  })
})

describe("the forge integrations, in Preferences", () => {
  const forges = (on = true) => ({
    list: [{ forge: "github" as const, available: true, enabled: on, busy: false, hosts: [] }],
    onChange: () => {},
  })
  const panel = () => document.querySelector('[role="tabpanel"][aria-labelledby$="experimental"]')

  it("has a section under the Experimental switches where the backend has forges", async () => {
    await show({
      tab: "experimental",
      experimental: { on: true, onChange: () => {} },
      forges: forges(),
    })
    const section = panel()?.querySelector(
      'section[aria-labelledby="preferences-forge-integrations"]',
    )
    expect(section?.querySelector("h3")?.textContent).toBe("Forge integrations")
    expect(section?.querySelector('ul[aria-label="Forges"] [role=switch]')).not.toBeNull()
  })

  it("has none where the backend has none", async () => {
    await show({ tab: "experimental", experimental: { on: true, onChange: () => {} } })
    expect(panel()?.textContent).not.toContain("Forge integrations")
  })
})
