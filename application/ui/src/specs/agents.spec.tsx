import { describe as context, describe, expect, it } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { expectFocusWithin, preferencesDialog } from "./support/keyboard"
import {
  chooseView,
  expectStaysAbsent,
  openWorkspace,
  tabDescription,
  tooltipOf,
} from "./support/workspace"

const agentSwitch = (scope: Locator, name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  scope.getByRole("switch", { name })

const agentChoice = (scope: Locator, name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  scope.getByRole("checkbox", { name })

const welcome = (): Locator => page.getByRole("dialog", { name: "Welcome to NovaDeck" })

const openPreferences = async (): Promise<void> => {
  await page.getByRole("button", { name: "Workspace preferences" }).click()
  await expectFocusWithin(preferencesDialog())
}

describe("An agent waiting on the person", () => {
  it("says so on its terminal's tab and window", async () => {
    // The demo's Codex waits for permission to run a command.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    const tab = page.getByRole("button", { name: "Select Checkout review" })
    await expect.poll(() => tabDescription("Checkout review")).toBe("Needs permission")
    await tab.click()
    await expect
      .element(page.getByRole("region", { name: "Checkout review terminal" }))
      .toHaveAttribute("aria-description", "Needs permission")
  })
})

describe("An agent that plans", () => {
  it("says so beside a focused window's name, and that its plan waits for review", async () => {
    // The demo's Claude Code planned, and waits for the person to review the plan.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    const tab = page.getByRole("button", { name: "Select Checkout implementation" })
    await expect.poll(() => tabDescription("Checkout implementation")).toBe("Plan ready for review")
    await tab.click()
    const window = page.getByRole("region", { name: "Checkout implementation terminal" })
    await expect.element(window).toHaveAttribute("aria-description", "Plan ready for review")
    await expect.element(window.getByText("planning", { exact: true })).toBeVisible()
  })
})

describe("An agent's subagents", () => {
  it("count beside a focused window's name, their kinds on hover", async () => {
    // The demo's Codex runs two explorers.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    await page.getByRole("button", { name: "Select Checkout review" }).click()
    const window = page.getByRole("region", { name: "Checkout review terminal" })
    expect(await tooltipOf(window.getByText("2 subagents"))).toBe("2 explorer")
    await chooseView("Grid")
    await expect.element(window.getByText("2 subagents")).not.toBeInTheDocument()
  })
})

describe("An agent whose turn left work running", () => {
  it("works on, counting that work beside a focused window's name", async () => {
    // The demo's Claude Code waits on two subagents and a command it started.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    await page.getByRole("button", { name: "Select Tests" }).click()
    const window = page.getByRole("region", { name: "Tests terminal" })
    await expect.element(window).toHaveAttribute("data-terminal-phase", "running")
    expect(await tooltipOf(window.getByText("2 agents · 1 task"))).toBe(
      "Its turn is over, but subagents it started still run: it works on until they finish",
    )
    await expect.element(window.getByText("2 subagents")).not.toBeInTheDocument()
  })

  it("is idle beside a command it left running, which shows but never keeps it working", async () => {
    // The demo's other Claude Code left a command running.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    await page.getByRole("button", { name: "Select Build" }).click()
    const window = page.getByRole("region", { name: "Build terminal" })
    await expect.element(window).toHaveAttribute("data-terminal-phase", "idle")
    expect(await tooltipOf(window.getByText("1 task"))).toBe(
      "Its turn is over; work it started runs on in the background",
    )
  })
})

describe("An agent NovaDeck can't hear from", () => {
  it("says so on its terminal's tab and window, never as running", async () => {
    // The demo's Antigravity runs with nothing reaching NovaDeck from its hooks.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    const said = "Not reporting · NovaDeck can't hear from this agent"
    await expect.poll(() => tabDescription("Runtime")).toBe(said)
    await page.getByRole("button", { name: "Select Runtime" }).click()
    const window = page.getByRole("region", { name: "Runtime terminal" })
    await expect.element(window).toHaveAttribute("aria-description", said)
    await expect.element(window).toHaveAttribute("data-terminal-phase", "unheard")
  })
})

describe("An agent's usage", () => {
  it("shows beside a focused window's name, and leaves compact windows their name", async () => {
    // The demo's Codex reports its context and a five-hour window.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    await page.getByRole("button", { name: "Select Checkout review" }).click()
    const window = page.getByRole("region", { name: "Checkout review terminal" })
    await expect.element(window.getByText("ctx 15% · 5h 40%")).toBeVisible()
    await chooseView("Grid")
    await expect.element(window.getByText("ctx 15% · 5h 40%")).not.toBeInTheDocument()
    await expect.element(window.getByRole("heading", { name: "Checkout review" })).toBeVisible()
  })
})

describe("Connecting agents", () => {
  context("in Preferences", () => {
    it("offers each installed agent switched off, and not the ones missing", async () => {
      await openWorkspace()
      await openPreferences()
      const dialog = preferencesDialog()
      await expect
        .element(agentSwitch(dialog, "Claude Code"))
        .toHaveAttribute("aria-checked", "false")
      await expect.element(agentSwitch(dialog, "Codex")).toBeEnabled()
      await expect.element(agentSwitch(dialog, "Antigravity")).toBeDisabled()
      await expect
        .element(agentSwitch(dialog, "Antigravity"))
        .toHaveAccessibleDescription("Not installed")
    })

    it("connects and disconnects an agent", async () => {
      await openWorkspace()
      await openPreferences()
      const claude = agentSwitch(preferencesDialog(), "Claude Code")
      await claude.click()
      await expect.element(claude).toHaveAttribute("aria-checked", "true")
      // The switch speaks for itself; a connected agent needs no note.
      await expect.element(claude).not.toHaveAccessibleDescription()
      await claude.click()
      await expect.element(claude).toHaveAttribute("aria-checked", "false")
    })
  })

  context("when the app opens for the first time", () => {
    it("previews each layout without leaving the welcome dialog or connecting agents", async () => {
      await openWorkspace("/?demo=welcome")
      const dialog = welcome()
      await expect
        .element(dialog.getByRole("heading", { name: "Big ideas. Room to build." }))
        .toHaveFocus()
      await userEvent.keyboard("{Tab}{Enter}")
      await expect
        .element(dialog.getByRole("button", { name: "Focus", exact: true }))
        .toHaveAttribute("aria-pressed", "true")
      await expect.element(dialog.getByText("One terminal, full attention.")).toBeVisible()
      await dialog.getByRole("button", { name: "Grid", exact: true }).click()
      await expect.element(dialog.getByText("Everything side by side.")).toBeVisible()
      await dialog.getByRole("button", { name: "Canvas", exact: true }).click()
      await expect.element(dialog.getByText("Spread out on a zoomable canvas.")).toBeVisible()
      await expect.element(agentChoice(dialog, "Claude Code")).toBeChecked()
      await expect.element(agentChoice(dialog, "Antigravity")).toBeDisabled()
    })

    it("chooses every installed agent, connects the chosen ones, and does not ask again", async () => {
      await openWorkspace("/?demo=welcome")
      await expect.element(welcome()).toBeVisible()
      await expect.element(agentChoice(welcome(), "Claude Code")).toBeChecked()
      await expect.element(agentChoice(welcome(), "Codex")).toBeChecked()
      await expect.element(agentChoice(welcome(), "Antigravity")).not.toBeChecked()
      await agentChoice(welcome(), "Codex").click()
      await welcome().getByRole("button", { name: "Let’s build something" }).click()
      await expect.element(welcome()).not.toBeInTheDocument()
      await openPreferences()
      await expect
        .element(agentSwitch(preferencesDialog(), "Claude Code"))
        .toHaveAttribute("aria-checked", "true")
      await expect
        .element(agentSwitch(preferencesDialog(), "Codex"))
        .toHaveAttribute("aria-checked", "false")
    })

    it("discards its choices when dismissed", async () => {
      await openWorkspace("/?demo=welcome")
      await expect.element(welcome()).toBeVisible()
      await expect.element(agentChoice(welcome(), "Codex")).toBeChecked()
      await userEvent.keyboard("{Escape}")
      await expect.element(welcome()).not.toBeInTheDocument()
      await openPreferences()
      await expect
        .element(agentSwitch(preferencesDialog(), "Codex"))
        .toHaveAttribute("aria-checked", "false")
    })

    it("skips setup without connecting selected agents", async () => {
      await openWorkspace("/?demo=welcome")
      await expect.element(agentChoice(welcome(), "Claude Code")).toBeChecked()
      await welcome().getByRole("button", { name: "Skip for now" }).click()
      await expect.element(welcome()).not.toBeInTheDocument()
      await openPreferences()
      await expect
        .element(agentSwitch(preferencesDialog(), "Claude Code"))
        .toHaveAttribute("aria-checked", "false")
    })

    it("keeps transcripts on unless turned off and started", async () => {
      await openWorkspace("/?demo=welcome")
      const choice = welcome().getByRole("checkbox", { name: "Transcripts" })
      await expect.element(choice).toBeChecked()
      await expect.element(choice).toHaveAccessibleDescription(/secrets/)
      await choice.click()
      await welcome().getByRole("button", { name: "Let’s build something" }).click()
      await expect.element(welcome()).not.toBeInTheDocument()
      await openPreferences()
      await expect
        .element(preferencesDialog().getByRole("switch", { name: "Transcripts" }))
        .toHaveAttribute("aria-checked", "false")
    })

    it("leaves transcripts as they were when skipped", async () => {
      await openWorkspace("/?demo=welcome")
      await welcome().getByRole("checkbox", { name: "Transcripts" }).click()
      await welcome().getByRole("button", { name: "Skip for now" }).click()
      await expect.element(welcome()).not.toBeInTheDocument()
      await openPreferences()
      await expect
        .element(preferencesDialog().getByRole("switch", { name: "Transcripts" }))
        .toHaveAttribute("aria-checked", "true")
    })
  })

  it("is not offered at startup once the person has seen it", async () => {
    await openWorkspace()
    await expectStaysAbsent(welcome())
    expect(welcome().query()).toBeNull()
  })
})
