import { nextFrame, render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement, type ComponentProps } from "react"
import { afterEach, vi } from "vitest"

import { describe, eventually, expect, it } from "../test"
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
  it("opens Appearance, not the Addons page, when a URL names Addons", async () => {
    await show({})

    expect(tabs()).not.toContain("Addons")
    expect(selected()).toBe("Appearance")
    expect(document.querySelector('[role="tabpanel"][aria-labelledby$="addons"]')).toBeNull()
  })

  it("has no Addons tab for the chat view, which is in Appearance", async () => {
    await show({ chat: true })

    expect(tabs()).not.toContain("Addons")
    expect(selected()).toBe("Appearance")
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

      page.rerender(createElement(Preferences, props(true, "terminal")))
      await nextFrame()
      expect(brought).toEqual(["About", "Terminal"])
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

    expect(tabs().slice(0, 3)).toEqual(["Agents", "Appearance", "Terminal"])
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
    const notifications = document.querySelector(
      '[role="tabpanel"][aria-labelledby$="notifications"]',
    )
    expect(notifications?.textContent).not.toContain("Stop idle agents after")
    expect(notifications?.querySelector('ul[aria-label="Agents"]')).toBeNull()
  })

  it("is absent where the backend has neither agents nor a wait, and a URL naming it opens Appearance", async () => {
    await show({ tab: "agents" })

    expect(tabs()).not.toContain("Agents")
    expect(selected()).toBe("Appearance")
  })

  it("is there for the idle wait alone", async () => {
    await show({ tab: "agents", hibernation: { minutes: null, onChange: () => {} } })

    expect(selected()).toBe("Agents")
    expect(panel()?.textContent).toContain("Stop idle agents")
  })

  it("stops idle agents with a switch, its wait beside it only while on", async () => {
    const changes: (number | null)[] = []
    const idleSwitch = (): HTMLElement | null =>
      document.querySelector('[role="switch"][aria-labelledby="idle-agents-label"]')
    await show({
      tab: "agents",
      hibernation: { minutes: 30, onChange: (minutes) => changes.push(minutes) },
    })
    expect(idleSwitch()?.getAttribute("aria-checked")).toBe("true")
    expect(panel()?.querySelector('[role="combobox"]')).not.toBeNull()
    idleSwitch()?.click()
    mounted.splice(0).forEach((page) => page.unmount())

    await show({
      tab: "agents",
      hibernation: { minutes: null, onChange: (minutes) => changes.push(minutes) },
    })
    expect(idleSwitch()?.getAttribute("aria-checked")).toBe("false")
    expect(panel()?.querySelector('[role="combobox"]')).toBeNull()
    idleSwitch()?.click()
    // Off, then on again with an hour, the wait it starts with.
    expect(changes).toEqual([null, 60])
  })

  const worktreesSwitch = (): HTMLElement | null =>
    document.querySelector('[role="switch"][aria-labelledby="agent-worktrees-label"]')

  it("holds the agent worktrees switch, on as the backend says, which writes its setting", async () => {
    const changes: boolean[] = []
    await show({
      tab: "agents",
      worktrees: { enabled: true, onChange: (enabled) => changes.push(enabled) },
    })

    expect(selected()).toBe("Agents")
    expect(worktreesSwitch()?.closest('[role="tabpanel"]')).toBe(panel())
    expect(worktreesSwitch()?.getAttribute("aria-checked")).toBe("true")
    worktreesSwitch()?.click()
    expect(changes).toEqual([false])
  })

  const keepMainSwitch = (): HTMLElement | null =>
    document.querySelector('[role="switch"][aria-labelledby="keep-main-label"]')

  it("holds the Keep main current switch beside the worktrees one, each apart from the other", async () => {
    const changes: boolean[] = []
    await show({
      tab: "agents",
      worktrees: { enabled: false, onChange: () => {} },
      keepMain: { enabled: true, onChange: (enabled) => changes.push(enabled) },
    })
    expect(keepMainSwitch()?.closest('[role="tabpanel"]')).toBe(panel())
    expect(keepMainSwitch()?.getAttribute("aria-checked")).toBe("true")
    expect(worktreesSwitch()?.getAttribute("aria-checked")).toBe("false")
    keepMainSwitch()?.click()
    expect(changes).toEqual([false])
    mounted.splice(0).forEach((page) => page.unmount())

    // With no worktrees switch at all, it still stands on its own.
    await show({ tab: "agents", keepMain: { enabled: false, onChange: () => {} } })
    expect(worktreesSwitch()).toBeNull()
    expect(keepMainSwitch()?.getAttribute("aria-checked")).toBe("false")
  })

  it("says the Files card has the command to run, not an Update button", async () => {
    await show({ tab: "agents", keepMain: { enabled: true, onChange: () => {} } })
    const text = keepMainSwitch()?.closest("[role=tabpanel]")?.textContent ?? ""
    expect(text).toContain("with the command to run it")
    expect(text).not.toContain("Update button")
  })

  it("leaves Keep main current out where the backend has no such switch", async () => {
    await show({ tab: "agents", worktrees: { enabled: true, onChange: () => {} } })
    expect(keepMainSwitch()).toBeNull()
  })

  it("leaves agent worktrees out where the backend has none, and out of Experimental", async () => {
    await show({ tab: "agents", hibernation: { minutes: 60, onChange: () => {} } })
    expect(worktreesSwitch()).toBeNull()
    mounted.splice(0).forEach((page) => page.unmount())

    await show({
      tab: "experimental",
      experimental: experimental(true),
      worktrees: { enabled: true, onChange: () => {} },
    })
    const experimentalPanel = document.querySelector(
      '[role="tabpanel"][aria-labelledby$="experimental"]',
    )
    expect(experimentalPanel?.textContent).not.toContain("Agent worktrees")
  })
})

const experimental = (on: boolean | undefined, revealed = false) => ({
  on,
  onChange: () => {},
  revealed,
  onReveal: () => {},
})

describe("the Agents work as choice", () => {
  const panel = (): Element | null =>
    document.querySelector('[role="tabpanel"][aria-labelledby$="agents"]')
  const modes = (): HTMLInputElement[] => [
    ...document.querySelectorAll<HTMLInputElement>(
      '[role="radiogroup"][aria-label="Agents work as"] input[type="radio"]',
    ),
  ]
  const radio = (label: "Solo" | "Herd" | "Swarm"): HTMLInputElement | null =>
    modes().find((input) => input.getAttribute("aria-label") === label) ?? null
  const map = (): Element | null => document.querySelector('[role="img"][data-mode]')
  // The segment a person clicks: the hidden input's label.
  const segment = (label: "Solo" | "Herd" | "Swarm"): HTMLElement | null =>
    radio(label)?.closest("label") ?? null

  it("offers Solo, Herd and Swarm on the Agents tab, with Herd chosen", async () => {
    await show({
      tab: "agents",
      experimental: experimental(true),
      agentModes: { enabled: true, onChange: () => {} },
      agentMode: { mode: "herd", onChange: () => {} },
    })

    expect(selected()).toBe("Agents")
    expect(panel()?.textContent).toContain("Agents work as")
    expect(modes().map((input) => input.getAttribute("aria-label"))).toEqual([
      "Solo",
      "Herd",
      "Swarm",
    ])
    expect(radio("Herd")?.checked).toBe(true)
    expect(radio("Solo")?.checked).toBe(false)
    expect(radio("Swarm")?.checked).toBe(false)
  })

  it("says only what the picked mode does, beside its map", async () => {
    await show({
      tab: "agents",
      experimental: experimental(true),
      agentModes: { enabled: true, onChange: () => {} },
      agentMode: { mode: "herd", onChange: () => {} },
    })

    expect(panel()?.textContent).toContain("Best when you run several agents side by side.")
    expect(panel()?.textContent).not.toContain("steer each yourself")
    expect(panel()?.textContent).not.toContain("more of your usage")
    expect(map()?.getAttribute("data-mode")).toBe("herd")
    expect(map()?.getAttribute("aria-label")).toContain("@owl tells @fern it holds port 5173")
  })

  it("says Swarm's cost with Swarm", async () => {
    await show({
      tab: "agents",
      experimental: experimental(true),
      agentModes: { enabled: true, onChange: () => {} },
      agentMode: { mode: "swarm", onChange: () => {} },
    })

    expect(panel()?.textContent).toContain("Agents open, lead and close agents without asking.")
    expect(panel()?.textContent).toContain("More agents running, and more of your usage.")
    expect(map()?.getAttribute("data-mode")).toBe("swarm")
  })

  it("says Solo keeps overlaps with you", async () => {
    await show({
      tab: "agents",
      experimental: experimental(true),
      agentModes: { enabled: true, onChange: () => {} },
      agentMode: { mode: "solo", onChange: () => {} },
    })

    expect(panel()?.textContent).toContain("Overlaps between agents come to you.")
    expect(panel()?.textContent).not.toContain("without asking")
    expect(map()?.getAttribute("data-mode")).toBe("solo")
  })

  it("saves the mode picked", async () => {
    const changes: string[] = []
    await show({
      tab: "agents",
      experimental: experimental(true),
      agentModes: { enabled: true, onChange: () => {} },
      agentMode: { mode: "herd", onChange: (mode) => changes.push(mode) },
    })

    // The segment group tells of a pick a moment after the click.
    act(() => segment("Solo")!.click())
    await eventually(() => expect(changes).toEqual(["solo"]))
    act(() => segment("Swarm")!.click())
    await eventually(() => expect(changes).toEqual(["solo", "swarm"]))
  })

  it("hides the choice while the Agent modes switch is off, or the Experimental tab is not there", async () => {
    await show({
      tab: "agents",
      experimental: experimental(true),
      agentModes: { enabled: false, onChange: () => {} },
      agentMode: { mode: "solo", onChange: () => {} },
    })
    expect(radio("Solo")).toBeNull()
    expect(document.body.textContent).not.toContain("Agents work as")
    mounted.splice(0).forEach((page) => page.unmount())

    await show({
      tab: "agents",
      agentModes: { enabled: true, onChange: () => {} },
      agentMode: { mode: "solo", onChange: () => {} },
    })
    expect(radio("Solo")).toBeNull()
  })

  const modesSwitch = (): HTMLElement | null =>
    document.querySelector('[role="switch"][aria-labelledby="agent-modes-label"]')

  it("holds the Agent modes switch in the Experimental tab, which writes the backend's setting", async () => {
    const changes: boolean[] = []
    await show({
      tab: "experimental",
      experimental: experimental(true),
      agentModes: { enabled: false, onChange: (enabled) => changes.push(enabled) },
    })
    expect(modesSwitch()?.getAttribute("aria-checked")).toBe("false")
    modesSwitch()?.click()
    expect(changes).toEqual([true])
    expect(document.getElementById("agent-modes-description")?.textContent).toContain("Solo")
  })

  it("says the Agent modes are not available where the backend has none", async () => {
    await show({ tab: "experimental", experimental: experimental(true) })
    expect(modesSwitch()?.getAttribute("aria-checked")).toBe("false")
    expect(document.getElementById("agent-modes-description")?.textContent).toBe(
      "Not available here.",
    )
  })
})

describe("the Nova row", () => {
  const novaSwitch = (): HTMLElement | null =>
    document.querySelector('[role="switch"][aria-labelledby="nova-label"]')
  const note = (): HTMLElement | null => document.querySelector('[data-experimental-note="nova"]')

  it("isn't there where the runner has no such switch, as one from before revision 16", async () => {
    await show({ tab: "experimental", experimental: experimental(true) })
    expect(document.getElementById("nova-label")).toBeNull()
  })

  it("writes the backend's setting, and says what it costs", async () => {
    const changes: boolean[] = []
    await show({
      tab: "experimental",
      experimental: experimental(true),
      nova: {
        enabled: false,
        fetch: { state: "off" },
        onChange: (enabled) => changes.push(enabled),
      },
    })
    expect(document.getElementById("nova-label")?.textContent).toBe("Nova")
    expect(document.getElementById("nova-description")?.textContent).toContain("50–60 MB")
    expect(note()).toBeNull()
    novaSwitch()?.click()
    expect(changes).toEqual([true])
  })

  it("says nothing of the tour where the backend has none", async () => {
    const nova = { enabled: false, fetch: { state: "off" } as const, onChange: () => {} }
    await show({ tab: "experimental", experimental: experimental(true), nova })
    expect(document.getElementById("nova-description")?.textContent).not.toContain("tour")
  })

  it("offers the tour too, where the backend has one", async () => {
    const nova = { enabled: false, fetch: { state: "off" } as const, onChange: () => {} }
    await show({ tab: "experimental", experimental: experimental(true), nova, tour: true })
    expect(document.getElementById("nova-description")?.textContent).toContain(
      "It also adds a Help menu to the footer, with a short tour",
    )
    expect(document.getElementById("nova-description")?.textContent).toContain(
      "nova doesn't start, nor the tour.",
    )
  })

  it("says where the download stands, and offers to try a failed one again", async () => {
    const changes: boolean[] = []
    await show({
      tab: "experimental",
      experimental: experimental(true),
      nova: {
        enabled: true,
        fetch: { state: "failed", error: "Couldn't reach github.com. Check your connection." },
        onChange: (enabled) => changes.push(enabled),
      },
    })
    expect(note()?.getAttribute("role")).toBe("alert")
    expect(note()?.textContent).toContain("Couldn't reach github.com.")
    // The switch is described by its note too.
    expect(novaSwitch()?.getAttribute("aria-describedby")).toBe("nova-description nova-note")
    const retry = [...(note()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Try again",
    )
    retry?.click()
    expect(changes).toEqual([true])
  })
})

describe("the Murmur row", () => {
  const murmurSwitch = (): HTMLElement | null =>
    document.querySelector('[role="switch"][aria-labelledby="murmur-label"]')

  it("isn't there where the backend has no such switch, as a runner from before revision 20", async () => {
    await show({ tab: "experimental", experimental: experimental(true) })
    expect(document.getElementById("murmur-label")).toBeNull()
  })

  it("writes the backend's setting, and says what turning it on brings", async () => {
    const changes: boolean[] = []
    await show({
      tab: "experimental",
      experimental: experimental(true),
      murmurSwitch: { enabled: false, onChange: (enabled) => changes.push(enabled) },
    })
    expect(document.getElementById("murmur-label")?.textContent).toBe("Murmur")
    expect(document.getElementById("murmur-description")?.textContent).toContain("Addons page")
    expect(murmurSwitch()?.getAttribute("aria-checked")).toBe("false")
    murmurSwitch()?.click()
    expect(changes).toEqual([true])
  })
})

describe("Keep awake", () => {
  it("has no Experimental row where the app can't keep the computer awake, as in a browser", async () => {
    await show({ tab: "experimental", experimental: experimental(true) })
    expect(document.getElementById("keep-awake-label")).toBeNull()
  })

  it("is offered in the Experimental tab, and turning it on adds its switch to the Agents page", async () => {
    const changes: boolean[] = []
    await show({
      tab: "experimental",
      experimental: experimental(true),
      awake: true,
      onChange: (next) => changes.push(next.keepAwakeOffered),
    })
    expect(document.getElementById("keep-awake-label")?.textContent).toBe("Keep awake")
    expect(document.getElementById("keep-awake-description")?.textContent).toContain("Agents page")
    document
      .querySelector<HTMLElement>('[role="switch"][aria-labelledby="keep-awake-label"]')
      ?.click()
    expect(changes).toEqual([true])
  })

  it("shows its switch on the Agents page, on by default and badged, only while the Experimental row is on", async () => {
    const changes: boolean[] = []
    await show({
      tab: "agents",
      experimental: experimental(true),
      awake: true,
      value: { ...readPreferences(), keepAwakeOffered: true },
      onChange: (next) => changes.push(next.keepAwake),
    })
    const general = document.querySelector<HTMLElement>(
      '[role="switch"][aria-labelledby="awake-label"]',
    )
    expect(document.getElementById("awake-label")?.textContent).toBe("Keep awake while agents work")
    expect(general?.getAttribute("aria-checked")).toBe("true")
    expect(general?.closest(".preference-row")?.textContent).toContain("Experimental")
    general?.click()
    expect(changes).toEqual([false])
  })

  it("has no switch on the Agents page while the Experimental row is off, or Experimental itself is", async () => {
    await show({ tab: "agents", experimental: experimental(true), awake: true })
    expect(document.getElementById("awake-label")).toBeNull()
    for (const page of mounted.splice(0)) page.unmount()
    await show({
      tab: "agents",
      experimental: experimental(false),
      awake: true,
      value: { ...readPreferences(), keepAwakeOffered: true },
    })
    expect(document.getElementById("awake-label")).toBeNull()
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

  it("is Appearance where the backend has no agents", async () => {
    await show({ tab: null })

    expect(tabs()).not.toContain("Agents")
    expect(selected()).toBe("Appearance")
  })

  it("is the page the URL names, though Agents is first", async () => {
    await show({ tab: "terminal", agents: { list: [agent], onChange: () => {} } })

    expect(selected()).toBe("Terminal")
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
    expect(selected()).toBe("Appearance")
  })

  it("holds the version, the Experimental switch and the logs, which Notifications doesn't", async () => {
    await show({
      tab: "about",
      version: "0.4.2",
      logs: () => {},
      experimental: experimental(false, true),
    })

    expect(selected()).toBe("About")
    const panel = document.querySelector('[role="tabpanel"][aria-labelledby$="about"]')
    expect(panel?.textContent).toContain("0.4.2")
    expect(
      panel?.querySelector('[role="switch"][aria-labelledby="experimental-label"]'),
    ).not.toBeNull()
    expect(panel?.textContent).toContain("Open logs folder")
    const notifications = document.querySelector(
      '[role="tabpanel"][aria-labelledby$="notifications"]',
    )
    expect(notifications?.textContent).not.toContain("0.4.2")
    expect(notifications?.textContent).not.toContain("Experimental")
  })
})

describe("the hidden Experimental switch", () => {
  const panel = (): Element | null =>
    document.querySelector('[role="tabpanel"][aria-labelledby$="about"]')
  const toggle = (): Element | null | undefined =>
    panel()?.querySelector('[role="switch"][aria-labelledby="experimental-label"]')
  const versionText = (): HTMLElement | null =>
    [...(panel()?.querySelectorAll<HTMLElement>("dd") ?? [])].find(
      (each) => each.textContent === "0.4.2",
    ) ?? null
  const hint = (): string => panel()?.querySelector('[role="status"]')?.textContent ?? ""
  const tap = async (times: number): Promise<void> => {
    for (let at = 0; at < times; at += 1)
      // eslint-disable-next-line no-await-in-loop -- Each tap after the one before.
      await act(() => versionText()?.click())
  }

  it("is hidden while off, until the version is tapped ten times, counting the last taps down", async () => {
    let reveals = 0
    await show({
      tab: "about",
      version: "0.4.2",
      experimental: { ...experimental(false), onReveal: () => (reveals += 1) },
    })

    expect(toggle()).toBeNull()
    expect(panel()?.textContent).not.toContain("Experimental")
    await tap(4)
    expect(hint()).toBe("")
    await tap(1)
    expect(hint()).toBe("Tap 5 more times to show Experimental")
    await tap(4)
    expect(hint()).toBe("Tap once more to show Experimental")
    expect(reveals).toBe(0)
    await tap(1)
    expect(reveals).toBe(1)
    expect(hint()).toBe("")
  })

  it("shows while on, and while off once revealed, where tapping counts nothing", async () => {
    let reveals = 0
    const onReveal = (): void => void (reveals += 1)
    await show({
      tab: "about",
      version: "0.4.2",
      experimental: { ...experimental(true), onReveal },
    })
    expect(toggle()?.getAttribute("aria-checked")).toBe("true")
    await tap(10)
    expect(hint()).toBe("")
    expect(reveals).toBe(0)
    mounted.splice(0).forEach((page) => page.unmount())

    await show({
      tab: "about",
      version: "0.4.2",
      experimental: { ...experimental(false, true), onReveal },
    })
    expect(toggle()?.getAttribute("aria-checked")).toBe("false")
  })
})

describe("the Experimental tab", () => {
  it("is absent while the Experimental switch is off, and a URL naming it opens Appearance", async () => {
    await show({ tab: "experimental", experimental: experimental(false) })

    expect(tabs()).not.toContain("Experimental")
    expect(selected()).toBe("Appearance")
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
      panel?.querySelector('[role="switch"][aria-labelledby$="agent-avatars-label"]'),
    ).not.toBeNull()
  })

  it("holds the shipping gate switch, which writes the backend's setting", async () => {
    const changes: boolean[] = []
    await show({
      tab: "experimental",
      experimental: experimental(true),
      shippingGate: { enabled: false, onChange: (enabled) => changes.push(enabled) },
    })
    const gate = document.querySelector('[role="switch"][aria-labelledby="shipping-gate-label"]')
    expect(gate?.getAttribute("aria-checked")).toBe("false")
    ;(gate as HTMLElement).click()
    expect(changes).toEqual([true])
  })
})

describe("the Appearance tab", () => {
  const panel = (): Element | null =>
    document.querySelector('[role="tabpanel"][aria-labelledby$="appearance"]')

  it("comes second, and a URL naming it opens it", async () => {
    await show({ tab: "appearance" })

    expect(tabs().slice(0, 2)).toEqual(["Appearance", "Terminal"])
    expect(selected()).toBe("Appearance")
  })

  it("holds the theme, the scale and the layout, and neither the text nor a bell", async () => {
    await show({ tab: "appearance", notices: true, scalable: true })

    expect(panel()?.textContent).toContain("Theme")
    expect(panel()?.textContent).toContain("Scale")
    expect(panel()?.textContent).toContain("View modes")
    expect(panel()?.textContent).not.toContain("Text size")
    expect(panel()?.textContent).not.toContain("Bell")
    expect(panel()?.textContent).not.toContain("Hear it")
  })

  it("holds Scale under Size, apart from the theme", async () => {
    await show({ tab: "appearance", scalable: true })

    const size = panel()?.querySelector('section[aria-labelledby="preferences-size"]')
    expect(size?.textContent).toContain("Scale")
    const theme = panel()?.querySelector('section[aria-labelledby="preferences-theme"]')
    expect(theme?.textContent).not.toContain("Scale")
  })
})

describe("the Terminal page", () => {
  const panel = (): Element | null =>
    document.querySelector('[role="tabpanel"][aria-labelledby$="terminal"]')

  it("holds the text, screen reader support and the transcripts", async () => {
    await show({
      tab: "terminal",
      transcripts: { enabled: true, available: true, onChange: () => {} },
    })

    expect(selected()).toBe("Terminal")
    expect(panel()?.textContent).toContain("Text size")
    expect(panel()?.textContent).toContain("Terminal font")
    expect(panel()?.textContent).toContain("Ligatures")
    expect(panel()?.textContent).toContain("Screen reader support")
    expect(panel()?.textContent).toContain("Keep recent output")
    expect(panel()?.textContent).not.toContain("View modes")
  })

  it("offers screen reader support as three choices where the app can tell, else a switch", async () => {
    await show({ tab: "terminal", screenReaderKnown: true })
    const choices = [...(panel()?.querySelectorAll('[role="radiogroup"] input') ?? [])]
    expect(choices.map((choice) => choice.getAttribute("aria-label"))).toEqual([
      "Automatic",
      "On",
      "Off",
    ])
    mounted.splice(0).forEach((page) => page.unmount())

    await show({ tab: "terminal" })
    expect(
      panel()?.querySelector('[role="switch"][aria-labelledby="screen-reader-label"]'),
    ).not.toBeNull()
  })

  it("draws a sample of the terminal text in the size and font set", async () => {
    await show({ tab: "terminal", value: { ...readPreferences(), fontSize: 21 } })

    const sample = panel()?.querySelector<HTMLElement>(".settings-sample pre")
    expect(sample?.style.fontSize).toBe("21px")
    expect(sample?.style.fontFamily).toContain("JetBrains Mono")
    expect(sample?.closest("[aria-hidden]")?.getAttribute("aria-hidden")).toBe("true")
    expect(panel()?.querySelector(".settings-sample-caption")?.textContent).toContain("21px")
  })
})

describe("the Notifications page", () => {
  const panel = (): Element | null =>
    document.querySelector('[role="tabpanel"][aria-labelledby$="notifications"]')

  it("holds the notifications, and none of the text, agents or transcripts", async () => {
    await show({
      tab: "notifications",
      transcripts: { enabled: true, available: true, onChange: () => {} },
      agents: { list: [], onChange: () => {} },
    })

    expect(panel()?.textContent).toContain("When an agent needs you")
    expect(panel()?.textContent).toContain("When an agent is done")
    expect(panel()?.textContent).not.toContain("Keep recent output")
    expect(panel()?.textContent).not.toContain("Text size")
    expect(panel()?.textContent).not.toContain("View modes")
  })

  it("holds no bell where the backend shows no desktop notifications", async () => {
    await show({ tab: "notifications" })

    expect(panel()?.textContent).not.toContain("Bell")
    expect(panel()?.textContent).not.toContain("Hear it")
  })

  it("holds the bell, led by the theme's own sound, where it does", async () => {
    await show({ tab: "notifications", notices: true })

    expect(panel()?.textContent).toContain("Ring the bell")
    expect(panel()?.textContent).toContain("Theme's bell (Felt)")
    expect(panel()?.textContent).toContain("Hear it")
  })

  it("names the sound of the theme in effect", async () => {
    await show({
      tab: "notifications",
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

describe("a choice with words under it", () => {
  it("reads them with its select", async () => {
    await show({ tab: "appearance", scalable: true })

    const trigger = [...document.querySelectorAll('[role="combobox"]')].find((each) =>
      document
        .getElementById(each.getAttribute("aria-labelledby") ?? "")
        ?.textContent?.includes("Scale"),
    )
    const described = document.getElementById(trigger?.getAttribute("aria-describedby") ?? "")
    expect(described?.textContent).toContain("Terminal text has its own size")
  })
})

describe("the forges, in Preferences", () => {
  const forges = () => ({
    list: [{ forge: "github" as const, available: true, enabled: true, busy: false, hosts: [] }],
  })
  const agentsPanel = () => document.querySelector('[role="tabpanel"][aria-labelledby$="agents"]')
  const section = () =>
    agentsPanel()?.querySelector(
      'section[aria-labelledby="preferences-worktrees-and-pull-requests"]',
    )
  const list = () => section()?.querySelector('ul[aria-label="Forges"]')

  it("are rows with no switch under Agents, beside agent worktrees, where the backend has forges", async () => {
    await show({
      tab: "agents",
      forges: forges(),
      worktrees: { enabled: true, onChange: () => {} },
    })
    expect(selected()).toBe("Agents")
    expect(section()?.querySelector("h3")?.textContent).toBe("Worktrees and pull requests")
    expect(section()?.textContent).toContain("Agent worktrees")
    expect(list()?.querySelector("li")).not.toBeNull()
    expect(list()?.querySelector('[role="switch"]')).toBeNull()
  })

  it("go with agent worktrees, whose panel shows the pull requests, and aren't in Experimental", async () => {
    await show({
      tab: "agents",
      forges: forges(),
      worktrees: { enabled: false, onChange: () => {} },
    })
    expect(list()).toBeNull()
    mounted.splice(0).forEach((page) => page.unmount())

    await show({ tab: "experimental", experimental: experimental(true), forges: forges() })
    const experimentalPanel = document.querySelector(
      '[role="tabpanel"][aria-labelledby$="experimental"]',
    )
    expect(experimentalPanel?.textContent).not.toContain("Pull requests")
    expect(experimentalPanel?.querySelector('ul[aria-label="Forges"]')).toBeNull()
  })

  it("are absent where the backend has none", async () => {
    await show({ tab: "agents", worktrees: { enabled: true, onChange: () => {} } })
    expect(section()).not.toBeNull()
    expect(list()).toBeNull()
  })
})

describe("searching Preferences", () => {
  const field = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('input[aria-label="Search preferences"]')!
  const type = async (text: string): Promise<void> => {
    await act(async () => {
      const input = field()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  const results = (): string[] =>
    [...document.querySelectorAll(".preferences-result")].map(
      (result) => result.firstElementChild?.textContent ?? "",
    )

  it("lists the settings of every page that match, in place of the pages", async () => {
    await show({ tab: "appearance", notices: true })
    await type("bell")

    expect(results()).toContain("Ring the bell")
    expect(document.querySelector('[role="tablist"]')?.closest("[hidden]")).not.toBeNull()
  })

  it("says so where nothing matches", async () => {
    await show({ tab: "appearance" })
    await type("zebra")

    expect(results()).toEqual([])
    expect(document.body.textContent).toContain("Nothing matches “zebra”.")
  })

  it("takes the search away on Escape, and leaves Preferences open", async () => {
    let closed = 0
    await show({ tab: "appearance", notices: true, onClose: () => (closed += 1) })
    await type("bell")
    await act(async () => {
      field().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      )
    })

    expect(field().value).toBe("")
    expect(results()).toEqual([])
    expect(closed).toBe(0)
  })

  it("focuses the control of the row it opens", async () => {
    // Opening a page rerenders on it, as the app's route does.
    const props = (tab: ComponentProps<typeof Preferences>["tab"]) => ({
      open: true,
      tab,
      notices: true,
      value: readPreferences(),
      onChange: () => {},
      onClose: () => {},
      onTabChange: (next: ComponentProps<typeof Preferences>["tab"]) =>
        page.rerender(createElement(Preferences, props(next))),
    })
    const page = render(createElement(Preferences, props("appearance")))
    mounted.push(page)
    await nextFrame()
    await type("ring the bell")
    await act(async () => (document.querySelector(".preferences-result") as HTMLElement).click())
    await nextFrame()

    expect(document.activeElement?.getAttribute("role")).toBe("switch")
    expect(document.activeElement?.closest(".settings-row")?.textContent).toContain("Ring the bell")
  })

  it("focuses a card's switch over the choice beside it", async () => {
    const props = (tab: ComponentProps<typeof Preferences>["tab"]) => ({
      open: true,
      tab,
      hibernation: { minutes: 30, onChange: () => {} },
      value: readPreferences(),
      onChange: () => {},
      onClose: () => {},
      onTabChange: (next: ComponentProps<typeof Preferences>["tab"]) =>
        page.rerender(createElement(Preferences, props(next))),
    })
    const page = render(createElement(Preferences, props("appearance")))
    mounted.push(page)
    await nextFrame()
    await type("stop idle")
    await act(async () => (document.querySelector(".preferences-result") as HTMLElement).click())
    await nextFrame()

    expect(document.activeElement?.getAttribute("aria-labelledby")).toBe("idle-agents-label")
  })

  it("focuses the chosen option of a set it opens, not the first", async () => {
    const props = (tab: ComponentProps<typeof Preferences>["tab"]) => ({
      open: true,
      tab,
      chat: true,
      value: { ...readPreferences(), chatView: false },
      onChange: () => {},
      onClose: () => {},
      onTabChange: (next: ComponentProps<typeof Preferences>["tab"]) =>
        page.rerender(createElement(Preferences, props(next))),
    })
    const page = render(createElement(Preferences, props("terminal")))
    mounted.push(page)
    await nextFrame()
    await type("show agents as")
    await act(async () => (document.querySelector(".preferences-result") as HTMLElement).click())
    await nextFrame()

    const focused = document.activeElement as HTMLInputElement | null
    expect(focused?.type).toBe("radio")
    expect(focused?.checked).toBe(true)
    expect(focused?.closest("label")?.textContent).toContain("Terminal")
  })

  it("finds a switch only the Experimental page has there, and one that stands on its page once", async () => {
    await show({
      tab: "appearance",
      experimental: experimental(true),
      murmurSwitch: { enabled: false, onChange: () => {} },
    })
    await type("murmur")
    expect(results()).toContain("Murmur")
    await type("agent avatars")
    expect(results()).toEqual(["Agent avatars"])
    expect(document.querySelector(".preferences-result")?.textContent).toContain("Appearance")
  })

  it("reads the pages again as a setting changes under the results", async () => {
    const props = (sound: boolean) => ({
      open: true,
      tab: "notifications" as const,
      notices: true,
      value: { ...readPreferences(), sound },
      onChange: () => {},
      onClose: () => {},
      onTabChange: () => {},
    })
    const page = render(createElement(Preferences, props(true)))
    mounted.push(page)
    await nextFrame()
    await type("volume")
    expect(results()).toEqual(["Volume"])

    await act(async () => page.rerender(createElement(Preferences, props(false))))
    await eventually(() => expect(results()).toEqual([]))
  })

  it("is focused by / from a slider, as from any control that doesn't type", async () => {
    await show({ tab: "terminal" })
    const slider = document.querySelector<HTMLInputElement>('input[type="range"]')!
    slider.focus()
    await act(async () => {
      slider.dispatchEvent(
        new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }),
      )
    })
    expect(document.activeElement).toBe(field())
  })

  it("opens a match's page, and shows the pages again", async () => {
    const opened: string[] = []
    await show({ tab: "appearance", notices: true, onTabChange: (tab) => opened.push(tab) })
    await type("ring the bell")
    await act(async () => (document.querySelector(".preferences-result") as HTMLElement).click())

    expect(opened).toEqual(["notifications"])
    expect(field().value).toBe("")
    expect(results()).toEqual([])
  })
})

describe("an Experimental feature, while Experimental is on", () => {
  const panel = (page: string): Element | null =>
    document.querySelector(`[role="tabpanel"][aria-labelledby$="${page}"]`)

  it("stands on its own page, marked Experimental", async () => {
    await show({ tab: "appearance", experimental: experimental(true) })

    const row = panel("appearance")
      ?.querySelector('[role="switch"][aria-labelledby="agent-avatars-label"]')
      ?.closest(".settings-row")
    expect(row?.querySelector(".settings-badge")?.textContent).toBe("Experimental")
  })

  it("is listed on the Experimental page with the page it's on, which it opens", async () => {
    const opened: string[] = []
    await show({
      tab: "experimental",
      experimental: experimental(true),
      onTabChange: (tab) => opened.push(tab),
    })

    const row = panel("experimental")
      ?.querySelector('[role="switch"][aria-labelledby="index-agent-avatars-label"]')
      ?.closest(".settings-row")
    const goTo = [...(row?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "On Appearance",
    )
    goTo?.click()
    expect(opened).toEqual(["appearance"])
  })

  it("leaves focus on the switch on the page it opens", async () => {
    const props = (tab: ComponentProps<typeof Preferences>["tab"]) => ({
      open: true,
      tab,
      experimental: experimental(true),
      value: readPreferences(),
      onChange: () => {},
      onClose: () => {},
      onTabChange: (next: ComponentProps<typeof Preferences>["tab"]) =>
        page.rerender(createElement(Preferences, props(next))),
    })
    const page = render(createElement(Preferences, props("experimental")))
    mounted.push(page)
    await nextFrame()
    const goTo = [...document.querySelectorAll<HTMLElement>("button")].find(
      (button) => button.textContent === "On Appearance",
    )
    await act(async () => goTo?.click())
    await nextFrame()

    expect(document.activeElement?.getAttribute("aria-labelledby")).toBe("agent-avatars-label")
  })

  it("offers no way to a page Preferences doesn't show", async () => {
    await show({
      tab: "experimental",
      experimental: experimental(true),
      murmurSwitch: { enabled: false, onChange: () => {} },
    })

    expect(document.body.textContent).toContain("Murmur")
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent === "On Addons"),
    ).toBe(false)
  })

  it("is on no page while Experimental is off", async () => {
    await show({ tab: "appearance", experimental: experimental(false) })

    expect(document.querySelector('[aria-labelledby$="agent-avatars-label"]')).toBeNull()
  })
})
