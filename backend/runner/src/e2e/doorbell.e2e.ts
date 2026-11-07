import { setTimeout as sleep } from "node:timers/promises"

import { doorbellLine } from "@novadeck/harness-core/prompts"
import { newTurn } from "@novadeck/tui-input/box"

import { harnesses } from "../harnesses/registry.js"
import type { Question } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import { occurrences, type DeckTerminal } from "./deck.js"
import { describe, e2e, expect, gated, supported, type E2E } from "./fixture.js"
import { losesLineBreakKeys } from "./known-gaps.js"
import { asked, gate, latest, type Call } from "./model/script.js"
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
const up = "\x1b[A"
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
      // The record's item for the turn says the doorbell started it, and when, close enough to
      // the message's delivery for the chat to tell what it brought.
      const line = (await t1.transcript()).findLast((item) => item.ring !== null)
      expect(line).toMatchObject({ role: "user", ring: { replies: false } })
      const came = t1
        .messages()
        .threads.flatMap((thread) => thread.messages)
        .find((one) => one.deliveredAt !== null)
      expect(came!.deliveredAt).toBeGreaterThanOrEqual(line!.at! - 2_000)
    }

    // A guess that a prompt is queued costs that prompt its notices, and no more. What's asked
    // of a terminal with no summary comes with each prompt, so it says which ones it reached.
    const asksSummary = (call: Call) => /has no summary yet/.test(latest(call))

    gated(it, setup.queueing ? undefined : "its queued prompts' hooks don't run early")(
      "gives notices again by the second prompt after an Escape, and after a /clear",
      async ({ e2e: run }) => {
        const held = gate()
        run.model.use(
          own(async (call) => {
            // The stopped prompt shares the next one's turn.
            if (!asked(call, "Hold on") || /Two|Three|Four|Five/.test(latest(call)))
              return undefined
            await held.opened
            return { text: "Too late." }
          }),
          replies("Two", "Two done."),
          replies("Three", "Three done."),
          replies("Four", "Four done."),
          replies("Five", "Five done."),
        )
        const t1 = await start(run, setup)
        const given = async (words: string) => {
          const calls = run.model.mark()
          await t1.prompt(words)
          const call = await run.model.waitFor((one) => !one.side && asked(one, words), {
            after: calls,
          })
          await t1.until(`${words} done.`)
          await sleep(1_000)
          return asksSummary(call)
        }
        const mark = t1.mark()
        await t1.prompt("Hold on")
        await t1.reached("working", { after: mark })
        await sleep(1_500)
        run.deck.terminals.write({ terminalId: t1.id, data: "\x1b" }, "e2e")
        await sleep(2_500)
        held.open()
        // The first may be taken for one queued behind a turn the Escape didn't stop, as it can't
        // be told from one; it costs no more than that one.
        await given("Two")
        expect(await given("Three")).toBe(true)
        for (const key of "/clear") {
          run.deck.terminals.write({ terminalId: t1.id, data: key }, "e2e")
          // eslint-disable-next-line no-await-in-loop -- One key after another.
          await sleep(60)
        }
        await sleep(500)
        run.deck.terminals.write({ terminalId: t1.id, data: "\r" }, "e2e")
        await sleep(3_000)
        expect(await given("Four")).toBe(true)
        expect(await given("Five")).toBe(true)
      },
    )

    gated(it, setup.queueing ? undefined : "its queued prompts' hooks don't run early")(
      "gives a queued prompt's notices to the next prompt that isn't queued",
      async ({ e2e: run }) => {
        const held = gate()
        run.model.use(
          own(async (call) => {
            if (!asked(call, "Hold on")) return undefined
            await held.opened
            return { text: "Held on." }
          }),
          replies("Queued", "Queued done."),
          replies("After", "After done."),
        )
        const t1 = await start(run, setup)
        const mark = t1.mark()
        await t1.prompt("Hold on")
        await t1.reached("working", { after: mark })
        const calls = run.model.mark()
        await t1.prompt("Queued")
        await t1.until(setup.queued!("Queued"))
        held.open()
        const queued = await run.model.waitFor((one) => !one.side && asked(one, "Queued"), {
          after: calls,
        })
        expect(asksSummary(queued)).toBe(false)
        await t1.until("Queued done.")
        await sleep(1_500)
        const after = run.model.mark()
        await t1.prompt("After")
        const next = await run.model.waitFor((one) => !one.side && asked(one, "After"), { after })
        expect(asksSummary(next)).toBe(true)
      },
    )

    // A queued prompt's hook runs as it is queued, and a Stop takes the prompt back out: a
    // message printed there would go with it, unseen, though held as delivered.
    const slowQueue = e2e.seeded({}, setup)
    gated(slowQueue, setup.queueing ? undefined : "its queued prompts' hooks don't run early")(
      "brings a message to an agent whose queued prompt a Stop took back, and no doorbell line back to the person",
      async ({ e2e: run }) => {
        const held = gate()
        run.model.use(
          sends("Tell moth the news", "moth", "The build is green."),
          own((call) => (sent(call, "moth") ? { text: "Told moth." } : undefined)),
          own((call) => (delivered(call, "fox") ? { text: "Noted the news." } : undefined)),
          own(async (call) => {
            if (!asked(call, "Hold on")) return undefined
            await held.opened
            return { text: "Too late." }
          }),
        )
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        const mark = t1.mark()
        await t1.prompt("Hold on")
        await t1.reached("working", { after: mark })
        await message(t2, t1)
        await t1.prompt("Queued beta")
        const { pty } = internals(run).live(t1.id).terminal
        pty.write(`\x1b[200~${doorbellLine("abc123def")}\x1b[201~`)
        await sleep(300)
        pty.write("\r")
        await t1.until(/Press up to edit queued messages/)
        const calls = run.model.mark()
        const stopped = await t1.interrupt()
        held.open()
        expect(stopped.returned).toBe("Queued beta")
        // Nothing more from the person: the doorbell brings it.
        await run.model.waitFor((call) => delivered(call, "fox"), {
          after: calls,
          timeoutMs: 60_000,
        })
        await t1.until("Noted the news.")
      },
    )

    // The queued turn fires no hook, so the runner has it idle while it runs, and a prompt
    // queued behind that one reads as no prompt behind a turn at all.
    gated(slowQueue, setup.queueing ? undefined : "its queued prompts' hooks don't run early")(
      "brings a message to an agent whose second queued prompt a Stop took back from a turn no hook told of",
      async ({ e2e: run }) => {
        const held = gate()
        const betaHeld = gate()
        run.model.use(
          sends("Tell moth the news", "moth", "The build is green."),
          own((call) => (sent(call, "moth") ? { text: "Told moth." } : undefined)),
          own((call) => (delivered(call, "fox") ? { text: "Noted the news." } : undefined)),
          own(async (call) => {
            if (asked(call, "Queued beta")) {
              await betaHeld.opened
              return { text: "Beta done." }
            }
            if (!asked(call, "Hold on")) return undefined
            await held.opened
            return { text: "Too late." }
          }),
        )
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        const mark = t1.mark()
        await t1.prompt("Hold on")
        await t1.reached("working", { after: mark })
        await t1.prompt("Queued beta")
        await t1.until(/Press up to edit queued messages/)
        await sleep(1500)
        const toBeta = run.model.mark()
        held.open()
        await run.model.waitFor((call) => !call.side && latest(call).includes("Queued beta"), {
          after: toBeta,
        })
        await message(t2, t1)
        await t1.prompt("Queued gamma")
        await t1.until(/Press up to edit queued messages/)
        await sleep(1500)
        const calls = run.model.mark()
        const stopped = await t1.interrupt()
        betaHeld.open()
        expect(stopped.returned).toBe("Queued gamma")
        await run.model.waitFor((call) => delivered(call, "fox"), {
          after: calls,
          timeoutMs: 60_000,
        })
      },
    )

    /* eslint-disable no-await-in-loop -- Each step waits for the one before. */
    gated(slowQueue, setup.queueing ? undefined : "its queued prompts' hooks don't run early")(
      "brings a message to an agent whose third queued prompt a Stop took back, behind two turns no hook told of",
      async ({ e2e: run }) => {
        const held = gate()
        const betaHeld = gate()
        const gammaHeld = gate()
        run.model.use(
          sends("Tell moth the news", "moth", "The build is green."),
          own((call) => (sent(call, "moth") ? { text: "Told moth." } : undefined)),
          own((call) => (delivered(call, "fox") ? { text: "Noted the news." } : undefined)),
          own(async (call) => {
            if (asked(call, "Queued gamma")) {
              await gammaHeld.opened
              return { text: "Gamma done." }
            }
            if (asked(call, "Queued beta")) {
              await betaHeld.opened
              return { text: "Beta done." }
            }
            if (!asked(call, "Hold on")) return undefined
            await held.opened
            return { text: "Too late." }
          }),
        )
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        const mark = t1.mark()
        await t1.prompt("Hold on")
        await t1.reached("working", { after: mark })
        // Each queued while the turn ahead of it runs, the last two behind turns no hook told of.
        for (const [next, release] of [
          ["Queued beta", held],
          ["Queued gamma", betaHeld],
        ] as const) {
          await t1.prompt(next)
          await t1.until(/Press up to edit queued messages/)
          await sleep(1500)
          const to = run.model.mark()
          release.open()
          await run.model.waitFor((call) => !call.side && latest(call).includes(next), {
            after: to,
          })
          await sleep(1000)
        }
        await message(t2, t1)
        await t1.prompt("Queued delta")
        await t1.until(/Press up to edit queued messages/)
        await sleep(1500)
        const calls = run.model.mark()
        const stopped = await t1.interrupt()
        gammaHeld.open()
        expect(stopped.returned).toBe("Queued delta")
        await run.model.waitFor((call) => delivered(call, "fox"), {
          after: calls,
          timeoutMs: 60_000,
        })
      },
    )

    // What the counting of queued turns rests on, on the harness's real screen: a change in how
    // it words its status row turns that off, so this says so out loud.
    gated(it, setup.queueing ? undefined : "its queued prompts' hooks don't run early")(
      "reads from its screen a turn its queue starts, and one ending with none after it",
      async ({ e2e: run }) => {
        const status = harnesses[setup.agent].box!.status!
        for (const queueing of [true, false]) {
          const held = gate()
          const queuedHeld = gate()
          run.model.use(
            own(async (call) => {
              if (asked(call, "Queued beta")) {
                await queuedHeld.opened
                return { text: "Queued done." }
              }
              if (!asked(call, "Hold on")) return undefined
              await held.opened
              return { text: "Held reply." }
            }),
          )
          const t1 = await start(run, setup)
          const mark = t1.mark()
          const calls = run.model.mark()
          await t1.prompt("Hold on")
          await t1.reached("working", { after: mark })
          // Its request has gone, so a prompt queued now runs as a turn of its own.
          await run.model.waitFor((call) => !call.side && asked(call, "Hold on"), { after: calls })
          if (queueing) {
            await t1.prompt("Queued beta")
            await t1.until(/Press up to edit queued messages/)
            await sleep(1500)
          }
          held.open()
          // Read until a row comes after the turn's ending one, or none has for a while.
          const seen: (ReturnType<typeof status> | null)[] = []
          const until = Date.now() + 30_000
          let quiet = 0
          while (Date.now() < until) {
            const shown = await t1.screenText()
            const now = (shown && status(shown)) ?? null
            seen.push(now)
            const ended = seen.findIndex((each) => each?.ending === true)
            if (ended >= 0 && now !== null && !now.ending) break
            quiet = ended >= 0 && now === null ? quiet + 1 : 0
            if (quiet >= 100) break
            await sleep(10)
          }
          queuedHeld.open()
          const ending = seen.findIndex((each) => each?.ending === true)
          expect(ending, JSON.stringify(seen.slice(-20))).toBeGreaterThanOrEqual(0)
          const after = seen.slice(ending + 1).find((each) => each?.ending !== true)
          if (queueing) {
            expect(after, JSON.stringify(seen.slice(-20))).toMatchObject({ ending: false })
            expect(newTurn(seen[ending]!, after!)).toBe(true)
          } else expect(seen.at(-1), JSON.stringify(seen.slice(-20))).toBeNull()
        }
      },
    )

    /* eslint-enable no-await-in-loop */

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

    // Blank lines typed, words under them, and the cursor moved up over the blank rows to the
    // box's first row: on Codex that row read as an empty box, and a ring went out with the words
    // after it; with four, its box shows blank rows alone over a dim `↓`. Every harness holds the
    // message for the draft.
    for (const lines of [3, 4])
      it(`never rings over a draft under ${lines} blank rows, the cursor moved back up over them`, async ({
        e2e: run,
      }) => {
        run.model.use(replies("Warm up", "Warmed up."), ...news)
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        await turn(t1, "Warm up", "Warmed up.")
        t1.resize(80, 12)
        await sleep(1_200)
        const mark = t1.mark()
        const write = (data: string) => run.deck.terminals.write({ terminalId: t1.id, data }, "e2e")
        if (losesLineBreakKeys(setup))
          write(`\x1b[200~${"\n".repeat(lines)}MY DRAFT BELOW\x1b[201~`)
        else {
          for (let line = 0; line < lines; line += 1) {
            write(setup.agent === "agy" ? "\x1b\r" : "\n")
            // eslint-disable-next-line no-await-in-loop -- One key after another.
            await sleep(150)
          }
          write("MY DRAFT BELOW")
        }
        await t1.until("MY DRAFT BELOW")
        for (let line = 0; line < lines; line += 1) {
          t1.press(up)
          // eslint-disable-next-line no-await-in-loop -- As above.
          await sleep(200)
        }
        await t1.settled()
        await message(t2, t1)
        await sleep(unrung)
        expect(states(t1, mark)).not.toContain("ringing")
        expect(messages(t1).findLast((one) => one.from === "fox")?.state).toBe("queued")
        expect(t1.messages().waits).toBe("draft")
        expect(await t1.screen()).not.toContain("[Novadeck")
        // The words are where they were, out of sight on Claude Code's box until scrolled back to.
        t1.press(down.repeat(lines))
        await t1.until("MY DRAFT BELOW")
      })

    // A row of `─` in a draft read as the box's top rule, so the draft as a dialog, on Claude Code
    // and Antigravity: it waits as a draft, and says so.
    it("holds the message for a draft with a row of ─ in it, as a draft", async ({ e2e: run }) => {
      run.model.use(replies("Warm up", "Warmed up."), ...news)
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      await turn(t1, "Warm up", "Warmed up.")
      t1.resize(40, 14)
      await sleep(1_200)
      const mark = t1.mark()
      run.deck.terminals.write(
        { terminalId: t1.id, data: `\x1b[200~first line\n${"─".repeat(30)}\nlast line\x1b[201~` },
        "e2e",
      )
      await t1.until("last line")
      await message(t2, t1)
      await sleep(unrung)
      expect(states(t1, mark)).not.toContain("ringing")
      expect(t1.messages().waits).toBe("draft")
      expect(await t1.screen()).not.toContain("[Novadeck")
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

    // Text that fills its row leaves Codex's cursor on the blank row under it, for the box to
    // read as no box at all. The doorbell line is one length, so a pane of this width has it.
    it("rings a pane just wide enough for its line to fill a row", async ({ e2e: run }) => {
      run.model.use(
        replies("Warm up", "Warmed up."),
        sends("Tell moth the news", "moth", "The build is green."),
        own((call) => (sent(call, "moth") ? { text: "Told moth." } : undefined)),
        own((call) => (delivered(call, "fox") ? { text: "Noted the news." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      await turn(t1, "Warm up", "Warmed up.")
      t1.resize(doorbellLine("nonce6").length + 3, 40)
      await sleep(1_000)
      await t2.submit("Tell moth the news")
      await t1.reached(holds(t2.handle, t1.handle, "delivered"), { timeoutMs: 45_000 })
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
