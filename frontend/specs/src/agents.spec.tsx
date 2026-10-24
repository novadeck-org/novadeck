import { describe as context, describe, expect, it, onTestFinished } from "vitest"
import { page, userEvent, type Locator } from "vitest/browser"

import { settled } from "./support/canvas"
import { escapeFrom, expectFocusWithin, preferencesDialog } from "./support/keyboard"
import { pinPointer } from "./support/pointer"
import { workspaceSwitcher } from "./support/sessions"
import {
  chooseView,
  expectStaysAbsent,
  isMac,
  labelled,
  openWorkspace,
  tabDescription,
  terminal,
  terminalTab,
  typeInto,
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
    const tab = page.getByRole("button", { name: labelled("Select ", "Checkout review") })
    await expect
      .poll(() => tabDescription("Checkout review"))
      .toBe("Needs permission, 2 subagents: 2 explorer")
    await tab.click()
    await expect
      .element(terminal("Checkout review"))
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
    const tab = page.getByRole("button", { name: labelled("Select ", "Checkout implementation") })
    await expect.poll(() => tabDescription("Checkout implementation")).toBe("Plan ready for review")
    await tab.click()
    const window = terminal("Checkout implementation")
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
    await page.getByRole("button", { name: labelled("Select ", "Checkout review") }).click()
    const window = terminal("Checkout review")
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
    await page.getByRole("button", { name: labelled("Select ", "Tests") }).click()
    const window = terminal("Tests")
    await expect.element(window).toHaveAttribute("data-terminal-phase", "running")
    await expect.poll(() => tabDescription("Tests")).toContain("2 agents · 1 task")
    await expect.element(window.getByText("2 agents · 1 task")).not.toBeInTheDocument()
  })

  it("waits, not idle or done, on a command it started, which wakes it once it ends", async () => {
    // The demo's other Claude Code left a build running and ended its turn.
    await openWorkspace("/?demo=agents")
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
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
    const skip = page.getByRole("button", { name: "Skip for now" })
    if (await skip.query()) await skip.click()
    const said = "Not reporting · Novadeck can't hear from this agent"
    await expect.poll(() => tabDescription("Runtime")).toBe(said)
    await page.getByRole("button", { name: labelled("Select ", "Runtime") }).click()
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
const promptBuild = async (view?: "Grid"): Promise<void> => {
  await openWorkspace("/?demo=agents&turnMs=5000")
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
  if (view) await chooseView(view)
  await terminalTab("Build").click()
  await typeInto("Build", "Ship the docs")
  await userEvent.keyboard("{Enter}")
  await expect.element(terminal("Build")).toHaveAttribute("data-terminal-phase", "running")
}

describe("An agent that finishes", () => {
  context("while the person looks elsewhere", () => {
    it("marks its terminal done, reply unread, until they look at it", async () => {
      await promptBuild()
      await terminalTab("Tests").click()
      await expect
        .poll(() => tabDescription("Build"), { timeout: 10_000 })
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
      await expect
        .element(window, { timeout: 10_000 })
        .toHaveAttribute("data-terminal-phase", "done")
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
      await expect
        .element(window, { timeout: 10_000 })
        .toHaveAttribute("data-terminal-phase", "idle")
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
    await page.getByRole("button", { name: labelled("Select ", "Checkout review") }).click()
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

const pinsBar = () => page.getByRole("group", { name: "Pinned projects" })
// The words on the bar saying where to drop a project dragged from the switcher.
const dropHint = (): HTMLElement => document.querySelector<HTMLElement>(".pins-bar-drop-hint")!
const pin = (name: string) => pinsBar().getByRole("button", { name: new RegExp(`${name}$`) })
const arrange = (pinned: string[]): void =>
  localStorage.setItem("novadeck.project-arrangement", JSON.stringify({ order: pinned, pinned }))
const switcherRow = (name: string) =>
  page
    .getByRole("dialog", { name: "Switch workspace" })
    .getByRole("button", { name: new RegExp(`^${name}`) })
// Presses Escape once the bar is dragging the pin a project handed over, before the
// drag is let go.
const escapeOnceHandedOver = (name: string): void => {
  const moved = (): void => {
    if (!document.querySelector(`.pin[data-pin="${name}"][data-dragging="true"]`)) return
    window.removeEventListener("pointermove", moved, true)
    // After the bar has followed this move.
    setTimeout(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    )
  }
  window.addEventListener("pointermove", moved, true)
}

// The switcher's projects as it lists them, while it is open.
const switcherOrder = () =>
  [
    ...(page
      .getByRole("dialog", { name: "Switch workspace" })
      .query()
      ?.querySelectorAll(".workspace-switcher-project strong") ?? []),
  ].map((name) => name.textContent)
const skipWelcome = async (): Promise<void> => {
  const skip = page.getByRole("button", { name: "Skip for now" })
  if (await skip.query()) await skip.click()
}

describe("A pinned project", () => {
  it("shows in the bar under the header, and the switcher's dot leaves it out", async () => {
    // Pinned, docs-site shows in the bar, its agent asking a question; the dot leaves it
    // out, so it shows the next most pressing: api-service's waiting agents.
    arrange(["docs-site"])
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    await expect.element(pin("docs-site")).toHaveAttribute("aria-description", "Asks a question")
    await expect.element(workspaceSwitcher()).toHaveAttribute("data-project-status", "attention")

    // Switching to it keeps its pin in place, marked current; the others still wait in
    // the dot.
    await pin("docs-site").click()
    await expect.element(workspaceSwitcher()).toHaveTextContent("docs-site")
    await expect.element(pin("docs-site")).toHaveAttribute("aria-current", "true")
    await expect.element(workspaceSwitcher()).toHaveAttribute("data-project-status")
  })

  it("is absent with no pins, and appears when pinning from the switcher menu", async () => {
    await openWorkspace()
    await expect.element(pinsBar()).not.toBeInTheDocument()

    await workspaceSwitcher().click()
    await page.getByRole("button", { name: "Pin api-service" }).click()

    await expect.element(pin("api-service")).toBeVisible()
    await expect.element(pin("api-service")).toHaveTextContent("1api-service")
  })

  context("reordered", () => {
    const pinNames = () =>
      pinsBar()
        .getByRole("button")
        .elements()
        .map((button) => button.textContent)

    it("by dragging a pin along the bar, which the switcher and the numbers follow", async () => {
      arrange(["storefront", "api-service", "mobile-app"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      expect(pinNames()).toEqual(["1storefront", "2api-service", "3mobile-app"])

      const first = pin("storefront")
      const last = pin("mobile-app")
      const from = first.element().getBoundingClientRect()
      const to = last.element().getBoundingClientRect()
      await userEvent.dragAndDrop(first, last, {
        sourcePosition: { x: from.width / 2, y: from.height / 2 },
        targetPosition: { x: to.width - 4, y: to.height / 2 },
        steps: 12,
      })
      await expect.poll(pinNames).toEqual(["1api-service", "2mobile-app", "3storefront"])
      await expect
        .element(pin("storefront"))
        .toHaveAttribute(
          "aria-keyshortcuts",
          isMac() ? "Meta+3 Alt+ArrowLeft" : "Control+Shift+3 Alt+ArrowLeft",
        )
      // Still pinned, and the switcher lists them in that order.
      await workspaceSwitcher().click()
      const listed = page
        .getByRole("dialog", { name: "Switch workspace" })
        .getByRole("button", { name: /^(storefront|api-service|mobile-app)/ })
        .elements()
        .map((button) => button.querySelector("strong")?.textContent)
      expect(listed.slice(0, 3)).toEqual(["api-service", "mobile-app", "storefront"])
    })

    it("unpins a pin dragged off the bar and let go there", async () => {
      arrange(["storefront", "api-service", "mobile-app"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      const from = pin("api-service").element().getBoundingClientRect()
      await userEvent.dragAndDrop(pin("api-service"), page.elementLocator(document.body), {
        sourcePosition: { x: from.width / 2, y: from.height / 2 },
        targetPosition: { x: from.left + from.width / 2, y: from.bottom + 160 },
        steps: 12,
        force: true,
      })

      await expect.poll(pinNames).toEqual(["1storefront", "2mobile-app"])
    })

    it("only by a drag: a click still switches", async () => {
      arrange(["storefront", "api-service", "mobile-app"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await pin("api-service").click()
      await expect.element(pin("api-service")).toHaveAttribute("aria-current", "true")
      expect(pinNames()).toEqual(["1storefront", "2api-service", "3mobile-app"])
    })

    it("by Alt and the arrows, with the focus kept, and never out of the bar", async () => {
      arrange(["storefront", "api-service", "mobile-app"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      pin("storefront").element().focus()
      await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}")
      await expect.poll(pinNames).toEqual(["1api-service", "2storefront", "3mobile-app"])
      await expect.element(pin("storefront")).toHaveFocus()
      await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}")
      await expect.poll(pinNames).toEqual(["1api-service", "2mobile-app", "3storefront"])
      // The last one stays pinned.
      await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}")
      expect(pinNames()).toEqual(["1api-service", "2mobile-app", "3storefront"])
      await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}")
      await expect.poll(pinNames).toEqual(["1api-service", "2storefront", "3mobile-app"])
      await expect.element(pin("storefront")).toHaveFocus()
    })
  })

  context("dragged from the switcher menu", () => {
    // Drags a project's row out of the open menu and lets it go at a point on the screen:
    // by default on the bar under the header, past its pins and the menu.
    // More steps leave more moves after the handoff, for what shows as the menu closes.
    const dragOut = async (
      name: string,
      to?: { x: number; y: number },
      steps = 16,
    ): Promise<void> => {
      // Once the menu has opened in full: a drag begun while it still slides in starts
      // off the row, and the drag never takes (seen once on a macOS runner).
      const from = await settled(() => switcherRow(name).element().getBoundingClientRect())
      const header = workspaceSwitcher().element().closest("header")!.getBoundingClientRect()
      await userEvent.dragAndDrop(switcherRow(name), page.elementLocator(document.body), {
        sourcePosition: { x: 40, y: from.height / 2 },
        targetPosition: to ?? { x: window.innerWidth - 80, y: header.bottom + 16 },
        steps,
        force: true,
      })
    }

    it("pins it where it is let go, after the pins it passes", async () => {
      arrange(["storefront", "api-service"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()

      await dragOut("mobile-app")

      await expect.element(pin("mobile-app")).toHaveTextContent("3mobile-app")
      // The menu closed as the drag left it, handing the bar a pin; it lists it as pinned.
      await expect
        .element(page.getByRole("dialog", { name: "Switch workspace" }))
        .not.toBeInTheDocument()
      await workspaceSwitcher().click()
      await expect.element(switcherRow("mobile-app").getByLabelText("Pinned")).toBeInTheDocument()
    })

    it("opens an empty bar for the drag, and the project becomes the first pin", async () => {
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await expect.element(pinsBar()).not.toBeInTheDocument()
      await workspaceSwitcher().click()

      await dragOut("docs-site")

      await expect.element(pin("docs-site")).toHaveTextContent("1docs-site")
    })

    it("says where to drop until the drag is let go, after the menu has closed", async () => {
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()
      await expect
        .element(page.getByRole("dialog", { name: "Switch workspace" }))
        .toHaveAttribute("data-state", "open")
      const from = await settled(() => switcherRow("docs-site").element().getBoundingClientRect())
      const header = workspaceSwitcher().element().closest("header")!.getBoundingClientRect()
      try {
        await pinPointer("press", { x: from.left + 40, y: from.top + from.height / 2 })
        await pinPointer("move", { x: window.innerWidth - 80, y: header.bottom + 16 })
        // Observe the committed handoff while the pointer is still down, instead of a
        // capture-phase sample that may precede the original drag's end and menu commit.
        await expect
          .poll(() => ({
            menu:
              page.getByRole("dialog", { name: "Switch workspace" }).query()?.dataset.state ===
              "open",
            dragging:
              document.querySelector('.pin[data-pin="docs-site"][data-dragging="true"]') !== null,
            hint: dropHint().checkVisibility({ visibilityProperty: true }),
            target: document.querySelector('.pins-bar[data-receiving="true"]') !== null,
          }))
          .toEqual({ menu: false, dragging: true, hint: true, target: true })
      } finally {
        await pinPointer("release")
      }
      await expect.element(pin("docs-site")).toHaveTextContent("1docs-site")
      await expect.poll(() => dropHint().checkVisibility({ visibilityProperty: true })).toBe(false)
      expect(document.querySelector('.pins-bar[data-receiving="true"]')).toBeNull()
    })

    it("marks a bar with pins as a place to drop, its words after them", async () => {
      arrange(["storefront", "api-service"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()
      let seen: {
        readonly hint: boolean
        readonly target: boolean
        readonly after: boolean
      } | null = null
      const moved = (): void => {
        if (!document.querySelector('.pin[data-pin="docs-site"][data-dragging="true"]')) return
        const last = pin("api-service").element().getBoundingClientRect()
        seen = {
          hint: dropHint().checkVisibility({ visibilityProperty: true }),
          target: document.querySelector('.pins-bar[data-receiving="true"]') !== null,
          after: dropHint().getBoundingClientRect().left >= last.right,
        }
      }
      window.addEventListener("pointermove", moved, true)

      await dragOut("docs-site")
      window.removeEventListener("pointermove", moved, true)

      expect(seen).toEqual({ hint: true, target: true, after: true })
      await expect.element(pin("docs-site")).toHaveTextContent("3docs-site")
      expect(document.querySelector('.pins-bar[data-receiving="true"]')).toBeNull()
    })

    it("keeps its words clear of the pins in a crowded bar", async () => {
      // Three pins in a narrow window, which the dragged one's slot fills: the words show
      // only after the last pin shown and that slot, or not at all.
      arrange(["storefront", "api-service", "mobile-app"])
      await page.viewport(620, 900)
      onTestFinished(() => page.viewport(1440, 900))
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()
      const overlaps: string[] = []
      let sampled = 0
      const moved = (): void => {
        if (!document.querySelector('.pin[data-pin="docs-site"][data-dragging="true"]')) return
        sampled++
        if (!dropHint().checkVisibility({ visibilityProperty: true })) return
        const left = dropHint().getBoundingClientRect().left
        // The pins shown, and the slot the dragged one holds, where it lands.
        for (const shown of document.querySelectorAll<HTMLElement>(
          ".pin[data-dnd-placeholder], .pin:not([inert]):not([data-dragging])",
        ))
          if (shown.getBoundingClientRect().right > left) overlaps.push(shown.dataset.pin!)
      }
      window.addEventListener("pointermove", moved, true)

      await dragOut("docs-site")
      window.removeEventListener("pointermove", moved, true)

      expect(sampled).toBeGreaterThan(0)
      expect(overlaps).toEqual([])
    })

    it("still reorders the list when dragged to its top, with the bar behind it", async () => {
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()
      await expect.poll(() => switcherOrder()[0]).toBeTruthy()
      const first = switcherOrder()[0]!
      // Where the list sits once the menu has opened in full: a point aimed at its top row
      // from before that lies above the list, which counts as out of it and hands the drag
      // to the bar.
      const top = await settled(() => switcherRow(first).element().getBoundingClientRect())
      await dragOut("docs-site", { x: top.left + 60, y: top.top + 6 })

      await expect.poll(() => switcherOrder()[0]).toBe("docs-site")
      await expectStaysAbsent(pin("docs-site"))
    })

    it("pins nothing when let go off the bar", async () => {
      arrange(["storefront"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()
      const before = switcherOrder()
      expect(before).toContain("mobile-app")
      await dragOut("mobile-app", { x: 700, y: 400 })
      await expectStaysAbsent(pin("mobile-app"))
      expect(pinsBar().getByRole("button").elements()).toHaveLength(1)
      // Nor does it move in the list.
      await workspaceSwitcher().click()
      await expect.poll(switcherOrder).toEqual(before)
    })

    it("pins nothing when Escape cancels the drag on the bar", async () => {
      arrange(["storefront"])
      await openWorkspace("/?demo=agents")
      await skipWelcome()
      await workspaceSwitcher().click()
      const before = switcherOrder()
      escapeOnceHandedOver("mobile-app")
      await dragOut("mobile-app")
      await expectStaysAbsent(pin("mobile-app"))
      expect(pinsBar().getByRole("button").elements()).toHaveLength(1)
      await workspaceSwitcher().click()
      await expect.poll(switcherOrder).toEqual(before)
    })
  })

  it("hides the pins that don't fit, and the dot covers them again", async () => {
    // Seven pins in a narrow window: the last, docs-site, has no room, so the dot shows
    // its question instead of leaving it out.
    arrange([
      "storefront",
      "api-service",
      "mobile-app",
      "design-system",
      "infra",
      "dotfiles",
      "docs-site",
    ])
    await page.viewport(600, 900)
    onTestFinished(() => page.viewport(1440, 900))
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    await expect.element(pin("storefront")).toBeVisible()
    await expect.element(pin("docs-site")).not.toBeInTheDocument()
    await expect.element(workspaceSwitcher()).toHaveAttribute("data-project-status", "question")
  })

  it("keeps the other pins where they are when switching", async () => {
    arrange(["storefront", "api-service", "docs-site", "mobile-app"])
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    const xs = () =>
      pinsBar()
        .getByRole("button")
        .elements()
        .map((button) => Math.round(button.getBoundingClientRect().right * 100) / 100)
    await pin("storefront").click()
    await expect.element(pin("storefront")).toHaveAttribute("aria-current", "true")
    const before = xs()
    // Each pin in turn becomes current, and every pin keeps its width, so none moves.
    for (const name of ["api-service", "docs-site", "mobile-app", "storefront"]) {
      // eslint-disable-next-line no-await-in-loop -- Each pin is current in turn.
      await pin(name).click()
      // eslint-disable-next-line no-await-in-loop -- Each pin is current in turn.
      await expect.element(pin(name)).toHaveAttribute("aria-current", "true")
      expect(xs()).toEqual(before)
    }
  })

  it("keeps a moved pin shown: the last shown pin can't step into the hidden ones", async () => {
    arrange([
      "storefront",
      "api-service",
      "mobile-app",
      "design-system",
      "infra",
      "dotfiles",
      "docs-site",
    ])
    await page.viewport(600, 900)
    onTestFinished(() => page.viewport(1440, 900))
    await openWorkspace("/?demo=agents")
    await skipWelcome()
    const shownNames = () =>
      pinsBar()
        .getByRole("button")
        .elements()
        .filter((button) => !button.hasAttribute("inert"))
        .map((button) => button.textContent)
    const before = shownNames()
    expect(before.length).toBeGreaterThan(1)
    expect(before.length).toBeLessThan(7)
    const lastShown = before[before.length - 1]!.replace(/^\d+/, "")
    const lastPin = pin(lastShown)
    expect(lastPin.element().getAttribute("aria-keyshortcuts")).not.toContain("Alt+ArrowRight")
    lastPin.element().focus()
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}")
    expect(shownNames()).toEqual(before)
    await expect.element(lastPin).toHaveFocus()
  })
})
