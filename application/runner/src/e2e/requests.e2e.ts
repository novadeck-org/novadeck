import { setTimeout as sleep } from "node:timers/promises"

import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, gated, supported } from "./fixture.js"
import { asked, gate, latest, type Rule } from "./model/script.js"
import type { FakeModel } from "./model/server.js"
import {
  answers,
  deliveries,
  delivered,
  holds,
  lacking,
  messages,
  own,
  result,
  replies,
  ring,
  sends,
  sent,
  start,
  through,
  turn,
  unrung,
} from "./scenarios.js"

// What happens to a message that comes while its recipient waits on the person: a
// permission question open, or answered with Enter mid-turn, what Esc-Esc opened, or a
// popup its harness raised after its Stop. The same scenarios for every
// harness (see messaging.e2e.ts for the rule on parity), asserting what
// docs/agent-messaging.md says ("What counts", "States", "The doorbell", "Acceptance
// scenarios").

// How long a terminal is watched for what a failed ring might still press.
const quiet = 3000

// Two Escapes this far apart are one Esc-Esc in each harness that has it: Claude Code
// 2.1.287's window is about 800 ms (docs/e2e-testing.md, "Escape on its own").
const doubleEscapeMs = 300

// The model's replies for t2 telling t1 the news, and for t1 noting it once a delivery
// brings it.
const news: Rule[] = [
  sends("Tell t1 the news", "t1", "The build is green."),
  own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
  own((call) => (delivered(call, "t2") ? { text: "Noted the news." } : undefined)),
]

// With the news, t1 makes the file through a tool its harness asks the person about
// first, `asking` answering its prompt with that tool call, and says so once it ran.
const rules = (asking: Rule): Rule[] => [
  ...news,
  asking,
  own((call) => (result(call) !== undefined ? { text: "Made it." } : undefined)),
]

/** Waits until the terminal's screen has stayed the same for `forMs`. */
const calm = async (terminal: DeckTerminal, forMs = 1000): Promise<void> => {
  let last = { shown: "", since: 0 }
  await terminal.poll(async () => {
    const shown = await terminal.screen()
    if (shown !== last.shown) last = { shown, since: Date.now() }
    return Date.now() - last.since >= forMs ? true : undefined
  }, `its screen to stay unchanged for ${forMs} ms`)
}

/** Waits until Novadeck sees the terminal's agent waiting on the person for a request. */
const requested = (terminal: DeckTerminal) =>
  terminal.poll(
    async () => ((await terminal.detail()).requests.length > 0 ? true : undefined),
    "Novadeck to see the tool's request",
  )

/**
 * Asserts the message from t2 reached t1 by its Stop continuing the turn the tool ran in:
 * the model looked at the tool's result, answered, and only its next call, in that same
 * conversation, after that answer and with no prompt of anyone's, delivered it. Then t1
 * shows the reply and settles, and from `mark` on its delivery state was only ever
 * Working, never rung, Drafting nor Unknown.
 */
const continued = async (
  model: FakeModel,
  t1: DeckTerminal,
  { calls, mark }: { readonly calls: number; readonly mark: number },
): Promise<void> => {
  // t1's look at its tool's result, in the conversation of its prompt: not t2's at its send's.
  const looked = await model.waitFor(
    (call) =>
      !call.side &&
      result(call) !== undefined &&
      call.turns.some((one) => one.role === "user" && one.text.includes("Make the file")),
    { after: calls },
  )
  const carrying = await model.waitFor((call) => delivered(call, "t2"), { after: calls })
  // The one message, which Claude Code's continuation quotes twice: as the Stop hook's
  // feedback and again as its blocking error (2.1.287).
  expect(new Set(deliveries(carrying).map((one) => JSON.stringify(one)))).toEqual(
    new Set([JSON.stringify({ from: "t2", text: "The build is green." })]),
  )
  expect(model.calls.indexOf(carrying)).toBeGreaterThan(model.calls.indexOf(looked))
  // The turn the tool ran in, its answer to the result last before the delivery: a Stop
  // continuing it, not a prompt, the doorbell's or the person's.
  const answered = carrying.turns.findLastIndex(
    (one) => one.role === "assistant" && one.text.includes("Made it."),
  )
  expect(answered).toBeGreaterThan(-1)
  expect(carrying.turns.slice(answered + 1).every((one) => one.role === "user")).toBe(true)
  expect(latest(carrying)).not.toMatch(ring)
  expect(latest(carrying)).not.toContain("Make the file")

  await t1.until("Noted the news.")
  const settled = await through(t1, [holds("t2", "t1", "delivered"), "settled"], {
    after: mark,
  })
  const states = t1
    .history()
    .slice(mark, settled!.index)
    .map((one) => one.delivery)
  const turned = states.slice(states.indexOf("working"))
  expect(turned.length > 0 && turned.every((one) => one === "working")).toBe(true)
  expect(states).not.toContain("ringing")
  expect(messages(t1).map((one) => [one.from, one.to, one.state])).toEqual([
    ["t2", "t1", "delivered"],
  ])
  expect((await t1.detail()).requests).toEqual([])
}

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)
    const { approval } = setup

    gated(it, lacking(setup, "approval"))(
      "never rings an agent whose permission question is open, and its Stop after delivers",
      async ({ e2e: run }) => {
        run.model.use(...rules(answers("Make the file", (call) => approval!.request(call))))
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        expect([t1.handle, t2.handle]).toEqual(["t1", "t2"])
        const calls = run.model.mark()
        const mark = t1.mark()

        // t1's tool waits on the person when t2's message comes. It waits too, past the
        // doorbell's settle window: t1 is never rung, its turn still Working.
        await t1.confirm(
          approval!.shows,
          async () => {
            await t1.submit("Make the file")
            await requested(t1)
            await t2.submit("Tell t1 the news")
            await t2.until("Told t1.")
            const queued = await t1.reached(holds("t2", "t1", "queued"), { after: mark })
            await sleep(unrung)
            const since = t1
              .history()
              .slice(queued.index)
              .map((one) => one.delivery)
            expect(since.every((one) => one === "working")).toBe(true)
            expect(messages(t1).map((one) => one.state)).toEqual(["queued"])
            expect((await t1.detail()).requests).not.toEqual([])
          },
          { timeoutMs: 5000 },
        )

        // Allowed, the tool runs, and the Stop after it continues the turn with the message.
        await continued(run.model, t1, { calls, mark })
      },
    )

    gated(it, lacking(setup, "approval"))(
      "takes the person's Enter on a permission question as no submission, so its Stop delivers",
      async ({ e2e: run }) => {
        // The turn's first model call is held until t2's message waits, so the question
        // comes, and its Enter is pressed, with the message already there.
        const held = gate()
        run.model.use(
          ...rules(
            own(async (call) => {
              if (!asked(call, "Make the file")) return undefined
              await held.opened
              return approval!.request(call)
            }),
          ),
        )
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        expect([t1.handle, t2.handle]).toEqual(["t1", "t2"])
        const calls = run.model.mark()
        const mark = t1.mark()

        await t1.submit("Make the file")
        await run.model.waitFor((call) => !call.side && asked(call, "Make the file"), {
          after: calls,
        })
        await t1.reached("working", { after: mark })
        await t2.submit("Tell t1 the news")
        await t1.reached(holds("t2", "t1", "queued"), { after: mark })

        // The person answers the question with Enter while the message waits: an answer to
        // the request, not a prompt they submitted or queued.
        await t1.confirm(approval!.shows, async () => {
          held.open()
          await requested(t1)
        })

        // So the Stop continues the turn with the message, rather than leaving it Drafting
        // for a prompt of theirs that never comes.
        await continued(run.model, t1, { calls, mark })
        // Typing the prompt into a Ready box drafts until its Enter; from its turn on,
        // nothing does.
        const states = t1
          .history()
          .slice(mark)
          .map((one) => one.delivery)
        expect(states.slice(states.indexOf("working"))).not.toContain("drafting")
      },
    )

    gated(it, lacking(setup, "rewind"))(
      "rings into what Esc-Esc opened only as its harness takes the paste, pressing nothing else",
      async ({ e2e: run }) => {
        const { shows, swallows } = setup.rewind!
        run.model.use(replies("Say hi", "Hi there."), replies("Carry on", "Carried on."), ...news)
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        expect([t1.handle, t2.handle]).toEqual(["t1", "t2"])
        await turn(t1, "Say hi", "Hi there.")
        // A TUI still draws its turn's end after its Stop (Codex's "Worked for" rule), and
        // an Escape before that interrupts the turn instead.
        await calm(t1)

        // The person opens it with two Escapes inside the harness's Esc-Esc window, keys
        // neutral to Novadeck, so t1 stays Settled.
        const mark = t1.mark()
        t1.press("\x1b")
        await sleep(doubleEscapeMs)
        t1.press("\x1b")
        await t1.until(shows)
        const calls = run.model.mark()
        await t2.submit("Tell t1 the news")

        if (swallows) {
          // It swallows the paste: the ring fails, nothing is pressed, Unknown. It stays
          // open as it was, no line in it, and the message waits.
          await through(t1, [holds("t2", "t1", "queued"), "ringing", "unknown"], { after: mark })
          await sleep(quiet)
          const shown = await t1.screen()
          expect(shown).toMatch(shows)
          expect(shown).not.toMatch(ring)
          expect(t1.history().at(-1)?.delivery).toBe("unknown")
          expect(messages(t1).map((one) => one.state)).toEqual(["queued"])
          expect(run.model.calls.slice(calls).filter((call) => ring.test(latest(call)))).toEqual([])

          // The person leaves it and submits a prompt, whose hook delivers the message.
          await t1.escape()
          await t1.poll(
            async () => (shows.test(await t1.screen()) ? undefined : true),
            "Esc to close what Esc-Esc opened",
          )
          const next = t1.mark()
          await t1.submit("Carry on")
          const carrying = await run.model.waitFor((call) => delivered(call, "t2"), {
            after: calls,
          })
          expect(latest(carrying)).toContain("Carry on")
          await through(t1, ["working", holds("t2", "t1", "delivered"), "settled"], {
            after: next,
          })
          return
        }

        // The paste leaves it and lands in the prompt: the ring goes on as at an empty
        // prompt, its own line the prompt, and nothing was rewound.
        await through(t1, ["ringing", "working", holds("t2", "t1", "delivered")], { after: mark })
        const rung = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
        expect(latest(rung)).toMatch(ring)
        expect(rung.turns.some((one) => one.role === "user" && one.text.includes("Say hi"))).toBe(
          true,
        )
        expect(
          rung.turns.some((one) => one.role === "assistant" && one.text.includes("Hi there.")),
        ).toBe(true)
        await t1.until("Noted the news.")
        await t1.reached("settled", { after: mark })
        expect(await t1.screen()).not.toMatch(shows)
      },
    )
  })

  describe.skipIf(!supported)(`${setup.name}, seeded for its popup`, () => {
    const it = e2e.seeded({ popup: true }, setup)

    gated(it, lacking(setup, "popup"))(
      "never presses anything into a popup it raised after its Stop, and goes Unknown",
      async ({ e2e: run }) => {
        const { reply, shows } = setup.popup!
        run.model.use(
          own((call) => (asked(call, "Say hi") ? reply("Hi there.") : undefined)),
          ...news,
          replies("Carry on", "Carried on."),
        )
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        expect([t1.handle, t2.handle]).toEqual(["t1", "t2"])
        const first = run.model.mark()
        await turn(t1, "Say hi", "Hi there.")
        const said = await run.model.waitFor((call) => !call.side && asked(call, "Say hi"), {
          after: first,
        })

        // Its turn over, the harness raises its own popup, before any message comes.
        await t1.until(shows)
        const mark = t1.mark()
        const calls = run.model.mark()
        await t2.submit("Tell t1 the news")

        // The ring's test paste meets the popup and fails: nothing is pressed, Unknown.
        await through(t1, [holds("t2", "t1", "queued"), "ringing", "unknown"], { after: mark })
        await sleep(quiet)
        expect(await t1.screen()).toMatch(shows)
        expect(t1.history().at(-1)?.delivery).toBe("unknown")
        expect(messages(t1).map((one) => one.state)).toEqual(["queued"])
        expect(run.model.calls.slice(calls).filter((call) => ring.test(latest(call)))).toEqual([])

        // The message waits for the next turn event: the person leaves the popup, with
        // nothing in it chosen, and submits a prompt, whose hook delivers. The model is
        // the one the turn before used, as no option of the popup was taken.
        await t1.escape()
        await t1.poll(
          async () => (shows.test(await t1.screen()) ? undefined : true),
          "Esc to close the popup",
        )
        const next = t1.mark()
        await t1.submit("Carry on")
        const carrying = await run.model.waitFor((call) => delivered(call, "t2"), {
          after: calls,
        })
        expect(latest(carrying)).toContain("Carry on")
        expect(carrying.model).toBe(said.model)
        await t1.until("Noted the news.")
        await through(t1, ["working", holds("t2", "t1", "delivered"), "settled"], {
          after: next,
        })
      },
    )
  })
}
