import type { BabciaCues } from "@novadeck/demo/babcia"

import type { DemoActionGroup } from "./types"

// The panel's group for the Babcia demo's beats (`?demo=babcia`): one action per cue of the
// video, fired by the capture at the frame it wants. Nothing for any other demo.
export const babciaGroups = (cues: BabciaCues | undefined): readonly DemoActionGroup[] =>
  cues
    ? [
        {
          section: "Agents",
          title: "Babcia",
          actions: [
            {
              label: "1 · The three asks",
              hint: "Inbox badge reads 3: Order form asks to run pnpm test, Accessibility has a plan to approve, Menu page asks a question with its own pick",
              run: () => cues.asks(),
            },
            {
              label: "1a · Permission only",
              hint: "Order form asks to run pnpm test: an Approve row",
              run: () => cues.permission(),
            },
            {
              label: "1b · Plan only",
              hint: "Accessibility's plan waits for approval: an Approve row",
              run: () => cues.plan(),
            },
            {
              label: "1c · Question only",
              hint: "Menu page asks how to list the soups, one option marked (Recommended): an Ask row",
              run: () => cues.question(),
            },
            {
              label: "2 · Failed turn",
              hint: "Prices table's turn ends in an error: its line goes red, with a Trouble row",
              run: () => cues.fail(),
            },
            {
              label: "3 · Lead opens helpers",
              hint: "Site API opens three helper windows to its right and under it, in the same frame, and rests: the team wire draws to them",
              run: () => cues.helpers(),
            },
            {
              label: "4 · Helper asks its lead's question",
              hint: "Orders endpoint asks which API the site calls: a free-text Ask row. Run 3 first. Once the person's answer has reached it, it writes to Site API, which wakes, works and answers",
              run: () => cues.helperAsks(),
            },
            {
              label: "5 · Agent shows a page",
              hint: "Seasonal specials shows its dev server's page in the pane beside its window",
              run: () => cues.show(),
            },
            {
              label: "6 · Everyone finishes",
              hint: "Every agent of both projects ends its turn in a ripple: lines go green. Agents still waiting on the person (an unanswered ask) stay waiting, so answer those first",
              run: () => cues.finishAll(),
            },
          ],
        },
      ]
    : []
