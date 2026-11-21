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
        hint: 'The tour agent held at a startup screen goes on: it binds, works, names its terminal "Tour lead" and finishes its turn',
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
        label: "Tour story: answer the money ask (A)",
        hint: "While the second fixer's ask waits in the Inbox (Whole amounts: $12.00 or $12?), answers it with option A, $12.00, as the person would: the row goes, the fixer edits money() in its worktree and tells the lead, and the lead says both bugs are fixed",
        run: () => tour.answerMoney(0),
      },
      {
        label: "Tour story: answer the money ask (B)",
        hint: "The same ask answered with option B, $12: the merged preview of split.js shows money() dropping .00 from whole amounts",
        run: () => tour.answerMoney(1),
      },
      {
        label: "Tour story: the lead's fixer stays quiet until nudged",
        hint: "The next tour lead names itself, then waits for the tour's nudge before opening its first fixer",
        run: () => tour.goQuietTeam(),
      },
      {
        label: "Tour agent: stop",
        hint: "The running tour lead's process exits: its terminal shows the exit and the tour says Your agent stopped",
        run: () => tour.stop(),
      },
    ],
  },
]
