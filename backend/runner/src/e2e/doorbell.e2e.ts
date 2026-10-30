import { setTimeout as sleep } from "node:timers/promises"

import { doorbellLine } from "@novadeck/harness-core/prompts"

import type { Question } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import { occurrences, type DeckTerminal } from "./deck.js"
import { describe, e2e, expect, gated, supported, type E2E } from "./fixture.js"
import { asked, gate, latest } from "./model/script.js"
import {
  answers,
  delivered,
  holds,
  lacking,
  messages,
  own,
  replies,
  result,
  ring,
  sends,
  sent,
  start,
  through,
  turn,
  unrung,
} from "./scenarios.js"

// An idle agent is rung wherever it came to rest, not only when Settled: Drafting, Unknown
// and the like are states Novadeck derives from keys and hooks, and an agent idle at its
// own empty prompt in any of them gets its messages without the person visiting its
// terminal (docs/agent-messaging.md, "Idle but not Ready"). A box that holds text is never
// typed over, and says why. The same scenarios for every harness (see messaging.e2e.ts for
// the rule on parity).

const down = "\x1b[B"
const backspace = "\x7f"

const colour: Question = {
  question: "Which color should the button be?",
  header: "Color",
  multiSelect: false,
  options: [
    { label: "Blue", description: "The house color." },
    { label: "Green", description: "Calmer." },
  ],
}

/** The delivery states the terminal went through from `after` on. */
const states = (terminal: DeckTerminal, after = 0) =>
  terminal
    .history()
    .slice(after)
    .map((one) => one.delivery)

/**
 * What the tests reach into the runner for, as nothing a person does can: the terminal's
 * screen model, where a fake status line ticks, and its pty and messaging, to leave the
 * state a ring whose Enter was lost leaves.
 */
type Internals = {
  readonly messaging: {
    ring(terminalId: string, nonce: string): boolean
    ringFailed(terminalId: string, nonce: string): void
  }
  live(terminalId: string): {
    readonly terminal: {
      readonly screen: { write(data: string): void }
      readonly pty: { write(data: string): void }
    }
  }
}
const internals = (run: E2E): Internals => run.deck.terminals as unknown as Internals

/** Prints a clock in the second row of the terminal's screen once a second, until stopped. */
const tick = (run: E2E, terminal: DeckTerminal): (() => void) => {
  let seconds = 0
  const timer = setInterval(() => {
    seconds += 1
    internals(run)
      .live(terminal.id)
      .terminal.screen.write(`\x1b7\x1b[2;1Huptime ${seconds}s\x1b[K\x1b8`)
  }, 1000)
  return () => clearInterval(timer)
}

/**
 * Leaves the terminal as a ring whose Enter was lost, or whose paste check rejected the
 * line, leaves it: Novadeck's doorbell line in the agent's box, the ring failed, the
 * terminal Unknown. Called with a message
 * waiting and the terminal still inside its settle window, so the doorbell hasn't rung.
 */
const lost = (run: E2E, terminal: DeckTerminal, nonce: string): void => {
  const { messaging } = internals(run)
  expect(messaging.ring(terminal.id, nonce)).toBe(true)
  internals(run)
    .live(terminal.id)
    .terminal.pty.write(`\x1b[200~${doorbellLine(nonce)}\x1b[201~`)
  // Whatever the paste check said, the screen shows the line alone: Novadeck's own.
  messaging.ringFailed(terminal.id, nonce)
}

/** t2 sends t1 one message and waits until t1 holds it queued. */
const message = async (from: DeckTerminal, to: DeckTerminal): Promise<void> => {
  await from.submit("Tell moth the news")
  await to.reached(holds(from.handle, to.handle, "queued"))
}

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)
    const news = [
      sends("Tell moth the news", "moth", "The build is green."),
      own((call) => (sent(call, "moth") ? { text: "Told moth." } : undefined)),
      own((call) => (delivered(call, "fox") ? { text: "Noted the news." } : undefined)),
    ]

    /**
     * Asserts t1, idle and in `before` at the start of the wait, is rung and delivered
     * t2's message with no key of the person's, and settles.
     */
    const rung = async (run: E2E, t1: DeckTerminal, t2: DeckTerminal) => {
      const calls = run.model.mark()
      const mark = t1.mark()
      await message(t2, t1)
      const carrying = await run.model.waitFor((call) => delivered(call, "fox"), {
        after: calls,
        timeoutMs: 60_000,
      })
      expect(ring.test(latest(carrying))).toBe(true)
      await t1.until("Noted the news.")
      await through(t1, ["ringing", "working", holds("fox", "moth", "delivered"), "settled"], {
        after: mark,
      })
    }

    gated(it, lacking(setup, "questions"))(
      "rings an agent idle after the person answered its question in the terminal",
      async ({ e2e: run }) => {
        const asking = setup.asking!
        run.model.use(
          answers("Ask me", (call) => asking.questions(call, [colour])),
          ...news,
          own((call) => (result(call) !== undefined ? { text: "Noted." } : undefined)),
        )
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        await asking.enter?.(t1)
        const mark = t1.mark()

        // They answer in the agent's own terminal with an arrow and Enter, as people do.
        await t1.confirm(colour.question, async () => {
          await t1.prompt("Ask me about the button")
          await t1.until(colour.question)
          t1.press(down)
        })
        await t1.until("Noted.")
        // It rests at its prompt, empty, and Novadeck, which saw keys in a dialog, has it
        // Drafting: that is the state this test is about.
        await t1.reached("drafting", { after: mark })
        await rung(run, t1, t2)
      },
    )

    it("rings an agent idle after a stray key left Drafting and the box empty again", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Warm up", "Warmed up."), ...news)
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      await turn(t1, "Warm up", "Warmed up.")
      const mark = t1.mark()
      t1.press("x")
      await t1.until(/x/)
      t1.press(backspace)
      await t1.reached("drafting", { after: mark })
      await rung(run, t1, t2)
    })

    it("rings an agent whose turn the person interrupted, left Unknown at an empty prompt", async ({
      e2e: run,
    }) => {
      const held = gate()
      run.model.use(
        replies("Warm up", "Warmed up."),
        // The delivery's own turn carries the interrupted prompt along: it answers first.
        ...news,
        own(async (call) => {
          if (!asked(call, "Take your time")) return undefined
          await held.opened
          return { text: "Too late." }
        }),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      await turn(t1, "Warm up", "Warmed up.")
      const calls = run.model.mark()
      const mark = t1.mark()
      await t1.prompt("Take your time")
      await run.model.waitFor((call) => !call.side && latest(call).includes("Take your time"), {
        after: calls,
      })
      await t1.reached("working", { after: mark })
      await t1.interrupt()
      await t1.reached("unknown", { after: mark })
      held.open()
      await sleep(2500)
      await rung(run, t1, t2)
    })

    it("never types over a draft of the person's, says why, and rings once the box is empty", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Warm up", "Warmed up."), ...news)
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      await turn(t1, "Warm up", "Warmed up.")
      const mark = t1.mark()
      t1.press("Tell me")
      await t1.until("Tell me")
      const drafting = await t1.reached("drafting", { after: mark })

      await message(t2, t1)
      await sleep(unrung)
      // Never rung, nothing typed beside the draft, and the pane says why.
      expect(states(t1, drafting.index)).not.toContain("ringing")
      expect(messages(t1).findLast((one) => one.from === "fox")?.state).toBe("queued")
      expect(t1.messages().waits).toBe("draft")
      const shown = await t1.screen()
      expect(shown).toContain("Tell me")
      expect(shown).not.toContain("[Novadeck")

      // They clear it: nothing is typed or pressed by them, and the agent is rung.
      t1.press(backspace.repeat("Tell me".length))
      await t1.reached("ringing", { after: drafting.index, timeoutMs: 60_000 })
      await t1.until("Noted the news.")
      expect(t1.messages().waits).toBeNull()
    })

    it("rings an agent whose screen has a row ticking by itself, a status line's clock", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Warm up", "Warmed up."), ...news)
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      await turn(t1, "Warm up", "Warmed up.")
      const stop = tick(run, t1)
      try {
        await rung(run, t1, t2)
      } finally {
        stop()
      }
    })

    it("submits the line a lost Enter left in the box, without the person's help", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Warm up", "Warmed up."), ...news)
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      await turn(t1, "Warm up", "Warmed up.")
      const calls = run.model.mark()
      const mark = t1.mark()
      await message(t2, t1)
      lost(run, t1, "Lft7Aa")
      await t1.until("Lft7Aa")
      const carrying = await run.model.waitFor((call) => delivered(call, "fox"), {
        after: calls,
        timeoutMs: 60_000,
      })
      expect(latest(carrying)).toContain("Lft7Aa")
      await t1.until("Noted the news.")
      await through(t1, ["ringing", "working", holds("fox", "moth", "delivered"), "settled"], {
        after: mark,
      })
      expect(ring.test(latest(carrying))).toBe(true)
    })

    it("keeps the line a lost Enter left the person's draft once they type after it", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Warm up", "Warmed up."), ...news)
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      await turn(t1, "Warm up", "Warmed up.")
      const mark = t1.mark()
      await message(t2, t1)
      lost(run, t1, "Lft7Bb")
      await t1.until("Lft7Bb")
      t1.press(" and more")
      await t1.until("and more")
      await sleep(unrung)
      expect(states(t1, mark).slice(states(t1, mark).lastIndexOf("unknown"))).not.toContain(
        "ringing",
      )
      expect(messages(t1).findLast((one) => one.from === "fox")?.state).toBe("queued")
      expect(t1.messages().waits).toBe("draft")
      // Nothing pressed or pasted beside their draft: the one line, and their words.
      const shown = await t1.screen()
      expect(shown).toContain("and more")
      expect(occurrences(shown, "Lft7Bb")).toBe(1)
      expect(occurrences(shown, "[Novadeck")).toBe(1)
    })

    it("never rings an agent whose turn is running, however its screen looks, and delivers at its Stop", async ({
      e2e: run,
    }) => {
      const held = gate()
      run.model.use(
        replies("Warm up", "Warmed up."),
        ...news,
        own(async (call) => {
          if (!asked(call, "Take your time")) return undefined
          await held.opened
          return { text: "Done." }
        }),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      await turn(t1, "Warm up", "Warmed up.")
      const calls = run.model.mark()
      const mark = t1.mark()
      await t1.prompt("Take your time")
      await run.model.waitFor((call) => !call.side && latest(call).includes("Take your time"), {
        after: calls,
      })
      const working = await t1.reached("working", { after: mark })
      await message(t2, t1)
      await sleep(unrung)
      expect(states(t1, working.index)).not.toContain("ringing")
      held.open()
      await t1.until("Done.")
      await run.model.waitFor((call) => delivered(call, "fox"), { after: calls, timeoutMs: 60_000 })
      expect(states(t1, mark)).not.toContain("ringing")
    })

    it("rings a second time after a turn of the person's, when Codex draws a Tip under the reply", async ({
      e2e: run,
    }) => {
      // Found by a repro of a second doorbell that failed with its line left in the box: the
      // reply of the person's turn ended with a "Tip" row Codex draws only while its box is
      // empty, which went as the line landed and moved the rows below it up one.
      run.model.use(
        replies("Warm up", "Warmed up."),
        replies("Next job", "Next job done."),
        sends("Send first", "moth", "First peer message."),
        sends("Send second", "moth", "Second peer message."),
        own((call) => (sent(call, "moth") ? { text: "Sent." } : undefined)),
        own((call) =>
          delivered(call, "fox")
            ? {
                text: call.turns.some((entry) => entry.text.includes("Second peer message."))
                  ? "Second peer received."
                  : "First peer received.",
              }
            : undefined,
        ),
      )
      const target = await start(run, setup)
      const sender = await start(run, setup)
      await turn(target, "Warm up", "Warmed up.")
      const first = target.mark()
      await turn(sender, "Send first", "Sent.")
      await target.until("First peer received.")
      await through(target, ["settled"], { after: first })
      await turn(target, "Next job", "Next job done.")
      const second = target.mark()
      await turn(sender, "Send second", "Sent.")
      await target.until("Second peer received.")
      await through(target, ["ringing", "working", "settled"], { after: second })
      // The first ring submitted, and no ring failed or was left for the doorbell to redo.
      expect(states(target)).not.toContain("unknown")
    })
  })
}
