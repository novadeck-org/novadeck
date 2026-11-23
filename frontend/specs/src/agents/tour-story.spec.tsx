import { beforeEach } from "vitest"
import { page, type Locator } from "vitest/browser"

import { switchTourOn, takeTourFromHelp } from "../support/help"
import { closePreferences, openPreferencesOn, preferencesDialog } from "../support/keyboard"
import { switchProject, workspaceSwitcher } from "../support/sessions"
import {
  clicked,
  closing,
  coach,
  coachSays,
  consent,
  expectLookAt,
  expectLookAtWindows,
  looked,
  paneOf,
  topTab,
  windowNamed,
} from "../support/tour"
import {
  expectSelected,
  openWorkspace,
  sidebarPanel,
  terminalTabNames,
  view,
} from "../support/workspace"
import { describe, expect, it } from "../test"

const inboxRow = (words: RegExp): Locator =>
  page.getByRole("list", { name: "Messages from your agents" }).getByRole("button", {
    name: new RegExp(`^(?!(?:Dismiss|Snooze|Unsnooze): ).*(?:${words.source})`),
  })

// Waits until what `locator` finds stops moving: a sheet's card moves as its context comes in.
const standsStill = async (locator: Locator): Promise<void> => {
  let last = Number.NaN
  await expect
    .poll(
      async () => {
        const before = last
        last = locator.element().getBoundingClientRect().top
        await new Promise((resolve) => setTimeout(resolve, 450))
        return before === last && locator.element().getBoundingClientRect().top === last
      },
      { timeout: 10_000, interval: 0 },
    )
    .toBe(true)
}

// The whole story, with its holds, takes about a minute on screen.
const walks = { timeout: 240_000 }

// Starts the tour from the footer's Help menu with `name` (Claude Code or Codex), connected first
// in Preferences' Agents: the one agent every part of the story runs on.
const startTour = async (
  name = "Claude Code",
  address = "/?channel=experimental",
): Promise<void> => {
  await openWorkspace(address)
  await beginTour(name)
}

// The same, in the workspace already open.
const beginTour = async (name = "Claude Code"): Promise<void> => {
  await openPreferencesOn("Agents")
  const agent = preferencesDialog().getByRole("switch", { name })
  await agent.click()
  await expect.element(agent).toHaveAttribute("aria-checked", "true")
  await closePreferences()
  await takeTourFromHelp()
  await consent().getByRole("button", { name: "Start the tour" }).click()
  await expect.element(consent()).not.toBeInTheDocument()
}

const approval = (): Locator => page.getByRole("alertdialog")

// Opens the lead's sheet from the Inbox, as the tour points the person to: the row first, then
// the sheet, whose answers it points at.
const openSheet = async (): Promise<Locator> => {
  await coachSays("Your call. What game?", 30_000)
  await expect
    .poll(() => clicked()[0]?.textContent ?? "", { timeout: 15_000 })
    .toContain("Which game shall we build?")
  await inboxRow(/Which game shall we build/).click()
  const sheet = page.getByRole("dialog", { name: "Game lead" })
  const worlds = sheet.getByRole("radiogroup", { name: /The world/ })
  // Pressed once the card stands still: a click just after it moved is held back.
  await standsStill(worlds)
  // The tour now points at the answers.
  await expect
    .poll(() => clicked()[0]?.textContent ?? "", { timeout: 15_000 })
    .toMatch(/The world.*Fantasy.*Sci-fi.*Modern/s)
  return sheet
}

// Answers the lead's sheet: a world and a kind of game.
const answerSheet = async (world: string, kind: string): Promise<void> => {
  const sheet = await openSheet()
  await sheet
    .getByRole("radiogroup", { name: /The world/ })
    .getByText(world)
    .click()
  await sheet
    .getByRole("radiogroup", { name: /The kind/ })
    .getByText(kind)
    .click()
  await sheet.getByRole("button", { name: "Submit answers" }).click()
  await expect.element(sheet).not.toBeInTheDocument()
}

// Plays the story from the start to the closing card, with the person's answer and yes, checking
// what each step marks.
const playToClosing = async (name: string, address?: string): Promise<void> => {
  await startTour(name, address)

  // Act 1: the person's own agent, in Canvas.
  await coachSays("That's your agent. It runs this job.")
  await expect.element(view("Canvas")).toBeChecked()
  await expect.poll(terminalTabNames, { timeout: 15_000 }).toContain("Game lead")

  // Act 2: it asks the person what game to make.
  await coachSays("Your call. What game?", 30_000)
  await expect.element(page.getByText(/^Act 2, Your call\./)).toBeInTheDocument()
  await answerSheet("Sci-fi", "Shooter")

  // Act 3: it hires a team, wired to it, and the camera frames them.
  await coachSays("Look. It hired its own help.")
  await expect.element(page.getByText(/^Act 3, The team\./)).toBeInTheDocument()
  await expectLookAtWindows("Modeller", "Builder")
  expect(windowNamed("Game lead")).toBeDefined()

  // It asks to run the game, which only the person allows.
  await coachSays("It wants to run the game. Fine. Say yes.")
  await expect.element(approval()).toBeVisible()
  const run = approval().getByRole("button", { name: "Run command" })
  await expect.poll(() => clicked()).toEqual([run.element()])
  await run.click()
  await expect.element(approval()).not.toBeInTheDocument()

  // A terminal of its own opens, and the lead shows the game: its pane is what to look at.
  await expect.poll(() => windowNamed("Game server"), { timeout: 15_000 }).toBeDefined()
  await coachSays("The game. Live. It fills in as they write.")
  await expectLookAt(() => paneOf("Game lead"))
  await expect.poll(() => topTab(paneOf("Game lead"))).toContain("127.0.0.1")

  // The Modeller's model, in 3D.
  await coachSays("A model. From scratch. Go on, spin it.")
  await expectLookAt(() => paneOf("Modeller"))
  await expect.poll(() => topTab(paneOf("Modeller"))).toContain("hero.gltf")

  // The Files panel, where every agent's write blinks.
  await coachSays("Every blink? An agent. Writing.")
  await expect.poll(() => looked().map((each) => each.id)).toEqual(["files-panel"])
  await expect.element(page.getByRole("treeitem", { name: /^hero\.gltf,/ })).toBeVisible()
  await expect.element(page.getByRole("treeitem", { name: /^main\.js,/ })).toBeVisible()

  // The Builder's pane, with its changes.
  await coachSays("What it wrote. Line by line.")
  await expectLookAt(() => paneOf("Builder"))
  await expect.poll(() => topTab(paneOf("Builder"))).toContain("build-game")

  // Act 4: the game in the lead's pane, and then the closing card.
  await coachSays("Three agents. Your game. Go play.")
  await expect.element(page.getByText(/^Act 4, The result\./)).toBeInTheDocument()
  await expectLookAt(() => paneOf("Game lead"))
  await expect.element(closing(), { timeout: 60_000 }).toBeVisible()
  await expect.element(coach()).not.toBeInTheDocument()
  await expect.poll(() => closing().query()?.textContent ?? "").toContain("It's yours now.")
}

// The footer offers the tour only with its own switch on, in Preferences → Experimental.
beforeEach(switchTourOn)

describe("The tour's story", () => {
  it("shows the Worktrees panel in the tour's project even with Agent worktrees off, and only there", async () => {
    await openWorkspace("/?channel=experimental")
    await openPreferencesOn("Experimental")
    const worktrees = preferencesDialog().getByRole("switch", { name: "Agent worktrees" })
    if ((await worktrees.element().getAttribute("aria-checked")) === "true") await worktrees.click()
    await expect.element(worktrees).toHaveAttribute("aria-checked", "false")
    await closePreferences()
    expect(sidebarPanel("Worktrees").query()).toBeNull()
    await beginTour()
    await answerSheet("Fantasy", "RPG")
    // The teammates open their worktrees: the panel is there to show them.
    await coachSays("Look. It hired its own help.", 20_000)
    await expect.poll(() => sidebarPanel("Worktrees").query(), { timeout: 15_000 }).not.toBeNull()
    await sidebarPanel("Worktrees").click()
    await expect.element(page.getByText("models", { exact: true }).first()).toBeVisible()
    await expect.element(page.getByText("game", { exact: true }).first()).toBeVisible()
    // Another project has none, as the setting says.
    await switchProject("storefront")
    await expect.poll(() => sidebarPanel("Worktrees").query()).toBeNull()
  })

  it.for(["Claude Code", "Codex"])(
    "plays from the agent's start to its closing card, the person's answer and yes included, with %s",
    walks,
    async (name) => {
      await playToClosing(name)
      // The tour is the person's now: the card offers a way on, and to remove the project. The
      // demo has no folder picker to open a project with, so it offers none.
      expect(closing().getByRole("button", { name: "Open your own project" }).query()).toBeNull()
      await closing().getByRole("button", { name: "Remove the Tour project" }).click()
      await expect.poll(() => workspaceSwitcher().element().textContent ?? "").not.toContain("Tour")
      expect(closing().getByRole("button", { name: "Remove the Tour project" }).query()).toBeNull()
      await closing().getByRole("button", { name: "Close" }).click()
      await expect.element(closing()).not.toBeInTheDocument()
    },
  )

  it(
    "keeps the project by itself as the story ends, says why where that fails with another try, and Keep building lands on the lead in Focus",
    walks,
    async () => {
      await playToClosing("Claude Code", "/?channel=experimental&tourKeep=fails")
      await expect
        .poll(() => closing().query()?.textContent ?? "", { timeout: 10_000 })
        .toContain("Novadeck couldn't keep the project: AGENTS.md can't be written in this folder.")
      await closing().getByRole("button", { name: "Try again" }).click()
      await expect
        .poll(() => closing().query()?.textContent ?? "", { timeout: 10_000 })
        .not.toContain("couldn't keep")
      await closing().getByRole("button", { name: "Keep building" }).click()
      await expect.element(closing()).not.toBeInTheDocument()
      // The lead's terminal is in view in Focus, for the person to tell it what to build next.
      await expect.element(view("Focus")).toBeChecked()
      await expectSelected("Game lead")
      // The project stays.
      await expect.poll(() => workspaceSwitcher().element().textContent ?? "").toContain("Tour")
    },
  )

  it(
    "drops the run and page steps where the person says no, ending on the model",
    walks,
    async () => {
      await startTour("Claude Code")
      await answerSheet("Modern", "Strategy")
      await coachSays("It wants to run the game. Fine. Say yes.", 40_000)
      await approval().getByRole("button", { name: "Don't run" }).click()
      // Within seconds, with no terminal opened and no page shown, the story goes on without them.
      await coachSays("A model. From scratch. Go on, spin it.", 40_000)
      expect(windowNamed("Game server")).toBeUndefined()
      await coachSays("Three agents. Your game. Yours.", 120_000)
      await expectLookAt(() => paneOf("Modeller"))
    },
  )

  it(
    "closes the card with its own button, keeping nothing and removing nothing",
    walks,
    async () => {
      await playToClosing("Claude Code")
      await closing().getByRole("button", { name: "Close" }).click()
      await expect.element(closing()).not.toBeInTheDocument()
      await expect.poll(() => workspaceSwitcher().element().textContent ?? "").toContain("Tour")
    },
  )

  it("takes the person's own words for the game, from the Inbox's sheet", walks, async () => {
    await startTour("Claude Code")
    const sheet = await openSheet()
    await sheet.getByRole("textbox", { name: /^Other: The world/ }).fill("underwater")
    // Words written turn no page: the person goes on to the next question's tab.
    await sheet.getByRole("tab", { name: /The kind/ }).click()
    await sheet
      .getByRole("radiogroup", { name: /The kind/ })
      .getByText("RPG")
      .click()
    await sheet.getByRole("button", { name: "Submit answers" }).click()
    await coachSays("Look. It hired its own help.", 30_000)
  })

  it(
    "leaves out the run and page steps where there is no page, and ends on the model",
    walks,
    async () => {
      await startTour("Claude Code", "/?channel=experimental&tourPage=none")
      await answerSheet("Fantasy", "RPG")
      await coachSays("Look. It hired its own help.")
      // No command to approve: the next thing is the model.
      await coachSays("A model. From scratch. Go on, spin it.", 30_000)
      expect(approval().query()).toBeNull()
      expect(windowNamed("Game server")).toBeUndefined()
      await coachSays("Every blink? An agent. Writing.", 30_000)
      await coachSays("What it wrote. Line by line.", 30_000)
      // Nothing to play: the model is what is left to look at.
      await coachSays("Three agents. Your game. Yours.", 30_000)
      await expectLookAt(() => paneOf("Modeller"))
      await expect.element(closing(), { timeout: 30_000 }).toBeVisible()
    },
  )

  it("nudges a modeller gone quiet, which then shows its model", walks, async () => {
    await startTour("Claude Code", "/?channel=experimental&tourModeller=quiet&tourPatienceMs=1500")
    await answerSheet("Sci-fi", "RPG")
    await coachSays("Look. It hired its own help.")
    // Silent, it never names itself; the tour rings the lead after its wait, and the team goes on
    // to the game's command, which the person allows.
    await coachSays("It wants to run the game. Fine. Say yes.", 40_000)
    await approval().getByRole("button", { name: "Run command" }).click()
    await expect.poll(() => windowNamed("Modeller"), { timeout: 20_000 }).toBeDefined()
    await coachSays("A model. From scratch. Go on, spin it.", 30_000)
  })

  it(
    "points at a teammate's own question in the Inbox until the person answers it",
    walks,
    async () => {
      await startTour("Claude Code", "/?channel=experimental&tourMate=asks")
      await answerSheet("Fantasy", "Shooter")
      // The Modeller asks as soon as its first model is up: the tour points at the question,
      // whatever step it is at, until the person answers it.
      await coachSays("A teammate has a question for you.", 40_000)
      await expect
        .poll(() => clicked()[0]?.textContent ?? "", { timeout: 15_000 })
        .toContain("What colour should the hero be?")
      await inboxRow(/What colour should the hero be/).click()
      const sheet = page.getByRole("dialog", { name: "Modeller" })
      const pick = sheet.getByRole("button", { name: /Blue/ })
      await standsStill(pick)
      await pick.click()
      // Answered, the story goes on where it was.
      await coachSays("It wants to run the game. Fine. Say yes.", 40_000)
      await approval().getByRole("button", { name: "Run command" }).click()
      await coachSays("Three agents. Your game. Go play.", 60_000)
    },
  )
})
