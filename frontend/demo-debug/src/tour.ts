import type { DemoTour } from "@novadeck/demo/tour"

import type { DemoActionGroup } from "./types"

const screens = {
  startup: { label: "folder trust", what: "its folder-trust screen" },
  "sign-in": { label: "sign-in", what: "its sign-in screen" },
  hooks: { label: "hooks", what: "its prompt with Novadeck's hooks off" },
} as const

// Novadeck's tour: a start the backend refuses, and its story's controls. Its consent opens
// from the footer's Help menu, there with Experimental on ("Experimental on" under App >
// Updates) and Onboarding tour switched on in Preferences > Experimental.
export const tourGroups = (tour: DemoTour): readonly DemoActionGroup[] => [
  {
    section: "App",
    title: "Tour",
    actions: [
      {
        label: "Fail next start",
        hint: "The next Start the tour shows why it can't start (a folder of yours at ~/.novadeck/tour); the consent stays open",
        run: () => tour.failNext(),
      },
      {
        label: "Next start: models unlisted",
        hint: "The next Start the tour says the agent hasn't listed its models yet (Codex before it signs in), with a Start button that opens it in a terminal",
        run: () => tour.failNext("unlisted"),
      },
      ...(["startup", "sign-in", "hooks"] as const).map((screen) => ({
        label: `Tour agent: hold at ${screens[screen].label}`,
        hint: `The next tour agent waits at ${screens[screen].what} before Novadeck reaches it: its terminal shows the held-agent mark until "Answer the startup screen"`,
        run: () => tour.holdAt(screen),
      })),
      {
        label: "Answer the startup screen",
        hint: 'The tour agent held at a startup screen goes on: it binds, works, names its terminal "Game lead" and opens its team',
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
        label: "Tour story: the lead's team stays quiet until nudged",
        hint: "The next tour lead names itself, then waits for the tour's nudge before opening its Sculptor and Score fixer",
        run: () => tour.goQuietTeam(),
      },
      {
        label: "Tour story: the sculptor stays quiet until nudged",
        hint: "In the next run the Sculptor opens but sits idle at its prompt, so no model and no question appear, until the tour nudges it",
        run: () => tour.goQuietSculptor(),
      },
      {
        label: "Tour story: the artist stays quiet until nudged",
        hint: "In the next run the Cover artist, once the tour started it in a new terminal and rang its brief, stays idle: it names itself, asks the lead and draws its cover only once nudged",
        run: () => tour.goQuietArtist(),
      },
      {
        label: "Tour story: the artist never starts",
        hint: "In the next run the tour opens the artist's terminal but no agent ever shows in it, so after the tour's wait the artist's three steps are dropped and the last one says Three agents. One game. Play it.",
        run: () => tour.goArtistNever(),
      },
      {
        label: "Tour story: no page (as on a computer without Node or Python)",
        hint: "The next run has no page: the lead opens no Game server terminal, asks for no command, and shows no page, so the tour skips those two steps and ends on the Sculptor's model",
        run: () => tour.goNoPage(),
      },
      {
        label: "Tour story: answer the hero ask (A rocket)",
        hint: "While the Sculptor's ask waits in the Inbox (Who is your game's hero?), answers it with A rocket as the person would: the row goes, the Sculptor tells the lead, and the 3D model is sculpted again",
        run: () => tour.answerHero(0),
      },
      {
        label: "Tour story: answer the hero ask (own words)",
        hint: "The same ask answered in your own words, a cat named Pixel: the Sculptor sculpts a cat, and the lead names the game for it in src/config.js",
        run: () => tour.answerHero("my cat Pixel"),
      },
      {
        label: "Tour story: keeping fails",
        hint: "The next Keep building on the closing card fails, and the card says why and stays; the try after goes through",
        run: () => tour.failKeep(),
      },
      {
        label: "Tour agent: exits to its shell",
        hint: "The running tour lead's program ends and its shell is back at the prompt, as Claude Code leaves where you don't trust the folder: the tour says It didn't start. and to end it and take it again",
        run: () => tour.exitToShell(),
      },
      {
        label: "Tour agent: stop",
        hint: "The running tour lead's process exits: its terminal shows the exit and the tour says Your agent stopped",
        run: () => tour.stop(),
      },
    ],
  },
]
