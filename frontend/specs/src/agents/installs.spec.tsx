import { page, type Locator } from "vitest/browser"

import { openPreferences, preferencesDialog } from "../support/keyboard"
import { expectSelected, openWorkspace, terminalTab, terminalTabNames } from "../support/workspace"
import { context, describe, expect, it } from "../test"

const welcome = (): Locator => page.getByRole("dialog", { name: "Welcome to Novadeck" })

const installButton = (name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  welcome().getByRole("button", { name: `Install ${name}` })

const agentSwitch = (name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  preferencesDialog().getByRole("switch", { name })

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
    it("applies the other choices, then installs in a terminal, connects the agent and starts it", async () => {
      await openWorkspace("/?demo=welcome")
      await welcome().getByRole("checkbox", { name: "Codex" }).click()
      await installButton("Antigravity").click()
      await expect.element(welcome()).not.toBeInTheDocument()

      // A terminal of its own runs the installer, selected.
      await expectSelected("Install Antigravity")
      await expect
        .element(
          page.getByText("curl -fsSL https://antigravity.google/cli/install.sh | bash").last(),
        )
        .toBeVisible()

      // Once it ends, the agent is connected and started in a terminal of its own.
      await expect.poll(terminalTabNames, installTime).toContain("agy")
      await expectSelected("agy")
      expect(terminalTab("Install Antigravity").query()).not.toBeNull()

      await openPreferences()
      await expect.element(agentSwitch("Antigravity")).toHaveAttribute("aria-checked", "true")
      await expect.element(agentSwitch("Claude Code")).toHaveAttribute("aria-checked", "true")
      await expect.element(agentSwitch("Codex")).toHaveAttribute("aria-checked", "false")
    })

    it("starts nothing, and leaves the installer's terminal, where the install failed", async () => {
      await openWorkspace("/?demo=welcome&agentInstall=fails")
      await installButton("Antigravity").click()
      await expectSelected("Install Antigravity")
      await expect
        .element(page.getByText("curl: (6) Could not resolve host: antigravity.google").last())
        .toBeVisible()
      // Long enough for an install that worked to have ended.
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      expect(terminalTabNames()).not.toContain("agy")
      await expectSelected("Install Antigravity")
      await openPreferences()
      await expect.element(agentSwitch("Antigravity")).toHaveAttribute("aria-checked", "false")
      await expect.element(preferencesDialog().getByText("Not installed")).toBeVisible()
    })

    it("waits for an install that is still running", async () => {
      await openWorkspace("/?demo=welcome&agentInstall=held")
      await installButton("Antigravity").click()
      await expectSelected("Install Antigravity")
      await new Promise((resolve) => setTimeout(resolve, 4_000))
      expect(terminalTabNames()).not.toContain("agy")
    })
  })
})
