import { setTimeout as sleep } from "node:timers/promises"

import { setups } from "./agents/index.js"
import { describe, e2e, expect, gated, supported } from "./fixture.js"
import { latest } from "./model/script.js"
import {
  deliveries,
  delivered,
  holds,
  lacking,
  messages,
  own,
  replies,
  ring,
  sends,
  sent,
  start,
  through,
  turn,
  unrung,
} from "./scenarios.js"

// The person forking a session, the same for every harness (see messaging.e2e.ts for the
// rule on parity). A fork is a session of its own carrying its parent's conversation. A
// message is for the session bound when it was sent, so the parent's never go to its fork
// (docs/agent-messaging.md, "Messages" and "Message states").

// Whether the call's conversation holds a user turn with `text`.
const holding = (
  call: { readonly turns: readonly { role: string; text: string }[] },
  text: string,
) => call.turns.some((one) => one.role === "user" && one.text.includes(text))

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)
    const { fork } = setup

    // In a new terminal, the person picks the session to fork in the harness's picker,
    // before which no session binds there: a message waits for the terminal's first
    // session, which is the fork's.
    gated(it, lacking(setup, "fork.picker"))(
      "rings a forked session for the messages that waited for it, and its hook delivers",
      async ({ e2e: run }) => {
        const { command, picked } = fork!.picker!
        run.model.use(
          replies("Remember the word heron", "Remembered."),
          replies("Say ready", "Ready here."),
          sends("Tell t3 hello", "t3", "Hello, fork."),
          sends("Tell t1 hello", "t1", "Hello, parent."),
          own((call) => (sent(call, "t3") ? { text: "Told t3." } : undefined)),
          own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
          own((call) =>
            deliveries(call).some((one) => one.text === "Hello, parent.")
              ? { text: "The parent says hello back." }
              : undefined,
          ),
          own((call) =>
            delivered(call, "t2") ? { text: "The fork says hello back." } : undefined,
          ),
        )
        const t1 = await start(run, setup)
        await turn(t1, "Remember the word heron", "Remembered.")
        const parent = (await t1.detail()).sessionId
        expect(parent).not.toBeNull()
        const t2 = await start(run, setup)
        await turn(t2, "Say ready", "Ready here.")
        // The picker lists the latest session first, selected.
        const t3 = await run.deck.open(command)
        expect(t3.handle).toBe("t3")
        await t3.until(picked("Say ready"), 60_000)
        const calls = run.model.mark()
        const mark = t3.mark()

        await t2.submit("Tell t3 hello")

        // The message waits for the first session to bind in t3, and nothing rings the
        // picker.
        await t2.until("Told t3.")
        await t3.reached(holds("t2", "t3", "queued"), { after: mark })
        await sleep(unrung)
        expect(t3.history().map((one) => one.delivery)).toEqual(t3.history().map(() => "unbound"))
        expect(messages(t3).map((one) => one.state)).toEqual(["queued"])

        // The person picks t1's session. Its fork shows its prompt, Ready; it is rung, and
        // its hook delivers the message.
        await t3.confirm(picked("Remember the word heron"), async () => t3.press("\x1b[B"))
        await through(t3, ["ready", "ringing", "working", holds("t2", "t3", "delivered")], {
          after: mark,
          timeoutMs: 60_000,
        })
        const rung = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
        expect(latest(rung)).toMatch(ring)
        expect(deliveries(rung)).toEqual([{ from: "t2", text: "Hello, fork." }])
        // It is the fork: the parent's conversation, in a session of its own, while the
        // parent stays bound in t1.
        expect(holding(rung, "Remember the word heron")).toBe(true)
        await t3.until("The fork says hello back.")
        await t3.reached("settled", { after: mark })
        const forked = (await t3.detail()).sessionId
        expect(forked).not.toBeNull()
        expect(forked).not.toBe(parent)
        expect((await t1.detail()).sessionId).toBe(parent)

        // The parent's messages stay its parent's: one for t1 now rings t1, its hook
        // delivering it in the parent's own conversation, which never had the fork's; the
        // fork gets nothing more.
        const later = run.model.mark()
        const from1 = t1.mark()
        await t2.submit("Tell t1 hello")
        await through(
          t1,
          [
            holds("t2", "t1", "queued"),
            "ringing",
            "working",
            holds("t2", "t1", "delivered"),
            "settled",
          ],
          {
            after: from1,
          },
        )
        const told = await run.model.waitFor(
          (call) => deliveries(call).some((one) => one.text === "Hello, parent."),
          { after: later },
        )
        expect(latest(told)).toMatch(ring)
        expect(deliveries(told)).toEqual([{ from: "t2", text: "Hello, parent." }])
        expect(holding(told, "Remember the word heron")).toBe(true)
        expect(told.turns.some((one) => one.text.includes("Hello, fork."))).toBe(false)
        await t1.until("The parent says hello back.")
        expect((await t1.detail()).sessionId).toBe(parent)
        expect((await t3.detail()).sessionId).toBe(forked)
        expect(messages(t3).map((one) => [one.text, one.state])).toEqual([
          ["Hello, fork.", "delivered"],
        ])
      },
    )

    // In place, the harness announces the fork as a new session in the same terminal: what
    // waited for the parent is gone, and the fork is Ready.
    gated(it, lacking(setup, "fork.inPlace"))(
      "forks in place: what waited for the parent is gone, and the fork is rung for what comes next",
      async ({ e2e: run }) => {
        const command = fork!.inPlace!
        run.model.use(
          replies("Remember the word heron", "Remembered."),
          sends("Tell t1 hello", "t1", "Hello, parent."),
          sends("Tell t1 again", "t1", "Hello, fork."),
          own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
          own((call) => (delivered(call, "t2") ? { text: "The fork heard t2." } : undefined)),
        )
        const t1 = await start(run, setup)
        await turn(t1, "Remember the word heron", "Remembered.")
        const parent = (await t1.detail()).sessionId
        expect(parent).not.toBeNull()
        const t2 = await start(run, setup)
        const calls = run.model.mark()
        const mark = t1.mark()

        // The person has a draft in the box as t2's message comes: Drafting, so it waits
        // for the parent session. They erase it and fork.
        t1.press("draft")
        await t2.submit("Tell t1 hello")
        await t2.until("Told t1.")
        await t1.reached(holds("t2", "t1", "queued"), { after: mark })
        t1.press("\x7f".repeat("draft".length))
        await t1.poll(
          async () => ((await t1.screen()).includes("draft") ? undefined : true),
          "the draft to be erased",
        )
        await t1.submit(command)

        // The harness announces the fork: the parent's message is gone, never delivered,
        // and the fork is Ready.
        const forked = await through(t1, [holds("t2", "t1", "gone"), "ready"], { after: mark })
        expect(run.model.calls.slice(calls).filter((call) => delivered(call, "t2"))).toEqual([])

        // A message now is the fork's: it is rung, and its hook delivers it alone, in the
        // parent's conversation carried over.
        await t2.submit("Tell t1 again")
        await through(t1, ["ringing", "working", holds("t2", "t1", "delivered")], {
          after: forked!.index,
        })
        const rung = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
        expect(latest(rung)).toMatch(ring)
        expect(deliveries(rung)).toEqual([{ from: "t2", text: "Hello, fork." }])
        expect(holding(rung, "Remember the word heron")).toBe(true)
        await t1.until("The fork heard t2.")
        await t1.reached("settled", { after: forked!.index })
        const session = (await t1.detail()).sessionId
        expect(session).not.toBeNull()
        expect(session).not.toBe(parent)
        expect(messages(t1).map((one) => [one.text, one.state])).toEqual([
          ["Hello, parent.", "gone"],
          ["Hello, fork.", "delivered"],
        ])
      },
    )
  })
}
