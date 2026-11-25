import type { LaunchCues } from "@novadeck/demo/videos/launch"
import { launchFiles } from "@novadeck/demo/videos/launch-files"

import type { DemoActionGroup } from "./types"

// The panel's group for the launch demo's beats (`?demo=launch`): one action per cue of the
// launch walkthrough, fired by the capture at the frame it wants, numbered by the video's beat.
// Nothing for any other demo.
export const launchGroups = (
  cues: LaunchCues | undefined,
  // Boots the demo again, as an action that says `reboots` does itself.
  reboot: () => void,
): readonly DemoActionGroup[] =>
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
              hint: "Checkout tests asks to run pnpm test:e2e: an Unblock entry, and its mark reads asking",
              run: () => cues.permission(),
            },
            {
              label: "3b · One agent fails",
              hint: "Stripe webhooks' turn ends in an API error (stream disconnected): its line goes red, with a Trouble entry that reads it",
              run: () => cues.fail(),
            },
            {
              label: "3c · One agent finishes",
              hint: "Inventory sync ends its turn with a done report: a done mark and an Update entry",
              run: () => cues.finishOne(),
            },
            {
              label: "4 · The three asks",
              hint: "Inbox header counts 3, all at once: Checkout tests asks to run pnpm test:e2e, Order emails has a plan to approve, Cart drawer asks a question with its own pick",
              run: () => cues.asks(),
            },
            {
              label: "4a · Permission",
              hint: "Checkout tests asks to run pnpm test:e2e: an Unblock entry",
              run: () => cues.permission(),
            },
            {
              label: "4b · Plan",
              hint: "Order emails' plan waits for approval: an Unblock entry",
              run: () => cues.plan(),
            },
            {
              label: "4c · Question",
              hint: "Cart drawer asks where the cart should be kept, one option marked (Recommended): an Ask entry",
              run: () => cues.question(),
            },
            {
              label: "5a · Lead opens teammates",
              hint: "Orders API opens three teammate windows in a row above it, in the same frame, and rests: the team wire draws to them",
              run: () => cues.teammates(),
            },
            {
              label: "5b · Teammate asks, and its lead answers",
              hint: "Cart endpoint asks which API version the storefront calls (an Ask entry) and messages Orders API the same question at once. Run 5a first. The rung lead works and answers (sent about 8 s on); when it lands (about 0.8 s later), Cart endpoint acts on it and withdraws its ask: the row leaves the Inbox. The person types nothing. In the agents' Agent Chat the question lands in Orders API's chat 0.8 s after the cue and the answer in Cart endpoint's, each as the agent's message, with the send that made it among its sender's calls",
              run: () => cues.teammateAsks(),
            },
            {
              label: "5c · Teammate reports done to its lead",
              hint: "Pricing endpoint ends its turn with a done report (a done mark and an Update entry) and messages the same to Orders API: the lead is rung, and the message reads in either Messages pane and, in Agent Chat, as the report in Orders API's chat. Run 5a first",
              run: () => cues.teammateDone(),
            },
            {
              label: "6a · Agent shows a page",
              hint: "Order status page shows its dev server's page in the pane beside its window",
              run: (context) => cues.show(context.select),
            },
            {
              label: "6b · Agent shows its changes",
              hint: "Order status page shows its changes in the pane: the working tree against HEAD, three files as diffs",
              run: (context) => cues.showChanges(context.select),
            },
            {
              label: "6c · Agent shows button variants",
              hint: "Order status page shows a screenshot in the pane: three takes on the page's Track package button, side by side",
              run: (context) => cues.showVariants(context.select),
            },
            {
              label: "6d · Agent shows a video",
              hint: "Order status page shows checkout-walkthrough.webm, a 4 s recording, as a video item on its pane's bar. Works after 6a and 6b",
              run: (context) => cues.showVideo(context.select),
            },
            {
              label: "6e · Agent shows a PDF",
              hint: "Order status page shows invoice-1042.pdf, a one-page invoice, as a PDF item on its pane's bar",
              run: (context) => cues.showPdf(context.select),
            },
            {
              label: "6f · Agent shows a 3D model",
              hint: "Order status page shows packing-arm.gltf, an animated arm, as a 3D item on its pane's bar. It loads for a moment first",
              run: (context) => cues.showModel(context.select),
            },
            {
              label: "6g · Agent shows a folder",
              hint: "Order status page shows its screenshots folder (four stills and a clip) as a folder item on its pane's bar. It loads for a moment first",
              run: (context) => cues.showFolder(context.select),
            },
            {
              label: "7 · Everyone finishes",
              hint: "Every agent of both projects ends its turn in a ripple: lines go green, done marks. Agents still waiting on the person stay as they are: an unanswered ask, a failed turn (until it is prompted again), and the teammate and its lead while their exchange is on its way (they finish when it settles). Each teammate messages its lead its report as it finishes, and the lead finishes about 1 s after the ripple starts. Press again to end whoever is working by then",
              run: () => cues.finishAll(),
            },
            {
              label: "8a · Agent asks another for a review",
              hint: "Cart drawer messages Search index to review its change; Search index answers about 4 s after it lands. The exchange reads in either one's Messages pane, and in each one's Agent Chat as the other's message",
              run: () => cues.askReview(),
            },
            {
              label: "8b · Agent shows its plan",
              hint: "Order emails shows its plan, ~/.claude/plans/order-emails.md, rendered in the pane beside its window",
              run: (context) => cues.showPlan(context.select),
            },
            {
              label: "8c · A Codex agent asks to run a command",
              hint: "Search index, a Codex agent, asks to run pnpm test --filter search in Codex's own words: an Unblock entry. Allowed, it runs them and reports done about 2 s later: an Update entry",
              run: () => cues.command(),
            },
            {
              label: "8d · An Antigravity agent asks to approve its plan",
              hint: "Inventory sync, the deck's Antigravity agent, shows its implementation plan (Stock sync) beside its window, without opening it, and asks to approve it in Antigravity's words (1 artifact to review: Approve, Reject, Tell it what to change): an Unblock entry whose sheet shows the plan. Answered, it goes on working",
              run: () => cues.agyPlan(),
            },
            {
              label: "9a · A check passes and a PR opens",
              hint: "With Agent worktrees on (App group), the Worktrees panel changes as it is open: Search index's running checks pass, and, after 5a, Cart endpoint's worktree opens its pull request with checks of its own. The teammates' worktrees (Pricing, Stock, Cart endpoint) appear under Orders API's with 5a",
              run: () => cues.checksPass(),
            },
            {
              label: "9b · Agents write files",
              hint: "With the Files panel on (the action below), the agents that work start writing files: Cart drawer, Search index, Checkout tests, Stripe webhooks, Order emails, Order status page and Orders API change files and make new ones, a file every few seconds each while at work, as the tree is open",
              run: () => cues.writeFiles(),
            },
            {
              label: "Files panel on",
              hint: "Boots again with the Files panel and its button in the rail (the launch demo has neither, so the video's other beats show none): northwind's tree, with what the agents changed so far. 9b has them write. Worktrees need App > Agent worktrees > On",
              reboots: true,
              run: () => {
                launchFiles.on = true
                reboot()
              },
            },
          ],
        },
      ]
    : []
