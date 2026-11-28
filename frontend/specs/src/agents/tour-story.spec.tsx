import { page, userEvent, type Locator } from "vitest/browser"

import { takeTourFromHelp } from "../support/help"
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
  paneOf,
  showMe,
  topTab,
  touchStep,
  windowNamed,
} from "../support/tour"
import {
  expectSelected,
  nameOf,
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
// Nova, which the demo has in place.
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

// The pitches the lead offers (the demo's, `frontend/demo/src/tour/content.ts`).
const pitches = ["Glass Desert Drift", "Neon Magnet Rush", "Carnival Beat Cat"] as const

// Opens the lead's pitch from the Inbox, as the tour points the person to: the Inbox's button,
// the row, then the sheet, whose answers it points at.
const openPitch = async (): Promise<Locator> => {
  await coachSays("Your call. What game? Make it a good one.", 30_000)
  await pressRow("Which game shall we build?")
  const sheet = page.getByRole("dialog", { name: "Game lead" })
  // Pressed once the card stands still: a click just after it moved is held back.
  await standsStill(sheet.getByRole("group", { name: "Answers" }))
  // The tour now points at the answers.
  await expect
    .poll(() => clicked()[0]?.textContent ?? "", { timeout: 15_000 })
    .toContain(pitches[0])
  return sheet
}

// Answers the lead's pitch: the game picked.
const answerPitch = async (game: (typeof pitches)[number] = pitches[0]): Promise<void> => {
  const sheet = await openPitch()
  await sheet.getByRole("button", { name: new RegExp(`^${game}`) }).click()
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
const pageLine = "There. Just a showcase. Wait for yours."
const seePage = (): Promise<void> =>
  touchStep(pageLine, () => [paneOf("Game lead")], { cue: "Your game's running. Go look." })

// The person clicks one of the teammates the lead hired.
const teamLine = "Look. It hired its own help. Without asking me?"
const meetTeam = (timeout = 40_000): Promise<void> =>
  touchStep(teamLine, () => [windowNamed("Core"), windowNamed("World"), windowNamed("Feel")], {
    timeout,
    cue: "New agents? Go find them.",
  })

// The person reads the Messages of the teammate that wrote to another teammate, World.
const talkLine = "Agent to agent. Not through me."
const hearTalk = (): Promise<void> =>
  touchStep(talkLine, () => [paneOf("World")], { cue: "They're talking. Go listen." })

// The person spins World's model.
const spinModel = (): Promise<void> =>
  touchStep("A model, made from nothing. Go on. Spin it.", () => [paneOf("World")], {
    cue: "Its first model's done. Have a look.",
  })

// What the person does at each step that waits on them, by its line or its cue.
const personSteps: Readonly<Record<string, () => Promise<void>>> = {
  "Your game's running. Go look.": seePage,
  [pageLine]: seePage,
  "New agents? Go find them.": meetTeam,
  [teamLine]: meetTeam,
  "They're talking. Go listen.": hearTalk,
  [talkLine]: hearTalk,
  "Its first model's done. Have a look.": spinModel,
  "A model, made from nothing. Go on. Spin it.": spinModel,
}

// Plays on as the person, whatever step the tour is at, until its caption says `line`.
const playUntil = async (words: string | readonly string[], timeout = 150_000): Promise<void> => {
  const lines = typeof words === "string" ? [words] : words
  const line = lines.join('" or "')
  const deadline = Date.now() + timeout
  for (;;) {
    const now = captionNow()
    if (lines.some((each) => now.includes(each))) return
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
  await coachSays("That's your agent. It does the work. I talk.")
  await expect.element(view("Canvas")).toBeChecked()
  await expect.poll(terminalTabNames, { timeout: 15_000 }).toContain("Game lead")

  // Act 2: it pitches three games, and asks the person what game to make.
  await coachSays("Your call. What game? Make it a good one.", 30_000)
  await expect.element(page.getByText(/^Act 2, Your call\./)).toBeInTheDocument()
  await answerPitch(pitches[0])

  // Still the person's call: it asks to run the game, which only the person allows, and hires no
  // one before they have: the approval has the screen to itself.
  await coachSays("It wants to run the game. Fine. Say yes.")
  await expect.element(page.getByText(/^Act 2, Your call\./)).toBeInTheDocument()
  await expect.element(approval()).toBeVisible()
  expect(windowNamed("Core")).toBeUndefined()
  expect(windowNamed("World")).toBeUndefined()
  const run = approval().getByRole("button", { name: "Run command" })
  await expect.poll(() => clicked()).toEqual([run.element()])
  await run.click()
  await expect.element(approval()).not.toBeInTheDocument()

  // Act 3: a terminal of its own opens, the lead hires a team, wired to it, and the person clicks
  // one. The tour opens nothing and moves on only once the person does.
  await expect.poll(() => windowNamed("Game server"), { timeout: 15_000 }).toBeDefined()
  await coachSays(teamLine, 20_000)
  await expect.element(page.getByText(/^Act 3, The team\./)).toBeInTheDocument()
  // Marks the teammates' windows that are in sight: on Canvas the third may land past the edge.
  await expect
    .poll(
      () =>
        clicked()
          .map((each) => nameOf(each.getAttribute("aria-label") ?? "").replace(/ terminal$/, ""))
          .filter((name) => ["Core", "World", "Feel"].includes(name)).length,
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(2)
  expect(windowNamed("Game lead")).toBeDefined()
  await meetTeam()

  // The lead shows the game: the kit's showcase, until the team's work lands. It waits for the
  // person to click into it, however long.
  await coachSaysAny([pageLine, "Your game's running. Go look."])
  await expectClickAt(() => paneOf("Game lead"))
  await expect.poll(() => topTab(paneOf("Game lead"))).toContain("127.0.0.1")
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  await coachSaysAny([pageLine, "Your game's running. Go look."])
  await seePage()

  // The teammates talk to each other, not through the lead: the person reads one's Messages.
  await coachSaysAny([talkLine, "They're talking. Go listen."], 20_000)
  await hearTalk()

  // World's model, in 3D, to spin: the box's cue first where its pane isn't showing it.
  await coachSaysAny([
    "A model, made from nothing. Go on. Spin it.",
    "Its first model's done. Have a look.",
  ])
  await spinModel()
  await expect.poll(() => topTab(paneOf("World"))).toContain("hero.gltf")

  // The first versions land and the page changes, then the polishing round; the team finishes
  // what it started and says so: only then does the story end.
  await coachSays("First versions are in. Watch your page change.", 60_000)
  await coachSays("Polishing now. See it change again.", 60_000)
  await coachSays("They're finishing it. Relax.", 60_000)

  // Act 4: the game in the lead's pane: the closing card comes a while after the person clicks
  // into it, never before. Where the lead's pane isn't showing it, the box's eye brings it.
  const playLine = "Three agents, one game. Go play."
  if ((await coachSaysAny(["Your game's done. Go open it.", playLine])) !== playLine) {
    await showMe().click()
    await coachSays(playLine)
  }
  await expect.element(page.getByText(/^Act 4, The result\./)).toBeInTheDocument()
  await expectClickAt(() => paneOf("Game lead"))
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  expect(closing().query()).toBeNull()
  // The step holds 20 s after the touch (frontend/tour's playStep), then the card comes.
  await touchStep("Three agents, one game. Go play.", () => [paneOf("Game lead")], {
    holdMs: 20_000,
  })
  await expect.element(closing(), { timeout: 10_000 }).toBeVisible()
  await expect.element(coach()).not.toBeInTheDocument()
  await expect
    .poll(() => closing().query()?.textContent ?? "")
    .toContain("It's yours now. Don't break it.")
}

describe("The tour's story", () => {
  it(
    "shows the Worktrees panel in the tour's project even with Agent worktrees off, and only there",
    walks,
    async () => {
      await openWorkspace("/?channel=experimental")
      await openPreferencesOn("Agents")
      const worktrees = preferencesDialog().getByRole("switch", { name: "Agent worktrees" })
      if ((await worktrees.element().getAttribute("aria-checked")) === "true")
        await worktrees.click()
      await expect.element(worktrees).toHaveAttribute("aria-checked", "false")
      await closePreferences()
      expect(sidebarPanel("Worktrees").query()).toBeNull()
      await beginTour()
      await answerPitch()
      await allowRun()
      // The teammates open their worktrees: the panel is there to show them.
      await coachSays(teamLine, 20_000)
      await expect.poll(() => sidebarPanel("Worktrees").query(), { timeout: 15_000 }).not.toBeNull()
      await sidebarPanel("Worktrees").click()
      await expect.element(page.getByText("core", { exact: true }).first()).toBeVisible()
      await expect.element(page.getByText("world", { exact: true }).first()).toBeVisible()
      // Another project has none, as the setting says.
      await switchProject("storefront")
      await expect.poll(() => sidebarPanel("Worktrees").query()).toBeNull()
    },
  )

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
      await answerPitch(pitches[1])
      await coachSays("It wants to run the game. Fine. Say yes.", 40_000)
      await approval().getByRole("button", { name: "Don't run" }).click()
      // Within seconds, with no terminal opened and no page shown, the story goes on without
      // them: the lead hires its team all the same.
      await coachSays(teamLine, 40_000)
      expect(windowNamed("Game server")).toBeUndefined()
      await playUntil("Three agents, one model. Yours.")
      await expectClickAt(() => paneOf("World"))
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

  it("takes the person's own words for the game, from the Inbox's pitch", walks, async () => {
    await startTour()
    const sheet = await openPitch()
    await sheet.getByRole("textbox").fill("underwater taxi")
    await sheet.getByRole("textbox").click()
    await userEvent.keyboard("{Enter}")
    await expect.element(sheet).not.toBeInTheDocument()
    await coachSays("It wants to run the game. Fine. Say yes.", 30_000)
  })

  it(
    "leaves out the run and page steps where there is no page, and ends on the model",
    walks,
    async () => {
      await startTour("/?channel=experimental&tourPage=none")
      await answerPitch()
      // No command to approve: the next thing is the team, then the model.
      await meetTeam()
      expect(approval().query()).toBeNull()
      expect(windowNamed("Game server")).toBeUndefined()
      await playUntil("Three agents, one model. Yours.", 150_000)
      // Nothing to play: the model is what is left to look at.
      await expectClickAt(() => paneOf("World"))
      await touchStep("Three agents, one model. Yours.", () => [paneOf("World")], {
        holdMs: 8_000,
      })
      await expect.element(closing(), { timeout: 10_000 }).toBeVisible()
    },
  )

  it("nudges a teammate gone quiet, whose part then lands", walks, async () => {
    await startTour("/?channel=experimental&tourMate=quiet&tourPatienceMs=1500")
    await answerPitch(pitches[2])
    await allowRun()
    // Silent, it never names itself; the tour rings the lead after its wait, and the story goes
    // on.
    await coachSays(teamLine, 30_000)
    await expect.poll(() => windowNamed("Core"), { timeout: 20_000 }).toBeDefined()
    await playUntil("They're finishing it. Relax.", 90_000)
  })

  it(
    "offers to bring back what the step is about once the person has gone elsewhere, and never takes them back by itself",
    walks,
    async () => {
      await startTour()
      await answerPitch()
      await allowRun()
      await playUntil("Its first model's done. Have a look.")
      // The person opens a file instead of looking at World's model: its preview takes the view,
      // and World is out of sight.
      await coachSaysAny([
        "Its first model's done. Have a look.",
        "A model, made from nothing. Go on. Spin it.",
      ])
      await sidebarPanel("Files").click()
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
      await expectClickAt(() => paneOf("World"))
      await coachSays("A model, made from nothing. Go on. Spin it.")
      await spinModel()
    },
  )

  it("offers to open the Inbox in Zen, where the rail is hidden", walks, async () => {
    await startTour()
    await coachSays("That's your agent. It does the work. I talk.")
    await page.getByRole("button", { name: "Enter Zen mode" }).click()
    // Its button out of sight, the step says so a moment later and offers to open it.
    const show = page.getByRole("region", { name: "Tour step" }).getByRole("button", {
      name: "Show me",
    })
    await expect
      .poll(captionNow, { timeout: 40_000 })
      .toContain("Your call. What game? Make it a good one.")
    await expect.element(show, { timeout: 15_000 }).toBeVisible()
    await show.click()
    await expect
      .poll(() => clicked()[0]?.textContent ?? "", { timeout: 15_000 })
      .toContain("Which game shall we build?")
  })

  it(
    "has a teammate's question arrive in the Inbox while the others work, and points at it until the person answers",
    walks,
    async () => {
      await startTour("/?channel=experimental&tourMate=asks")
      await answerPitch()
      await allowRun()
      // World asks while Core and Feel work on: the tour points at the question, whatever step it
      // is at, until the person answers it, and opens the Inbox no more than anything else: it
      // points at its button.
      await playUntil(
        [
          "One of them waits on you. The rest keep working.",
          "A teammate has a question. Huh? For you, not me.",
        ],
        60_000,
      )
      await pressRow("What colour should the hero be?")
      const sheet = page.getByRole("dialog", { name: "World" })
      const pick = sheet.getByRole("button", { name: /Blue/ })
      await standsStill(pick)
      await pick.click()
      // Answered, the story goes on where it was, to the game.
      await playUntil(["Your game's done. Go open it.", "Three agents, one game. Go play."])
    },
  )
})
