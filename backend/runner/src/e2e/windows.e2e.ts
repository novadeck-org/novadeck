import type { Approval } from "@novadeck/protocol"

import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, tool } from "./model/script.js"
import { own, result, start, through } from "./scenarios.js"

// An agent's ask to run a command (`open_terminal` with a `command`) goes to the window the
// person used last, for every harness (see messaging.e2e.ts for the rule on parity): two
// windows show the project, and whichever sent `terminals.active` for a terminal last gets
// the ask, the other none. A window that loses focus says `active(null)`, which is not use.

type Request = Extract<Approval, { type: "request" }>

describe.skipIf(!supported)("an ask with two windows on the project", () => {
  for (const setup of setups) {
    const it = e2e(setup)
    it(`${setup.name} goes to the window used last, and follows the person between windows`, async ({
      e2e: run,
    }) => {
      const { deck } = run
      const asks = ["first", "second", "third"] as const
      run.model.use(
        own((call) => (result(call) !== undefined ? { text: "Declined, noted." } : undefined)),
        ...asks.map((which) =>
          own((call) => {
            const name = tool(call, "open_terminal")
            return name && asked(call, `Run the ${which} command`)
              ? {
                  calls: [
                    { name, input: { command: `echo ${which}-window-ask`, title: `${which} run` } },
                  ],
                }
              : undefined
          }),
        ),
      )
      const t = await start(run, setup)

      // Two windows, each following the person's asks, both showing the project.
      const windows = ["left", "right"] as const
      const received: Record<(typeof windows)[number], Request[]> = { left: [], right: [] }
      const stop = new AbortController()
      try {
        const { projectId } = deck.store.session(deck.sessionId)
        for (const window of windows) {
          void (async () => {
            try {
              for await (const approval of deck.terminals.approvals(window, stop.signal))
                if (approval.type === "request") received[window].push(approval)
            } catch {
              // Closed with the test.
            }
          })()
        }
        // A window reports the project once, as the adapter's first report, then each
        // that the person used before counts; `right` follows `left` as the newest stream.
        for (const window of windows) deck.clients.report(window, projectId)
        const use = (used: (typeof windows)[number], other: (typeof windows)[number]) => {
          deck.clients.active(used, t.id)
          // The window the person left says so, which is not a use.
          deck.clients.active(other, null)
        }

        const ask = async (
          prompt: string,
          to: (typeof windows)[number],
          not: (typeof windows)[number],
        ) => {
          const calls = run.model.mark()
          const mark = t.mark()
          await t.submit(prompt)
          await t.poll(
            async () => (received[to].length > 0 ? true : undefined),
            `the ask to reach the ${to} window`,
          )
          // Nothing for the other window, which also follows.
          expect(received[not]).toHaveLength(0)
          const request = received[to][0]!
          received.left.length = 0
          received.right.length = 0
          deck.terminals.answerApproval({ requestId: request.requestId, approved: false }, to)
          await run.model.waitFor((call) => result(call) !== undefined, { after: calls })
          // The turn ends with the notice of the decline, which its Stop may go on with as a turn
          // of its own: the next prompt is the person's after all of it, not typed into it
          // (opencode's, on a slow runner, took the second prompt as queued in that turn and
          // answered it without the tool).
          await through(t, ["working", "settled"], { after: mark })
        }

        use("left", "right")
        await ask("Run the first command", "left", "right")
        // The person moves to the other window: it used a terminal, the first lost focus.
        use("right", "left")
        await ask("Run the second command", "right", "left")
        // And back: the stream that subscribed last is not the one chosen.
        use("left", "right")
        await ask("Run the third command", "left", "right")
      } finally {
        stop.abort()
      }
    })
  }
})
