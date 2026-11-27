import type { DemoTour } from "@novadeck/demo/tour"

import type { DemoAction, DemoActionGroup } from "./types"

const screens = {
  startup: { label: "folder trust", what: "its folder-trust screen" },
  "sign-in": { label: "sign-in", what: "its sign-in screen" },
  hooks: { label: "hooks", what: "its prompt with Novadeck's hooks off" },
} as const

// Where Novadeck's own pi, the tour's agent, stands, as the consent says it; the Experimental
// row of Preferences is its own (see `bundledPiGroups`).
const piStates = (tour: DemoTour): readonly DemoAction[] => {
  const where = "The tour's consent (Help > Take the tour)"
  return [
    {
      label: "Tour Pi: not asked for",
      hint: `${where}: Pi's download hasn't started, so the consent reads Downloading Pi… and Start waits (opening the consent starts the download)`,
      run: () => tour.showAgent({ state: "off" }),
    },
    {
      label: "Tour Pi: downloading, size unknown",
      hint: `${where}: the consent reads Downloading Pi… and Start the tour waits`,
      run: () => tour.showAgent({ state: "downloading" }),
    },
    {
      label: "Tour Pi: downloading",
      hint: `${where}: the consent reads Downloading Pi: 12.3 of 59.0 MB and Start the tour waits`,
      run: () => tour.showAgent({ state: "downloading", received: 12_345_678, size: 58_977_130 }),
    },
    {
      label: "Tour Pi: ready",
      hint: `${where}: no download line, and Start the tour is ready`,
      run: () => tour.showAgent({ state: "ready" }),
    },
    {
      label: "Tour Pi: failed",
      hint: `${where}: the consent says in red Couldn't reach github.com. Check your connection., with Try again, which plays the download again`,
      run: () =>
        tour.showAgent({
          state: "failed",
          error: "Couldn't reach github.com. Check your connection.",
        }),
    },
  ]
}

// Novadeck's tour: a start the backend refuses, and its story's controls. Its consent opens
// from the footer's Help menu, there with Experimental on ("Experimental on" under App >
// Updates) and Onboarding tour switched on in Preferences > Experimental.
export const tourGroups = (tour: DemoTour): readonly DemoActionGroup[] => [
  {
    section: "App",
    title: "Tour",
    actions: [
      ...piStates(tour),
      {
        label: "Fail next start",
        hint: "The next Start the tour shows why it can't start (a folder of yours at ~/.novadeck/tour); the consent stays open",
        run: () => tour.failNext(),
      },
      {
        label: "Next start: no free run left",
        hint: "The next Start the tour shows the service's own sentence that today's free tours are used up; the consent stays open",
        run: () => tour.failNext("tickets"),
      },
      ...(["startup", "sign-in", "hooks"] as const).map((screen) => ({
        label: `Tour agent: hold at ${screens[screen].label}`,
        hint: `The next tour agent waits at ${screens[screen].what} before Novadeck reaches it: its terminal shows the held-agent mark until "Answer the startup screen"`,
        run: () => tour.holdAt(screen),
      })),
      {
        label: "Answer the startup screen",
        hint: 'The tour agent held at a startup screen goes on: it binds, works, names its terminal "Game lead", pitches three games and opens its team',
        run: () => tour.answer(),
      },
      {
        label: "Tour agent: quiet until nudged",
        hint: "The next tour agent binds but sits idle at its prompt, no turn begun, until the tour nudges it (the UI does after its wait); then it works and names its terminal",
        run: () => tour.goQuiet(),
      },
      {
        label: "Tour agent: ask permission first",
        hint: "The next tour agent asks your permission for a command, as its harness's own dialog: a request waits in the Inbox and the tour points at its terminal until you answer",
        run: () => tour.askPermission(),
      },
      {
        label: "Tour story: the lead's pitch waits until nudged",
        hint: "The next tour lead names itself, then waits for the tour's nudge before it pitches its three games and opens its Core, World and Feel",
        run: () => tour.goQuietTeam(),
      },
      {
        label: "Tour story: Core stays quiet until nudged",
        hint: "In the next run Core, the first teammate, opens but sits idle at its prompt, so its part is late, until the tour nudges it",
        run: () => tour.goQuietMate(),
      },
      {
        label: "Tour story: World asks about the hero's colour",
        hint: "In the next run World asks in the Inbox What colour should the hero be? while Core and Feel work on, and waits for the answer before it polishes; the tour points at the ask until it's answered",
        run: () => tour.goMateAsks(),
      },
      {
        label: "Tour story: no page (as on a computer without Node or Python)",
        hint: "The next run has no page: the lead opens no Game server terminal, asks for no command, and shows no page, so the tour skips the run and page steps and ends on World's model",
        run: () => tour.goNoPage(),
      },
      {
        label: "Tour story: answer the pitch (first game)",
        hint: "While the lead's pitch waits in the Inbox (Which game shall we build?), answers it with its first game as the person would: the row goes, and the lead opens its Core, World and Feel",
        run: () => tour.answerSheet(),
      },
      {
        label: "Tour story: answer the pitch (second game)",
        hint: "The same pitch answered with its second game: World models a robot, and the game is called Neon Magnet Rush",
        run: () => tour.answerSheet(1),
      },
      {
        label: "Tour story: answer the pitch (own words)",
        hint: "The same pitch answered in your own words, Space pirates: World models a rocket, and the game is called Space pirates",
        run: () => tour.answerSheet("Space pirates"),
      },
      {
        label: "Tour story: answer World's question (Red)",
        hint: "While World's ask waits in the Inbox (What colour should the hero be?), answers it with Red as the person would: the row goes, and World polishes its work and tells the lead",
        run: () => tour.answerMate(0),
      },
      {
        label: "Tour story: keeping fails",
        hint: "The next Keep building on the closing card fails, and the card says why and stays; the try after goes through",
        run: () => tour.failKeep(),
      },
      {
        label: "Tour agent: exits to its shell",
        hint: "The running tour lead's program ends and its shell is back at the prompt, as Claude Code leaves where you don't trust the folder: the tour says What? It didn't even start. and to end it and take it again",
        run: () => tour.exitToShell(),
      },
      {
        label: "Tour agent: stop",
        hint: "The running tour lead's process exits: its terminal shows the exit and the tour says Your agent stopped. Ugh. Rude.",
        run: () => tour.stop(),
      },
    ],
  },
]
