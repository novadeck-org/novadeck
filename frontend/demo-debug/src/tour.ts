import type { DemoTour } from "@novadeck/demo/tour"

import type { DemoAction, DemoActionGroup } from "./types"

const screens = {
  startup: { label: "folder trust", what: "its folder-trust screen" },
  "sign-in": { label: "sign-in", what: "its sign-in screen" },
  hooks: { label: "hooks", what: "its prompt with Novadeck's hooks off" },
} as const

// Where Nova, the tour's agent, stands, as the consent says it; the Experimental
// row of Preferences is its own (see `novaGroups`).
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
        label: "Next start: no free ticket left",
        hint: "The next Start the tour shows Nova's model service's own sentence that today's free tickets are used up; the consent stays open",
        run: () => tour.failNext("tickets"),
      },
      ...(["startup", "sign-in", "hooks"] as const).map((screen) => ({
        label: `Tour agent: hold at ${screens[screen].label}`,
        hint: `The next tour agent waits at ${screens[screen].what} before Novadeck reaches it: its terminal shows the held-agent mark until "Answer the startup screen"`,
        run: () => tour.holdAt(screen),
      })),
      {
        label: "Answer the startup screen",
        hint: 'The tour agent held at a startup screen goes on: it binds, works, names its terminal "Game lead" asks its sheet and opens its team',
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
        label: "Tour story: the lead's sheet waits until nudged",
        hint: "The next tour lead names itself, then waits for the tour's nudge before it asks its sheet and opens its Modeller and Builder",
        run: () => tour.goQuietTeam(),
      },
      {
        label: "Tour story: the modeller stays quiet until nudged",
        hint: "In the next run the Modeller opens but sits idle at its prompt, so no model appears, until the tour nudges it",
        run: () => tour.goQuietModeller(),
      },
      {
        label: "Tour story: the modeller asks about the hero's colour",
        hint: "In the next run the Modeller, once it showed its model, asks in the Inbox What colour should the hero be? and waits for the answer before it reports; the tour points at the ask until it's answered",
        run: () => tour.goMateAsks(),
      },
      {
        label: "Tour story: no page (as on a computer without Node or Python)",
        hint: "The next run has no page: the lead opens no Game server terminal, asks for no command, and shows no page, so the tour skips those two steps and goes on to the Modeller's model",
        run: () => tour.goNoPage(),
      },
      {
        label: "Tour story: answer the sheet (Fantasy, RPG)",
        hint: "While the lead's sheet waits in the Inbox (Which game shall we build?), answers it with its first options as the person would: the row goes, and the lead opens its Modeller and Builder",
        run: () => tour.answerSheet(),
      },
      {
        label: "Tour story: answer the sheet (Sci-fi, Shooter)",
        hint: "The same sheet answered with its second options: the Modeller models a rocket, and the game is called Sci-fi Shooter",
        run: () => tour.answerSheet({ world: 1, kind: 1 }),
      },
      {
        label: "Tour story: answer the sheet (own words)",
        hint: "The same sheet answered in your own words, Modern and Racing: the Modeller models a robot, and the game is called Modern Racing",
        run: () => tour.answerSheet({ world: "Modern", kind: "Racing" }),
      },
      {
        label: "Tour story: answer the modeller's question (Red)",
        hint: "While the Modeller's ask waits in the Inbox (What colour should the hero be?), answers it with Red as the person would: the row goes, and the Modeller reports to the lead",
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
