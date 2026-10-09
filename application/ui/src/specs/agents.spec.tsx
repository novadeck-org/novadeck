import { describe as context, describe, expect, it, onTestFinished } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { escapeFrom, expectFocusWithin, preferencesDialog } from "./support/keyboard"
import { workspaceSwitcher } from "./support/sessions"
import {
  chooseView,
  commandInput,
  expectStaysAbsent,
  openWorkspace,
  tabDescription,
  terminal,
  terminalTab,
} from "./support/workspace"

const agentSwitch = (scope: Locator, name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  scope.getByRole("switch", { name })

const agentChoice = (scope: Locator, name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  scope.getByRole("checkbox", { name })

const welcome = (): Locator => page.getByRole("dialog", { name: "Welcome to Novadeck" })

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
    await expect
      .poll(() => tabDescription("Checkout review"))
      .toBe("Needs permission, 2 subagents: 2 explorer")
    await tab.click()
    await expect
      .element(page.getByRole("region", { name: "Checkout review terminal" }))
      .toHaveAttribute("aria-description", "Needs permission")
  })

  context("in another project", () => {
    it("marks the switcher with the most pressing, and each project's row", async () => {
      // The demo's other projects: api-service's agents wait on a plan and a permission,
      // docs-site's asks a question, mobile-app's works, design-system's and infra's work
      // and then finish, done and failed, a moment after the demo opens.
      await openWorkspace("/?demo=agents")
      const skip = page.getByRole("button", { name: "Skip for now" })
      if (await skip.query()) await skip.click()
      const trigger = workspaceSwitcher()

      await expect.element(trigger).toHaveAttribute("data-project-status", "question")
      await expect
        .element(trigger)
        .toHaveAttribute("aria-description", "Another project: Asks a question")
      await trigger.click()
      const menu = page.getByRole("dialog", { name: "Switch workspace" })
      const row = (name: string): Locator =>
        menu.getByRole("button", { name: new RegExp(`^${name} `) })
      await expect.element(row("api-service")).toHaveAttribute("aria-description", "Needs you")
      await expect.element(row("docs-site")).toHaveAttribute("aria-description", "Asks a question")
      await expect.element(row("mobile-app")).toHaveAttribute("aria-description", "Working")
      await expect
        .element(row("design-system"), { timeout: 10_000 })
        .toHaveAttribute("aria-description", "Done · reply unread")
      await expect
        .element(row("infra"), { timeout: 10_000 })
        .toHaveAttribute("aria-description", "Stopped with an error · reply unread")
      await expect.element(row("dotfiles")).not.toHaveAttribute("data-project-status")
    })
  })
})

describe("An agent that plans", () => {
  it("says that its plan waits for review, on its tab and window", async () => {
    // The demo's Claude Code planned, and waits for the person to review the plan.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    const tab = page.getByRole("button", { name: "Select Checkout implementation" })
    await expect.poll(() => tabDescription("Checkout implementation")).toBe("Plan ready for review")
    await tab.click()
    const window = page.getByRole("region", { name: "Checkout implementation terminal" })
    await expect.element(window).toHaveAttribute("aria-description", "Plan ready for review")
    // Whether it plans is its own terminal's to show, not its window's header.
    await expect.element(window.getByText("planning", { exact: true })).not.toBeInTheDocument()
  })
})

describe("An agent's subagents", () => {
  it("are marked on its tab, and listed by kind under it while it's selected", async () => {
    // The demo's Codex runs two explorers.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    const tab = terminalTab("Checkout review")
    const row = () => tab.element().closest(".terminal-tab")!
    await expect.poll(() => row().getAttribute("data-terminal-subagents")).toBe("working")
    expect(row().querySelectorAll(".terminal-tab-subagents .terminal-tab-subagent")).toHaveLength(2)
    await expect.element(tab.getByText("explorer").first()).not.toBeVisible()
    await tab.click()
    await expect.element(tab.getByText("explorer").first()).toBeVisible()
    await expect.element(tab.getByText("explorer").nth(1)).toBeVisible()
    // The rows take the place of the marks on its line.
    await expect
      .poll(() => row().querySelector(".terminal-tab-subagents")!.getBoundingClientRect().width)
      .toBe(0)
    // A command its turn left running is no subagent.
    const build = terminalTab("Build").element().closest(".terminal-tab")!
    expect(build.hasAttribute("data-terminal-subagents")).toBe(false)
  })

  it("are counted on its tab, and left to its terminal in its window", async () => {
    // The demo's Codex runs two explorers.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    await page.getByRole("button", { name: "Select Checkout review" }).click()
    const window = page.getByRole("region", { name: "Checkout review terminal" })
    await expect.poll(() => tabDescription("Checkout review")).toContain("2 subagents")
    await expect.element(window.getByText("2 subagents")).not.toBeInTheDocument()
  })
})

describe("An agent whose turn left work running", () => {
  it("works on, counting that work on its tab", async () => {
    // The demo's Claude Code waits on two subagents and a command it started.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    await page.getByRole("button", { name: "Select Tests" }).click()
    const window = page.getByRole("region", { name: "Tests terminal" })
    await expect.element(window).toHaveAttribute("data-terminal-phase", "running")
    await expect.poll(() => tabDescription("Tests")).toContain("2 agents · 1 task")
    await expect.element(window.getByText("2 agents · 1 task")).not.toBeInTheDocument()
  })

  it("is idle beside a command it left running, which shows but never keeps it working", async () => {
    // The demo's other Claude Code left a command running.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    await page.getByRole("button", { name: "Select Build" }).click()
    const window = page.getByRole("region", { name: "Build terminal" })
    await expect.element(window).toHaveAttribute("data-terminal-phase", "idle")
  })
})

describe("An agent Novadeck can't hear from", () => {
  it("says so on its terminal's tab and window, never as running", async () => {
    // The demo's Antigravity runs with nothing reaching Novadeck from its hooks.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    const said = "Not reporting · Novadeck can't hear from this agent"
    await expect.poll(() => tabDescription("Runtime")).toBe(said)
    await page.getByRole("button", { name: "Select Runtime" }).click()
    const window = page.getByRole("region", { name: "Runtime terminal" })
    await expect.element(window).toHaveAttribute("aria-description", said)
    await expect.element(window).toHaveAttribute("data-terminal-phase", "unheard")
  })
})

// The demo's Claude Code in Build is idle at its prompt; a prompt there works a moment,
// then finishes with a reply, the command it left running still running. A `view` is
// chosen before the prompt, so the turn's moment goes to looking away from it.
const promptBuild = async (view?: "Grid"): Promise<void> => {
  await openWorkspace("/?demo=agents")
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
  if (view) await chooseView(view)
  await terminalTab("Build").click()
  await commandInput("Build").fill("Ship the docs")
  await userEvent.keyboard("{Enter}")
  await expect.element(terminal("Build")).toHaveAttribute("data-terminal-phase", "running")
}

describe("An agent that finishes", () => {
  context("while the person looks elsewhere", () => {
    it("marks its terminal done, reply unread, until they look at it", async () => {
      await promptBuild()
      await terminalTab("Tests").click()
      await expect
        .poll(() => tabDescription("Build"), { timeout: 5000 })
        // The command its turn left running still counts.
        .toBe("Done · reply unread, 1 task")
      const row = terminalTab("Build").element().closest(".terminal-tab")!
      expect(row.getAttribute("data-terminal-phase")).toBe("done")
      // Beside its program, how long ago it finished.
      await expect.element(terminalTab("Build").getByText("now", { exact: true })).toBeVisible()
      await terminalTab("Build").click()
      const window = terminal("Build")
      await expect.element(window).toHaveAttribute("data-terminal-phase", "idle")
      await expect.element(window.getByText("Done · reply unread")).not.toBeInTheDocument()
      expect(tabDescription("Build")).toBe("1 task")
    })

    it("shows it on a window in view, and clears once the person selects it", async () => {
      await promptBuild("Grid")
      await terminalTab("Tests").click()
      const window = terminal("Build")
      await expect.element(window, { timeout: 5000 }).toHaveAttribute("data-terminal-phase", "done")
      await expect.element(window).toHaveAttribute("aria-description", "Done · reply unread")
      // Its phase line marks it, its name bold; its description says it in words.
      await expect.element(window.getByText("Done", { exact: true })).not.toBeInTheDocument()
      await terminalTab("Build").click()
      await expect.element(window).toHaveAttribute("data-terminal-phase", "idle")
    })
  })

  it("offers a notification only in the desktop app, on unless turned off", async () => {
    await openWorkspace()
    await openPreferences()
    const toggle = preferencesDialog().getByRole("switch", {
      name: "Notify when an agent finishes",
    })
    await expect.element(toggle).toHaveAttribute("aria-checked", "true")
    await expect.element(toggle).toBeDisabled()
    await expect.element(toggle).toHaveAccessibleDescription("Only in the desktop app.")
  })

  context("while the person looks at it", () => {
    it("leaves it as it was", async () => {
      await promptBuild()
      const window = terminal("Build")
      await expect.element(window, { timeout: 5000 }).toHaveAttribute("data-terminal-phase", "idle")
      // Past the grace a completed end waits before it is marked (`finishGraceMs`).
      await expectStaysAbsent(window.getByText("Done · reply unread"), { ms: 1500 })
      // Only the command its turn left running.
      expect(tabDescription("Build")).toBe("1 task")
    })
  })
})

describe("An agent's model and context", () => {
  it("show as a ring over its terminal's top right, in words as the ring is hovered", async () => {
    // The demo's Codex reports its model, effort and context, and a five-hour window.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    await page.getByRole("button", { name: "Select Checkout review" }).click()
    const window = page.getByRole("region", { name: "Checkout review terminal" })
    const ring = window.getByRole("img", {
      name: "gpt-6-astra · high, Context 15% full · 30k of 200k tokens",
    })
    const words = window.getByText("gpt-6-astra (high)")
    const share = window.getByText("15% (30k/200k)")
    await expect.element(ring).toBeVisible()
    // The rest of the header leaves the words folded away.
    await userEvent.hover(window.getByRole("heading", { name: "Checkout review" }))
    await expect.element(words).not.toBeVisible()
    await userEvent.hover(ring)
    await expect.element(words).toBeVisible()
    await expect.element(share).toBeVisible()
    // Its rate limits stay out of the window.
    await expect.element(window.getByText(/5h 40%/)).not.toBeInTheDocument()
    await chooseView("Grid")
    await userEvent.hover(ring)
    await expect.element(words).toBeVisible()
  })
})

describe("The account's subscriptions", () => {
  it("show as a pill each in the footer, each naming its busiest window and opening its own", async () => {
    // The demo's Claude Code and Codex report their five-hour and weekly windows.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    const pills = page.getByRole("group", { name: "Subscriptions" }).getByRole("button")
    expect(pills.elements().map((pill) => pill.getAttribute("aria-label"))).toEqual([
      "Claude Code subscription: 5h 42% used",
      "Codex subscription: 5h 40% used",
    ])

    await pills.first().click()

    const claude = page.getByRole("dialog", { name: "Claude Code subscription" })
    await expect.element(claude.getByText("18%")).toBeVisible()
    await expect.element(claude.getByText(/^resets in 2h 1\dm · /)).toBeVisible()
    await expect.element(claude.getByText("Codex")).not.toBeInTheDocument()
  })

  it("stay where the person moves them, from a pill's menu or by dragging it", async () => {
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    const pills = page.getByRole("group", { name: "Subscriptions" }).getByRole("button")
    const order = () =>
      pills.elements().map((pill) => pill.getAttribute("aria-label")!.split(" ")[0])
    expect(order()).toEqual(["Claude", "Codex"])

    await pills.first().click({ button: "right" })
    await page.getByRole("menuitem", { name: "Move right" }).click()
    await expect.poll(order).toEqual(["Codex", "Claude"])

    // Kept for the next visit.
    expect(JSON.parse(localStorage.getItem("novadeck.subscription-order") ?? "null")).toEqual([
      "codex",
      "claude",
    ])

    const box = pills.first().element().getBoundingClientRect()
    await userEvent.dragAndDrop(pills.first(), pills.nth(1), {
      sourcePosition: { x: box.width / 2, y: box.height / 2 },
      targetPosition: { x: box.width - 4, y: box.height / 2 },
      steps: 12,
    })
    await expect.poll(order).toEqual(["Claude", "Codex"])
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
      await escapeFrom(welcome())
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

describe("A pinned project", () => {
  it("shows as a chip in the header, and the switcher's dot leaves it out", async () => {
    // Pinned, docs-site shows beside the switcher, its agent asking a question; the dot
    // leaves it out, so it shows the next most pressing: api-service's waiting agents.
    localStorage.setItem(
      "novadeck.project-arrangement",
      JSON.stringify({ order: ["docs-site"], pinned: ["docs-site"] }),
    )
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    const chip = page
      .getByRole("group", { name: "Pinned projects" })
      .getByRole("button", { name: "docs-site" })
    await expect.element(chip).toHaveAttribute("aria-description", "Asks a question")
    await expect.element(workspaceSwitcher()).toHaveAttribute("data-project-status", "attention")

    // Switching to it keeps its chip in place, marked current; the others still wait
    // in the dot.
    await chip.click()
    await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
    await expect.element(chip).toHaveAttribute("aria-current", "true")
    await expect.element(workspaceSwitcher()).toHaveAttribute("data-project-status")
  })

  it("leaves the header where its chip doesn't fit, and the dot covers it again", async () => {
    localStorage.setItem(
      "novadeck.project-arrangement",
      JSON.stringify({ order: ["docs-site"], pinned: ["docs-site"] }),
    )
    await page.viewport(860, 900)
    onTestFinished(() => page.viewport(1440, 900))
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    await expect.element(workspaceSwitcher()).toHaveAttribute("data-project-status", "question")
    await expect.element(page.getByRole("button", { name: "docs-site" })).not.toBeInTheDocument()
  })
})
