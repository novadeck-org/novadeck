import type { LaunchCues } from "@novadeck/demo/launch"

import type { DemoActionGroup } from "./types"

// The panel's group for the launch demo's beats (`?demo=launch`): one action per cue of the
// launch walkthrough, fired by the capture at the frame it wants, numbered by the video's beat.
// Nothing for any other demo.
export const launchGroups = (cues: LaunchCues | undefined): readonly DemoActionGroup[] =>
  cues
    ? [
        {
          section: "Agents",
          title: "Launch",
          actions: [
            {
              label: "3 · A spread of states",
              hint: "Checkout tests asks to run its end-to-end tests (asking), Stripe webhooks' turn ends in an API error (failed), Inventory sync finishes with a done report (done): the rest keep working. Each can be rung alone as 3a, 3b and 3c",
              run: () => cues.states(),
            },
            {
              label: "3a · One agent asks",
              hint: "Checkout tests asks to run pnpm test:e2e: an Unblock row, and its mark reads asking",
              run: () => cues.permission(),
            },
            {
              label: "3b · One agent fails",
              hint: "Stripe webhooks' turn ends in an API error (stream disconnected), as Codex records one: its line goes red, with a Trouble row that reads it",
              run: () => cues.fail(),
            },
            {
              label: "3c · One agent finishes",
              hint: "Inventory sync ends its turn with a done report: a done mark and an Update row",
              run: () => cues.finishOne(),
            },
            {
              label: "4 · The three asks",
              hint: "Inbox header counts 3, all at once: Checkout tests asks to run pnpm test:e2e, Order emails has a plan to approve, Cart drawer asks a question with its own pick",
              run: () => cues.asks(),
            },
            {
              label: "4a · Permission",
              hint: "Checkout tests asks to run pnpm test:e2e: an Unblock row",
              run: () => cues.permission(),
            },
            {
              label: "4b · Plan",
              hint: "Order emails' plan waits for approval: an Unblock row",
              run: () => cues.plan(),
            },
            {
              label: "4c · Question",
              hint: "Cart drawer asks where the cart should be kept, one option marked (Recommended): an Ask row",
              run: () => cues.question(),
            },
            {
              label: "5a · Lead opens teammates",
              hint: "Orders API opens three teammate windows to its right and under it, in the same frame, and rests: the team wire draws to them",
              run: () => cues.teammates(),
            },
            {
              label: "5b · Teammate asks, and its lead answers",
              hint: "Cart endpoint asks which API version the storefront calls (an Ask row) and messages Orders API the same question at once. Run 5a first. The rung lead works and answers (sent about 5 s on); when it lands (about 0.8 s later), Cart endpoint acts on it and withdraws its ask: the row stays, struck, Withdrawn. The person types nothing",
              run: () => cues.teammateAsks(),
            },
            {
              label: "5c · Teammate reports done to its lead",
              hint: "Pricing endpoint ends its turn with a done report (a done mark and an Update row) and messages the same to Orders API: the lead is rung, and the message reads in either Messages pane. Run 5a first",
              run: () => cues.teammateDone(),
            },
            {
              label: "6a · Agent shows a page",
              hint: "Order status page shows its dev server's page in the pane beside its window",
              run: () => cues.show(),
            },
            {
              label: "6b · Agent shows its changes",
              hint: "Order status page shows its changes in the pane: the working tree against HEAD, three files as diffs",
              run: () => cues.showChanges(),
            },
            {
              label: "6c · Agent shows button variants",
              hint: "Order status page shows a screenshot in the pane: three takes on the page's Track package button, side by side",
              run: () => cues.showVariants(),
            },
            {
              label: "7 · Everyone finishes",
              hint: "Every agent of both projects ends its turn in a ripple: lines go green, done marks. Agents still waiting on the person stay as they are: an unanswered ask, a failed turn (until it is prompted again), and the teammate and its lead while their exchange is on its way (they finish when it settles). Each teammate messages its lead its report as it finishes, and the lead finishes about 1 s after the ripple starts. Press again to end whoever is working by then",
              run: () => cues.finishAll(),
            },
          ],
        },
      ]
    : []
