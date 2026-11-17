import { afterEach } from "vitest"
import { page, type Locator } from "vitest/browser"

import { openPreferencesOn, preferencesDialog } from "../support/keyboard"
import { expectSelected, openWorkspace, terminalTabNames } from "../support/workspace"
import { context, describe, expect, it } from "../test"

const welcome = (): Locator => page.getByRole("dialog", { name: "Welcome to Novadeck" })

const installButton = (name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  welcome().getByRole("button", { name: `Install ${name}` })

const agentSwitch = (name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  preferencesDialog().getByRole("switch", { name })

const preferencesInstall = (name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  preferencesDialog().getByRole("button", { name: `Install ${name}` })

afterEach(() => sessionStorage.removeItem("novadeck.installs"))

// The demo's install takes a few seconds to end.
const installTime = { timeout: 10_000 }

describe("An agent that is not installed, in the welcome dialog", () => {
  it("offers to install it, with the command that will run, in place of its checkbox", async () => {
    await openWorkspace("/?demo=welcome")
    await expect.element(installButton("Antigravity")).toBeVisible()
    await expect
      .element(installButton("Antigravity"))
      .toHaveAccessibleDescription(
        /Not installed\. Install runs curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/,
      )
    expect(welcome().getByRole("checkbox", { name: "Antigravity" }).query()).toBeNull()
    // The ones that are installed keep their checkboxes, with no install offered.
    await expect.element(welcome().getByRole("checkbox", { name: "Claude Code" })).toBeChecked()
    expect(installButton("Claude Code").query()).toBeNull()
  })

  context("when Install is pressed", () => {
    const finish = (): Promise<void> =>
      welcome().getByRole("button", { name: "Let’s build something" }).click()

    it("installs in a terminal behind the dialog, which stays open and shows the install running", async () => {
      await openWorkspace("/?demo=welcome")
      await installButton("Antigravity").click()
      await expect.element(welcome()).toBeVisible()
      await expect
        .element(welcome().getByRole("button", { name: "Install Antigravity" }))
        .toHaveAttribute("aria-disabled", "true")
      await expect
        .element(welcome().getByText("Installing in a terminal of its own…"))
        .toBeVisible()
      // Focus stays in the dialog.
      expect(welcome().element().contains(document.activeElement)).toBe(true)
    })

    it("shows the agent as a ticked choice once it is installed, and connects it as the dialog finishes", async () => {
      await openWorkspace("/?demo=welcome")
      await installButton("Antigravity").click()
      await expect
        .element(welcome().getByRole("checkbox", { name: "Antigravity" }), installTime)
        .toBeChecked()
      expect(installButton("Antigravity").query()).toBeNull()
      expect(welcome().element().contains(document.activeElement)).toBe(true)
      await finish()
      await expect.element(welcome()).not.toBeInTheDocument()
      await openPreferencesOn("Agents")
      await expect.element(agentSwitch("Antigravity")).toHaveAttribute("aria-checked", "true")
    })

    it("keeps focus in the dialog while the new agent connects, its choice busy but focusable", async () => {
      await openWorkspace("/?demo=welcome&agentConnect=slow")
      await installButton("Antigravity").click()
      const choice = welcome().getByRole("checkbox", { name: "Antigravity" })
      await expect.element(choice, installTime).toBeChecked()
      // Busy: connecting, so it reads as disabled while focus stays.
      await expect.element(choice).toHaveAttribute("aria-disabled", "true")
      expect(welcome().element().contains(document.activeElement)).toBe(true)
      await expect.element(choice, installTime).not.toHaveAttribute("aria-disabled")
      expect(welcome().element().contains(document.activeElement)).toBe(true)
    })

    it("lets the person finish while it installs, applying the other choices, and the install carries on", async () => {
      await openWorkspace("/?demo=welcome&agentInstall=held")
      await welcome().getByRole("checkbox", { name: "Codex" }).click()
      await installButton("Antigravity").click()
      await expect
        .element(welcome().getByRole("button", { name: "Install Antigravity" }))
        .toHaveAttribute("aria-disabled", "true")
      await expect
        .element(welcome().getByRole("button", { name: "Let’s build something" }))
        .toBeEnabled()
      await finish()
      await expect.element(welcome()).not.toBeInTheDocument()
      await expectSelected("Install Antigravity")
      await openPreferencesOn("Agents")
      await expect.element(agentSwitch("Claude Code")).toHaveAttribute("aria-checked", "true")
      await expect.element(agentSwitch("Codex")).toHaveAttribute("aria-checked", "false")
    })

    it("starts nothing, and leaves the installer's terminal, where the install failed", async () => {
      await openWorkspace("/?demo=welcome&agentInstall=fails")
      await installButton("Antigravity").click()
      // Long enough for an install that worked to have ended.
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      expect(terminalTabNames()).not.toContain("agy")
      // Still not installed: the dialog offers it again, and finishing is not held up.
      await expect.element(installButton("Antigravity")).toBeEnabled()
      await finish()
      await expect.element(welcome()).not.toBeInTheDocument()
      await expectSelected("Install Antigravity")
      await expect
        .element(page.getByText("curl: (6) Could not resolve host: antigravity.google").last())
        .toBeVisible()
      await openPreferencesOn("Agents")
      await expect.element(preferencesInstall("Antigravity")).toBeEnabled()
      expect(agentSwitch("Antigravity").query()).toBeNull()
    })

    it("waits for an install that is still running", async () => {
      await openWorkspace("/?demo=welcome&agentInstall=held")
      await installButton("Antigravity").click()
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      expect(terminalTabNames()).not.toContain("agy")
      await expect.element(welcome()).toBeVisible()
    })
  })

  context("when the page is reloaded while an installer runs", () => {
    // What the window kept in its session storage: Claude Code's installer, ended, in a
    // terminal the demo opens with.
    const kept = (terminalId: string) =>
      sessionStorage.setItem(
        "novadeck.installs",
        JSON.stringify([{ agent: "claude", terminalId, ran: true }]),
      )

    it("follows it again: connects the agent and starts it", async () => {
      kept("storefront-initial-01")
      await openWorkspace("/?demo=plain")
      await expect.poll(terminalTabNames, installTime).toContain("claude")
      await expectSelected("claude")
      await openPreferencesOn("Agents")
      await expect.element(agentSwitch("Claude Code")).toHaveAttribute("aria-checked", "true")
    })

    it("drops one whose terminal is gone, starting nothing", async () => {
      kept("storefront-initial-99")
      await openWorkspace("/?demo=plain")
      await expect.poll(() => sessionStorage.getItem("novadeck.installs")).toBeNull()
      expect(terminalTabNames()).not.toContain("claude")
    })
  })
})

describe("An agent that is not installed, in Preferences", () => {
  it("offers to install it, with the command that will run, in place of its switch", async () => {
    await openWorkspace("/?demo=plain")
    await openPreferencesOn("Agents")
    await expect
      .element(preferencesInstall("Antigravity"))
      .toHaveAccessibleDescription(
        /Not installed\. Install runs curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/,
      )
    expect(agentSwitch("Antigravity").query()).toBeNull()
    await expect.element(agentSwitch("Codex")).toBeVisible()
  })

  it("closes Preferences, installs in a terminal, then connects the agent and starts it", async () => {
    await openWorkspace("/?demo=plain")
    await openPreferencesOn("Agents")
    await preferencesInstall("Antigravity").click()
    await expect.element(preferencesDialog()).not.toBeInTheDocument()
    await expectSelected("Install Antigravity")

    await expect.poll(terminalTabNames, installTime).toContain("agy")
    await expectSelected("agy")
    await openPreferencesOn("Agents")
    await expect.element(agentSwitch("Antigravity")).toHaveAttribute("aria-checked", "true")
  })

  it("reads as installing while its installer runs", async () => {
    await openWorkspace("/?demo=plain&agentInstall=held")
    await openPreferencesOn("Agents")
    await preferencesInstall("Antigravity").click()
    await expectSelected("Install Antigravity")
    await openPreferencesOn("Agents")
    const installing = preferencesDialog().getByRole("button", { name: "Installing Antigravity" })
    await expect.element(installing).toHaveAttribute("aria-disabled", "true")
    await expect.element(installing).toHaveTextContent("Installing…")
  })
})
