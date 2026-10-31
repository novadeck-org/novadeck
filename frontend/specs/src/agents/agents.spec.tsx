import { onTestFinished } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { escapeFrom, openPreferences, preferencesDialog } from "../support/keyboard"
import { workspaceSwitcher } from "../support/sessions"
import {
  chooseView,
  expectStaysAbsent,
  openWorkspace,
  sidebarPanel,
  skipWelcome,
  tabDescription,
  terminal,
  terminalTab,
  typeInto,
} from "../support/workspace"
import { context, describe, expect, it } from "../test"

const agentSwitch = (scope: Locator, name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  scope.getByRole("switch", { name })

const agentChoice = (scope: Locator, name: "Claude Code" | "Codex" | "Antigravity"): Locator =>
  scope.getByRole("checkbox", { name })

const welcome = (): Locator => page.getByRole("dialog", { name: "Welcome to Novadeck" })

describe("An agent waiting on the person", () => {
  it("says so on its terminal's tab and window", async () => {
    // The demo's Codex waits for permission to run a command.
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    const tab = terminalTab("Checkout review")
    await expect
      .poll(() => tabDescription("Checkout review"))
      // The need says what the Inbox entry is about, as the tab's `!` does.
      .toBe("Needs permission: pnpm test --filter checkout, 2 subagents: 2 explorer")
    await tab.click()
    await expect
      .element(terminal("Checkout review"))
      .toHaveAttribute("aria-description", "Needs permission: pnpm test --filter checkout")
  })

  context("in another project", () => {
    it("marks the switcher with the most pressing, and each project's row", async () => {
      // The demo's other projects: api-service's agents wait on a plan and a permission,
      // docs-site's asks a question, mobile-app's works, design-system's and infra's work
      // and then finish, done and failed, a moment after the demo opens.
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      const trigger = workspaceSwitcher()

      await expect.element(trigger).toHaveAttribute("data-project-status", "unblock")
      await expect
        .element(trigger)
        .toHaveAttribute("aria-description", "Another project: Needs you")
      await trigger.click()
      const menu = page.getByRole("dialog", { name: "Switch workspace" })
      const row = (name: string): Locator =>
        menu.getByRole("button", { name: new RegExp(`^${name} `) })
      await expect.element(row("api-service")).toHaveAttribute("aria-description", "Needs you")
      await expect.element(row("docs-site")).toHaveAttribute("aria-description", "Asks a question")
      await expect.element(row("mobile-app")).toHaveAttribute("aria-description", "Working")
      await expect
        .element(row("design-system"), { timeout: 10_000 })
        .toHaveAttribute("aria-description", "Done · reported")
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
    await skipWelcome()
    const tab = terminalTab("Checkout implementation")
    await expect
      .poll(() => tabDescription("Checkout implementation"))
      .toBe("Plan ready for review: Checkout flow")
    await tab.click()
    const window = terminal("Checkout implementation")
    await expect
      .element(window)
      .toHaveAttribute("aria-description", "Plan ready for review: Checkout flow")
    // Whether it plans is its own terminal's to show, not its window's header.
    await expect.element(window.getByText("planning", { exact: true })).not.toBeInTheDocument()
  })
})

describe("An agent's subagents", () => {
  it("are marked on its tab, and listed by kind under it while it's selected", async () => {
    // The demo's Codex runs two explorers.
    await openWorkspace("/?demo=agents")
    await skipWelcome()
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
    await skipWelcome()
    await terminalTab("Checkout review").click()
    const window = terminal("Checkout review")
    await expect.poll(() => tabDescription("Checkout review")).toContain("2 subagents")
    await expect.element(window.getByText("2 subagents")).not.toBeInTheDocument()
  })
})

describe("An agent whose turn left work running", () => {
  it("works on, counting that work on its tab", async () => {
    // The demo's Claude Code waits on two subagents and a command it started.
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    await terminalTab("Tests").click()
    const window = terminal("Tests")
    await expect.element(window).toHaveAttribute("data-terminal-phase", "running")
    await expect.poll(() => tabDescription("Tests")).toContain("2 agents · 1 task")
    await expect.element(window.getByText("2 agents · 1 task")).not.toBeInTheDocument()
  })

  it("waits, not idle or done, on a command it started, which wakes it once it ends", async () => {
    // The demo's other Claude Code left a build running and ended its turn.
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    const tab = terminalTab("Build")
    const row = () => tab.element().closest(".terminal-tab")!
    await expect.poll(() => row().getAttribute("data-terminal-phase")).toBe("waiting")
    expect(row().getAttribute("data-terminal-wait")).toBe("job")
    await expect
      .poll(() => tabDescription("Build"))
      .toContain("Waiting on Build the docs site, 4 minutes")
    // Under the tab while it's selected: the description in its own words, and the minutes.
    await expect.element(tab.getByText("Build the docs site")).not.toBeVisible()
    await tab.click()
    await expect.element(tab.getByText("Build the docs site")).toBeVisible()
    await expect.element(tab.getByText("4m")).toBeVisible()
    // In its window's bar, minutes first, and counted apart from work in the footer.
    const window = terminal("Build")
    await expect.element(window).toHaveAttribute("data-terminal-phase", "waiting")
    await expect.element(window.getByText("Build the docs site")).toBeVisible()
    await expect.element(page.getByText("1 waiting")).toBeVisible()
    // Not counted as running too.
    await expect.element(page.getByText("5 running")).toBeVisible()
  })
})

describe("An agent Novadeck can't hear from", () => {
  it("says so on its terminal's tab and window, never as running", async () => {
    // The demo's Antigravity runs with nothing reaching Novadeck from its hooks.
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    const said = "Not reporting · Novadeck can't hear from this agent"
    await expect.poll(() => tabDescription("Runtime")).toBe(said)
    await terminalTab("Runtime").click()
    const window = terminal("Runtime")
    await expect.element(window).toHaveAttribute("aria-description", said)
    await expect.element(window).toHaveAttribute("data-terminal-phase", "unheard")
  })
})

// The demo's Claude Code in Build is idle at its prompt; a prompt there works a moment,
// then finishes with a reply, the command it left running still running. A `view` is
// chosen before the prompt, so the turn's moment goes to looking away from it. The turn
// works 5 s, so a busy machine's click elsewhere lands before it ends, which the demo's
// usual 1.5 s didn't always leave room for.
const promptBuild = async (view?: "Grid", text = "Ship the docs"): Promise<void> => {
  await openWorkspace("/?demo=agents&turnMs=5000")
  await skipWelcome()
  if (view) await chooseView(view)
  await terminalTab("Build").click()
  await typeInto("Build", text)
  await userEvent.keyboard("{Enter}")
  await expect.element(terminal("Build")).toHaveAttribute("data-terminal-phase", "running")
}

describe("An agent that finishes", () => {
  const reports = () =>
    page
      .getByRole("list", { name: "Messages from your agents" })
      .getByRole("listitem")
      .filter({ hasText: /Ship the docs|Now the changelog/ })

  context("while the person looks elsewhere", () => {
    it("marks its terminal done, and looking at it leaves the mark", async () => {
      await promptBuild()
      await terminalTab("Tests").click()
      await expect
        .poll(() => tabDescription("Build"), { timeout: 10_000 })
        // The command its turn left running still counts.
        .toBe("Done · reported, 1 task")
      const row = terminalTab("Build").element().closest(".terminal-tab")!
      expect(row.getAttribute("data-terminal-phase")).toBe("done")
      await terminalTab("Build").click()
      const window = terminal("Build")
      // The report stands until the person gives the agent more to do, looked at or not.
      await expect.element(window).toHaveAttribute("data-terminal-phase", "done")
      await expect.poll(() => tabDescription("Build")).toBe("Done · reported, 1 task")
    })

    it("shows it on a window in view, and keeps it once the person selects it", async () => {
      await promptBuild("Grid")
      await terminalTab("Tests").click()
      const window = terminal("Build")
      await expect
        .element(window, { timeout: 10_000 })
        .toHaveAttribute("data-terminal-phase", "done")
      await expect.element(window).toHaveAttribute("aria-description", "Done · reported")
      await terminalTab("Build").click()
      await expect.element(window).toHaveAttribute("data-terminal-phase", "done")
    })

    it("brightens its program, with no glyph, where it replies without a done call", async () => {
      // A question is answered in the reply; the agent reports no finished task.
      await promptBuild(undefined, "Is the docs build clean?")
      await terminalTab("Tests").click()
      await expect
        .poll(() => tabDescription("Build"), { timeout: 10_000 })
        .toBe("Reply unread, 1 task")
      const row = terminalTab("Build").element().closest(".terminal-tab")!
      // A turn that ended is no done report: the agent rests, its program in ink.
      expect(row.getAttribute("data-terminal-phase")).toBe("idle")
      expect(row.getAttribute("data-terminal-unread")).toBe("true")
      expect(row.getAttribute("data-terminal-need")).toBeNull()
      await terminalTab("Build").click()
      await expect.poll(() => row.getAttribute("data-terminal-unread")).toBeNull()
      expect(tabDescription("Build")).toBe("1 task")
    })
  })

  context("and then works another turn before they look", () => {
    it("keeps its done mark through that turn, and after they look at it", async () => {
      await promptBuild()
      // The person leaves the page with Build selected, as to another window.
      const visibility = (state: "hidden" | "visible") => {
        Object.defineProperty(document, "visibilityState", { value: state, configurable: true })
        document.dispatchEvent(new Event("visibilitychange"))
      }
      onTestFinished(() => {
        Reflect.deleteProperty(document, "visibilityState")
        document.dispatchEvent(new Event("visibilitychange"))
      })
      visibility("hidden")
      const window = terminal("Build")
      await expect
        .element(window, { timeout: 10_000 })
        .toHaveAttribute("data-terminal-phase", "done")
      await typeInto("Build", "Now the changelog")
      await userEvent.keyboard("{Enter}")
      await expect.element(window).toHaveAttribute("data-terminal-phase", "running")
      await expect
        .element(window, { timeout: 10_000 })
        .toHaveAttribute("data-terminal-phase", "done")
      // Both reports are rows of their own in the Inbox, the first not replaced by the second.
      await sidebarPanel("Inbox").click()
      await expect.element(reports()).toHaveLength(2)
      visibility("visible")
      await sidebarPanel("Terminals").click()
      await terminalTab("Build").click()
      await expect.element(window).toHaveAttribute("data-terminal-phase", "done")
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
    it("marks it done all the same", async () => {
      await promptBuild()
      const window = terminal("Build")
      await expect
        .element(window, { timeout: 10_000 })
        .toHaveAttribute("data-terminal-phase", "done")
      await expect.poll(() => tabDescription("Build")).toBe("Done · reported, 1 task")
    })
  })
})

describe("An agent's model and context", () => {
  it("show as a ring over its terminal's top right, in words as the ring is hovered", async () => {
    // The demo's Codex reports its model, effort and context, and a five-hour window.
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    await terminalTab("Checkout review").click()
    const window = terminal("Checkout review")
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
    await skipWelcome()
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
    await skipWelcome()
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
      await expect.element(choice).toHaveAccessibleDescription(/Saved encrypted on this computer/)
      await choice.click()
      await welcome().getByRole("button", { name: "Let’s build something" }).click()
      await expect.element(welcome()).not.toBeInTheDocument()
      await openPreferences()
      await expect
        .element(preferencesDialog().getByRole("switch", { name: "Transcripts" }))
        .toHaveAttribute("aria-checked", "false")
    })

    it("leaves the transcripts choice out where they cannot be kept encrypted", async () => {
      await openWorkspace("/?demo=welcome&transcripts=unavailable")
      await expect.element(welcome()).toBeVisible()
      expect(welcome().getByRole("checkbox", { name: "Transcripts" }).query()).toBeNull()
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
