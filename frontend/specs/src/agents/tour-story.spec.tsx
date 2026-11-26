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
  coachSaysAny,
  consent,
  expectClickAt,
  expectClickAtWindows,
  paneOf,
  showMe,
  topTab,
  touchStep,
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

// Starts the tour from the footer's Help menu: the one agent every part of the story runs on is
// Novadeck's Pi, which the demo has in place.
const startTour = async (address = "/?channel=experimental"): Promise<void> => {
  await openWorkspace(address)
  await beginTour()
}

// The same, in the workspace already open.
const beginTour = async (): Promise<void> => {
  await takeTourFromHelp()
  await consent().getByRole("button", { name: "Start the tour" }).click()
  await expect.element(consent()).not.toBeInTheDocument()
}

const approval = (): Locator => page.getByRole("alertdialog")

// Presses what the tour marks until it marks the row saying `words`, then presses that: the
// Inbox's button first where it's shut, the row in the Inbox or in its toast.
const pressRow = async (words: string): Promise<void> => {
  const pressed = new Set<HTMLElement>()
  await expect
    .poll(
      async () => {
        const marked = clicked()[0]
        if (!marked) return false
        if (marked.textContent?.includes(words)) {
          await page.elementLocator(marked).click()
          return true
        }
        if (!pressed.has(marked)) {
          pressed.add(marked)
          await page.elementLocator(marked).click()
        }
        return false
      },
      { timeout: 20_000, interval: 400 },
    )
    .toBe(true)
}

// Opens the lead's sheet from the Inbox, as the tour points the person to: the Inbox's button,
// the row, then the sheet, whose answers it points at.
const openSheet = async (): Promise<Locator> => {
  await coachSays("Your call. What game?", 30_000)
  await pressRow("Which game shall we build?")
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

// The person lets the lead run the game's server, which it asks for before it hires anyone.
const allowRun = async (): Promise<void> => {
  await coachSays("It wants to run the game. Fine. Say yes.", 40_000)
  await approval().getByRole("button", { name: "Run command" }).click()
  await expect.element(approval()).not.toBeInTheDocument()
}

const captionNow = (): string =>
  document.querySelector('section[aria-label="Tour step"][data-shown]')?.textContent ?? ""

// The person clicks into the lead's page, as the tour waits for them to.
const seePage = (): Promise<void> =>
  touchStep("The game. Live. Empty, for now.", () => [paneOf("Game lead")], {
    cue: "The game's up.",
  })

// The person clicks one of the teammates the lead hired.
const meetTeam = (timeout = 40_000): Promise<void> =>
  touchStep(
    "Look. It hired its own help.",
    () => [windowNamed("Modeller"), windowNamed("Builder")],
    { timeout, cue: "It hired help." },
  )

// The person spins the Modeller's model.
const spinModel = (): Promise<void> =>
  touchStep("A model. From scratch. Go on, spin it.", () => [paneOf("Modeller")], {
    cue: "Its first model's in.",
  })

// The person opens Files from its button, as the box asks, which is all the step asks: its line
// about the blinks comes only then, held a moment before the story goes on.
const filesLine = "Every blink? An agent. Writing."
const openFiles = async (): Promise<void> => {
  if ((await coachSaysAny(["Open your Files.", filesLine])) !== filesLine) {
    await expect.poll(() => clicked().length, { timeout: 15_000 }).toBeGreaterThan(0)
    await page.elementLocator(clicked()[0]!).click()
    await coachSays(filesLine, 15_000)
  }
  await expect.poll(captionNow, { timeout: 20_000 }).not.toContain(filesLine)
}

// The person looks at the Builder's changes.
const readDiff = (): Promise<void> =>
  touchStep("What it wrote. Line by line.", () => [paneOf("Builder")], { cue: "Its code's in." })

// What the person does at each step that waits on them, by its line or its cue.
const personSteps: Readonly<Record<string, () => Promise<void>>> = {
  "The game's up.": seePage,
  "The game. Live. Empty, for now.": seePage,
  "It hired help.": meetTeam,
  "Look. It hired its own help.": meetTeam,
  "Its first model's in.": spinModel,
  "A model. From scratch. Go on, spin it.": spinModel,
  "Open your Files.": openFiles,
  [filesLine]: openFiles,
  "Its code's in.": readDiff,
  "What it wrote. Line by line.": readDiff,
}

// Plays on as the person, whatever step the tour is at, until its caption says `line`.
const playUntil = async (line: string, timeout = 150_000): Promise<void> => {
  const deadline = Date.now() + timeout
  for (;;) {
    const now = captionNow()
    if (now.includes(line)) return
    if (Date.now() > deadline) throw new Error(`The tour never said "${line}": it says "${now}"`)
    const step = Object.keys(personSteps).find((each) => now.includes(each))
    // eslint-disable-next-line no-await-in-loop -- Each step waits for the one before.
    await (step ? personSteps[step]!() : new Promise((resolve) => setTimeout(resolve, 300)))
  }
}

// Plays the story from the start to the closing card, with the person's answer and yes, checking
// what each step marks.
const playToClosing = async (address?: string): Promise<void> => {
  await startTour(address)

  // Act 1: the person's own agent, in Canvas.
  await coachSays("That's your agent. It runs this job.")
  await expect.element(view("Canvas")).toBeChecked()
  await expect.poll(terminalTabNames, { timeout: 15_000 }).toContain("Game lead")

  // Act 2: it asks the person what game to make.
  await coachSays("Your call. What game?", 30_000)
  await expect.element(page.getByText(/^Act 2, Your call\./)).toBeInTheDocument()
  await answerSheet("Sci-fi", "Shooter")

  // Still the person's call: it asks to run the game, which only the person allows, and hires no
  // one before they have: the approval has the screen to itself.
  await coachSays("It wants to run the game. Fine. Say yes.")
  await expect.element(page.getByText(/^Act 2, Your call\./)).toBeInTheDocument()
  await expect.element(approval()).toBeVisible()
  expect(windowNamed("Modeller")).toBeUndefined()
  expect(windowNamed("Builder")).toBeUndefined()
  const run = approval().getByRole("button", { name: "Run command" })
  await expect.poll(() => clicked()).toEqual([run.element()])
  await run.click()
  await expect.element(approval()).not.toBeInTheDocument()

  // Act 3: a terminal of its own opens, and the lead shows the game. The tour opens nothing and
  // moves on only once the person clicks into it.
  await expect.poll(() => windowNamed("Game server"), { timeout: 15_000 }).toBeDefined()
  await coachSays("The game. Live. Empty, for now.")
  await expect.element(page.getByText(/^Act 3, The team\./)).toBeInTheDocument()
  await expectClickAt(() => paneOf("Game lead"))
  await expect.poll(() => topTab(paneOf("Game lead"))).toContain("127.0.0.1")
  // It waits, however long: the team may be hired meanwhile, but the caption stays.
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  await coachSays("The game. Live. Empty, for now.")
  await seePage()

  // Then it hires a team, wired to it: the person clicks one.
  await coachSays("Look. It hired its own help.", 20_000)
  await expectClickAtWindows("Modeller", "Builder")
  expect(windowNamed("Game lead")).toBeDefined()
  await meetTeam()

  // The Modeller's model, in 3D, to spin.
  await coachSays("A model. From scratch. Go on, spin it.")
  await expectClickAt(() => paneOf("Modeller"))
  await expect.poll(() => topTab(paneOf("Modeller"))).toContain("hero.gltf")
  await spinModel()

  // The Files panel, where every agent's write blinks: the tour asks the person to open it and
  // points at its button, as it opens no panel itself; the line about the blinks waits for it.
  await coachSays("Open your Files.")
  await expect
    .poll(() => clicked().map((each) => each.getAttribute("data-tour-rail") ?? each.id))
    .toEqual(["files"])
  expect(captionNow()).not.toContain(filesLine)
  await openFiles()
  await expect.element(page.getByRole("treeitem", { name: /^hero\.gltf,/ })).toBeVisible()
  await expect.element(page.getByRole("treeitem", { name: /^main\.js,/ })).toBeVisible()

  // The Builder's pane, with its changes: while it isn't showing them, the box says they're in
  // and marks the Builder's window, whose press brings them.
  const diffLine = "What it wrote. Line by line."
  if ((await coachSaysAny(["Its code's in.", diffLine])) !== diffLine) {
    await expectClickAtWindows("Builder")
    await page
      .elementLocator(windowNamed("Builder")!.querySelector<HTMLElement>(".terminal-header")!)
      .click()
    await coachSays(diffLine)
  }
  await expectClickAt(() => paneOf("Builder"))
  await expect.poll(() => topTab(paneOf("Builder"))).toContain("build-game")
  await readDiff()

  // The team finishes what it started, and reports: only then does the story end.
  await coachSays("They're finishing it.", 60_000)

  // Act 4: the game in the lead's pane: the closing card comes a while after the person clicks
  // into it, never before. Where the lead's pane isn't showing it, the box's eye brings it.
  const playLine = "Three agents. Your game. Go play."
  if ((await coachSaysAny(["Your game's done.", playLine])) !== playLine) {
    await showMe().click()
    await coachSays(playLine)
  }
  await expect.element(page.getByText(/^Act 4, The result\./)).toBeInTheDocument()
  await expectClickAt(() => paneOf("Game lead"))
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  expect(closing().query()).toBeNull()
  await touchStep("Three agents. Your game. Go play.", () => [paneOf("Game lead")], { stays: true })
  await expect.element(closing(), { timeout: 60_000 }).toBeVisible()
  await expect.element(coach()).not.toBeInTheDocument()
  await expect.poll(() => closing().query()?.textContent ?? "").toContain("It's yours now.")
}

// The footer offers the tour only with its own switch on, in Preferences → Experimental.
beforeEach(switchTourOn)

describe("The tour's story", () => {
  it("shows the Worktrees panel in the tour's project even with Agent worktrees off, and only there", async () => {
    await openWorkspace("/?channel=experimental")
    await openPreferencesOn("Agents")
    const worktrees = preferencesDialog().getByRole("switch", { name: "Agent worktrees" })
    if ((await worktrees.element().getAttribute("aria-checked")) === "true") await worktrees.click()
    await expect.element(worktrees).toHaveAttribute("aria-checked", "false")
    await closePreferences()
    expect(sidebarPanel("Worktrees").query()).toBeNull()
    await beginTour()
    await answerSheet("Fantasy", "RPG")
    await allowRun()
    await seePage()
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

  it(
    "plays from the agent's start to its closing card, the person's answer and yes included",
    walks,
    async () => {
      await playToClosing()
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
      await playToClosing("/?channel=experimental&tourKeep=fails")
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
      // The Files panel the tour showed is still open: the terminals are listed in their panel.
      await sidebarPanel("Terminals").click()
      await expectSelected("Game lead")
      // The project stays.
      await expect.poll(() => workspaceSwitcher().element().textContent ?? "").toContain("Tour")
    },
  )

  it(
    "drops the run and page steps where the person says no, ending on the model",
    walks,
    async () => {
      await startTour()
      await answerSheet("Modern", "Strategy")
      await coachSays("It wants to run the game. Fine. Say yes.", 40_000)
      await approval().getByRole("button", { name: "Don't run" }).click()
      // Within seconds, with no terminal opened and no page shown, the story goes on without
      // them: the lead hires its team all the same.
      await coachSays("Look. It hired its own help.", 40_000)
      expect(windowNamed("Game server")).toBeUndefined()
      await playUntil("Three agents. Your game. Yours.")
      await expectClickAt(() => paneOf("Modeller"))
    },
  )

  it(
    "closes the card with its own button, keeping nothing and removing nothing",
    walks,
    async () => {
      await playToClosing()
      await closing().getByRole("button", { name: "Close" }).click()
      await expect.element(closing()).not.toBeInTheDocument()
      await expect.poll(() => workspaceSwitcher().element().textContent ?? "").toContain("Tour")
    },
  )

  it("takes the person's own words for the game, from the Inbox's sheet", walks, async () => {
    await startTour()
    const sheet = await openSheet()
    await sheet.getByRole("textbox", { name: /^Other: The world/ }).fill("underwater")
    // Words written turn no page: the person goes on to the next question's tab.
    await sheet.getByRole("tab", { name: /The kind/ }).click()
    await sheet
      .getByRole("radiogroup", { name: /The kind/ })
      .getByText("RPG")
      .click()
    await sheet.getByRole("button", { name: "Submit answers" }).click()
    await coachSays("It wants to run the game. Fine. Say yes.", 30_000)
  })

  it(
    "leaves out the run and page steps where there is no page, and ends on the model",
    walks,
    async () => {
      await startTour("/?channel=experimental&tourPage=none")
      await answerSheet("Fantasy", "RPG")
      // No command to approve: the next thing is the team, then the model.
      await meetTeam()
      expect(approval().query()).toBeNull()
      expect(windowNamed("Game server")).toBeUndefined()
      await coachSays("A model. From scratch. Go on, spin it.", 30_000)
      await playUntil("Three agents. Your game. Yours.")
      // Nothing to play: the model is what is left to look at.
      await expectClickAt(() => paneOf("Modeller"))
      await touchStep("Three agents. Your game. Yours.", () => [paneOf("Modeller")], {
        stays: true,
      })
      await expect.element(closing(), { timeout: 30_000 }).toBeVisible()
    },
  )

  it("nudges a modeller gone quiet, which then shows its model", walks, async () => {
    await startTour("/?channel=experimental&tourModeller=quiet&tourPatienceMs=1500")
    await answerSheet("Sci-fi", "RPG")
    await allowRun()
    await seePage()
    // Silent, it never names itself; the tour rings the lead after its wait, and the story goes
    // on.
    await coachSays("Look. It hired its own help.", 30_000)
    await expect.poll(() => windowNamed("Modeller"), { timeout: 20_000 }).toBeDefined()
    await playUntil("A model. From scratch. Go on, spin it.", 60_000)
  })

  it(
    "offers to bring back what the step is about once the person has gone elsewhere, and never takes them back by itself",
    walks,
    async () => {
      await startTour()
      await answerSheet("Fantasy", "RPG")
      await allowRun()
      await playUntil("Open your Files.")
      await openFiles()
      // The person opens a file instead of looking at the Builder's changes: its preview takes the
      // view, and the Builder is out of sight.
      await coachSaysAny(["Its code's in.", "What it wrote. Line by line."])
      await page
        .getByRole("treeitem", { name: /^index\.html/ })
        .first()
        .click()
      await expect.poll(() => clicked().length, { timeout: 15_000 }).toBe(0)
      const show = showMe()
      await expect.element(show, { timeout: 15_000 }).toBeVisible()
      // It waits: the view stays where the person took it.
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      expect(clicked()).toEqual([])
      await show.click()
      await expectClickAt(() => paneOf("Builder"))
      await coachSays("What it wrote. Line by line.")
      await readDiff()
    },
  )

  it("offers to open the Inbox in Zen, where the rail is hidden", walks, async () => {
    await startTour()
    await coachSays("That's your agent. It runs this job.")
    await page.getByRole("button", { name: "Enter Zen mode" }).click()
    // Its button out of sight, the step says so a moment later and offers to open it.
    const show = page.getByRole("region", { name: "Tour step" }).getByRole("button", {
      name: "Show me",
    })
    await expect.poll(captionNow, { timeout: 40_000 }).toContain("Your call. What game?")
    await expect.element(show, { timeout: 15_000 }).toBeVisible()
    await show.click()
    await expect
      .poll(() => clicked()[0]?.textContent ?? "", { timeout: 15_000 })
      .toContain("Which game shall we build?")
  })

  it(
    "points at a teammate's own question in the Inbox until the person answers it",
    walks,
    async () => {
      await startTour("/?channel=experimental&tourMate=asks")
      await answerSheet("Fantasy", "Shooter")
      await allowRun()
      // The Modeller asks as soon as its first model is up: the tour points at the question,
      // whatever step it is at, until the person answers it, and opens the Inbox no more than
      // anything else: it points at its button.
      await playUntil("A teammate has a question for you.", 60_000)
      await pressRow("What colour should the hero be?")
      const sheet = page.getByRole("dialog", { name: "Modeller" })
      const pick = sheet.getByRole("button", { name: /Blue/ })
      await standsStill(pick)
      await pick.click()
      // Answered, the story goes on where it was.
      await playUntil("Three agents. Your game. Go play.")
    },
  )
})
