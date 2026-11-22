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

// Answers the Sculptor's question from the Inbox, as the tour points the person to: the row
// first, then the answer of the sheet it opens.
const answerHero = async (answer: RegExp): Promise<void> => {
  await coachSays("Your call. Who's the hero?")
  await expect
    .poll(() => clicked()[0]?.textContent ?? "", { timeout: 15_000 })
    .toContain("Who is your game's hero?")
  await inboxRow(/Who is your game's hero/).click()
  const sheet = page.getByRole("dialog", { name: "Sculptor" })
  // Pressed once the card stands still: a click just after it moved is held back.
  const pick = sheet.getByRole("button", { name: answer })
  await standsStill(pick)
  // The tour now points at the answers.
  await expect
    .poll(() => clicked()[0]?.textContent ?? "", { timeout: 15_000 })
    .toMatch(/A rocket.*A robot.*A cat/s)
  await pick.click()
}

// Plays the story from the start to the closing card, with the person's yes and answer, checking
// what each step marks.
const playToClosing = async (name: string, address?: string): Promise<void> => {
  await startTour(name, address)

  // Act 1: the person's own agent, in Canvas.
  await coachSays("Your own agent. It leads the build.")
  await expect.element(view("Canvas")).toBeChecked()
  await expect.poll(terminalTabNames, { timeout: 15_000 }).toContain("Game lead")

  // Act 2: it hires a team, wired to it, and the camera frames them.
  await coachSays("It hired a team.")
  await expect.element(page.getByText(/^Act 2, The team\./)).toBeInTheDocument()
  await expectLookAtWindows("Sculptor", "Score fixer")
  expect(windowNamed("Game lead")).toBeDefined()

  // It asks to run the game, which only the person allows.
  await coachSays("They want to run the game. Say yes.")
  await expect.element(approval()).toBeVisible()
  const run = approval().getByRole("button", { name: "Run command" })
  await expect.poll(() => clicked()).toEqual([run.element()])
  await run.click()
  await expect.element(approval()).not.toBeInTheDocument()

  // A terminal of its own opens, and the lead shows the game: its pane is what to look at.
  await expect.poll(terminalTabNames, { timeout: 15_000 }).toContain("Game server")
  await coachSays("The game, live. Still plain.")
  await expectLookAt(() => paneOf("Game lead"))
  await expect.poll(() => topTab(paneOf("Game lead"))).toContain("127.0.0.1")

  // The Sculptor's model, as it is so far: a ball and a box.
  await coachSays("The hero so far. A ball and a box.")
  await expectLookAt(() => paneOf("Sculptor"))
  await expect.poll(() => topTab(paneOf("Sculptor"))).toContain("hero.gltf")

  // Act 3: the Sculptor asks, and the person answers.
  await answerHero(/A robot/)
  await expect.element(page.getByText(/^Act 3, Your call\./)).toBeInTheDocument()

  // The Files panel, where every agent's write blinks.
  await coachSays("Every blink is an agent writing.")
  await expect.poll(() => looked().map((each) => each.id)).toEqual(["files-panel"])
  await expect.element(page.getByRole("treeitem", { name: /^hero\.gltf,/ })).toBeVisible()
  await expect.element(page.getByRole("treeitem", { name: /^score\.js,/ })).toBeVisible()

  // The Sculptor's pane, its model in 3D, and the Score fixer's, with its changes.
  await coachSays("Your hero, in 3D. Spin it.")
  await expectLookAt(() => paneOf("Sculptor"))
  await expect.poll(() => topTab(paneOf("Sculptor"))).toContain("hero.gltf")
  await coachSays("It shows what it changed.")
  await expectLookAt(() => paneOf("Score fixer"))
  await expect.poll(() => topTab(paneOf("Score fixer"))).toContain("fix-score")

  // An agent on no team, which the tour started in a terminal of its own.
  await coachSays("Another agent. Not on the team.")
  await expectLookAtWindows("Cover artist")
  await coachSays("It found the lead by itself. And asked.")
  await expectLookAt(() => paneOf("Cover artist"))
  await expect.poll(() => topTab(paneOf("Cover artist"))).toContain("Messages")
  await coachSays("Its cover. For your game.")
  await expectLookAt(() => paneOf("Cover artist"))
  await expect.poll(() => topTab(paneOf("Cover artist"))).toContain("cover.svg")

  // Act 4: the finished game in the lead's pane, and then the closing card.
  await coachSays("Four agents. One game. Play it.")
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
    // The teammates open their worktrees: the panel is there to show them.
    await coachSays("It hired a team.", 20_000)
    await expect.poll(() => sidebarPanel("Worktrees").query(), { timeout: 15_000 }).not.toBeNull()
    await sidebarPanel("Worktrees").click()
    await expect.element(page.getByText("fix-score").first()).toBeVisible()
    await expect.element(page.getByText("hero", { exact: true }).first()).toBeVisible()
    // Another project has none, as the setting says.
    await switchProject("storefront")
    await expect.poll(() => sidebarPanel("Worktrees").query()).toBeNull()
  })

  it.for(["Claude Code", "Codex"])(
    "plays from the agent's start to its closing card, the person's yes and answer included, with %s",
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
      await coachSays("They want to run the game. Say yes.", 40_000)
      await approval().getByRole("button", { name: "Don't run" }).click()
      // Within seconds, with no terminal opened and no page shown, the story goes on without them.
      await coachSays("The hero so far. A ball and a box.", 40_000)
      expect(terminalTabNames()).not.toContain("Game server")
      await answerHero(/A cat/)
      await coachSays("Four agents. One game. Yours.", 120_000)
      await expectLookAt(() => paneOf("Sculptor"))
    },
  )

  it(
    "drops the artist's steps where its agent never starts, and counts three agents",
    walks,
    async () => {
      await startTour("Claude Code", "/?channel=experimental&tourArtist=never&tourPatienceMs=2000")
      await coachSays("They want to run the game. Say yes.", 40_000)
      await approval().getByRole("button", { name: "Run command" }).click()
      await answerHero(/A rocket/)
      await coachSays("Three agents. One game. Play it.", 120_000)
      await expectLookAt(() => paneOf("Game lead"))
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

  it("takes the person's own words as the hero, from the Inbox's sheet", walks, async () => {
    await startTour("Claude Code")
    await coachSays("They want to run the game. Say yes.", 40_000)
    await approval().getByRole("button", { name: "Run command" }).click()
    await coachSays("Your call. Who's the hero?", 40_000)
    await inboxRow(/Who is your game's hero/).click()
    const sheet = page.getByRole("dialog", { name: "Sculptor" })
    const own = sheet.getByRole("textbox")
    await standsStill(own)
    await own.fill("a dragon named Ash")
    await sheet.getByRole("button", { name: /^(Send|Reply)/ }).click()
    await coachSays("Every blink is an agent writing.", 30_000)
  })

  it(
    "leaves out the run and page steps where there is no page, and ends on the model",
    walks,
    async () => {
      await startTour("Claude Code", "/?channel=experimental&tourPage=none")
      await coachSays("It hired a team.")
      // No command to approve: the next thing asked of the person is the hero.
      await coachSays("Your call. Who's the hero?", 30_000)
      expect(approval().query()).toBeNull()
      expect(terminalTabNames()).not.toContain("Game server")
      await answerHero(/A cat/)
      await coachSays("Every blink is an agent writing.", 30_000)
      await coachSays("Your hero, in 3D. Spin it.")
      await coachSays("Another agent. Not on the team.", 40_000)
      await coachSays("Its cover. For your game.", 40_000)
      // Nothing to play: the model is what is left to look at.
      await coachSays("Four agents. One game. Yours.", 30_000)
      await expectLookAt(() => paneOf("Sculptor"))
      await expect.element(closing(), { timeout: 30_000 }).toBeVisible()
    },
  )

  it("nudges a sculptor gone quiet, which then opens its worktree and asks", walks, async () => {
    await startTour("Claude Code", "/?channel=experimental&tourSculptor=quiet&tourPatienceMs=1500")
    await coachSays("It hired a team.")
    // Silent, it never names itself; the tour rings the lead after its wait, and the team goes on
    // to the game's command, which the person allows.
    await coachSays("They want to run the game. Say yes.", 40_000)
    await approval().getByRole("button", { name: "Run command" }).click()
    await expect.poll(terminalTabNames, { timeout: 20_000 }).toContain("Sculptor")
    await coachSays("The hero so far. A ball and a box.", 30_000)
  })

  it("nudges an artist gone quiet, which then names itself", walks, async () => {
    await startTour("Claude Code", "/?channel=experimental&tourArtist=quiet&tourPatienceMs=1500")
    await coachSays("They want to run the game. Say yes.", 30_000)
    await approval().getByRole("button", { name: "Run command" }).click()
    await answerHero(/A rocket/)
    await coachSays("Another agent. Not on the team.", 60_000)
    await expect.poll(terminalTabNames, { timeout: 30_000 }).toContain("Cover artist")
    await coachSays("It found the lead by itself. And asked.", 30_000)
  })
})
