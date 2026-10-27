import type { DemoFeedback } from "@novadeck/demo/feedback"

import type { DemoActionGroup } from "./types"
import type { DemoLaunch } from "./with-debug"

// The key the footer's button keeps once the card was opened: with it
// set the button is just its icon.
const openedKey = "novadeck.feedback-opened"

// The panel's Feedback group: the footer's card and the agent route into its drafts, where the
// demo has feedback (everywhere but the visitor's). The card and the window menu need no
// action; these reach what normal use can't, or takes long to.
export const feedbackGroups = (
  launch: DemoLaunch,
  feedback: DemoFeedback | undefined,
): readonly DemoActionGroup[] =>
  feedback
    ? [
        {
          section: "App",
          title: "Feedback",
          actions: [
            {
              label: "Next send fails",
              hint: "The next note is Not sent: the card stays open with the note and the button reads Not sent · Retry; Retry sends it",
              run: () => feedback.failNext(),
            },
            {
              label: "Next ask fails",
              hint: "The next Ask from an agent window's card stays open and says it couldn't ask: no agent is running there",
              run: () => feedback.failNextAsk(),
            },
            {
              label: "Show the button's word again",
              hint: "The footer's button shows its Feedback label again, as on a new install, until the card is opened",
              reboots: true,
              run: () => {
                try {
                  window.localStorage.removeItem(openedKey)
                } catch {
                  // Without storage the button never remembered it.
                }
                launch.rehearsals.rehearse({ reboot: true })
              },
            },
            {
              label: "A feedback draft from the selected agent",
              hint: "The selected agent works a moment, then its asked-for draft, with a path to strike, waits in the drafts; waits for its turn to end if it is working",
              run: ({ selected, note }) => {
                const key = selected()
                if (!key) return note("Select a terminal first.")
                feedback.ask(key, "").catch(() => note("Select a terminal running an agent first."))
              },
            },
            {
              label: "An unasked feedback draft from the selected agent",
              hint: "The selected agent's draft waits in the drafts at once, as when it hit a Novadeck bug and wrote one on its own",
              run: ({ selected, note }) => {
                const key = selected()
                if (!key) return note("Select a terminal first.")
                feedback
                  .draftUnasked(key)
                  .catch(() => note("Select a terminal running an agent first."))
              },
            },
          ],
        },
      ]
    : []
