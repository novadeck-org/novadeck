import { readdirSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported, type E2E } from "./fixture.js"
import { asked, gate, latest, type Call } from "./model/script.js"
import {
  deliveries,
  holds,
  messages,
  own,
  prompted,
  replies,
  ring,
  sends,
  sent,
  start,
  through,
  turn,
  unrung,
} from "./scenarios.js"

// The person typing around messages, the same for every harness (see messaging.e2e.ts for
// the rule on parity). What Novadeck must do is docs/agent-messaging.md's ("What counts",
// "States", "Acceptance scenarios"): while the box may hold the person's text it never
// rings, and their next prompt's hook carries what waits.

/** Whether the call is the agent's look at a user turn holding `text`, a prompt of the person's. */
const holding = (call: Call, text: string): boolean => !call.side && latest(call).includes(text)

/** The delivery states the terminal went through from `after` on. */
const states = (terminal: DeckTerminal, after = 0) =>
  terminal
    .history()
    .slice(after)
    .map((one) => one.delivery)

/**
 * Has `from` send `to` one message from its own prompt, and waits until `to` holds it
 * queued: its agent busy or its person drafting, nothing delivers it yet.
 */
const message = async (from: DeckTerminal, to: DeckTerminal, prompt: string): Promise<void> => {
  await from.submit(prompt)
  await to.reached(holds(from.handle, to.handle, "queued"))
}

/**
 * Watches the terminal past the doorbell's settle window, then checks it was never rung
 * from `after` on and the latest message from `from` still waits.
 */
const unrungFor = async (terminal: DeckTerminal, from: string, after: number): Promise<void> => {
  await sleep(unrung)
  expect(states(terminal, after)).not.toContain("ringing")
  expect(messages(terminal).findLast((one) => one.from === from)?.state).toBe("queued")
}

/**
 * The model calls since `after` that carried a delivery, as the recipient's model read
 * them; never the doorbell's line.
 */
const carried = ({ model }: E2E, after: number) => {
  const calls = model.calls.slice(after).filter((call) => !call.side)
  expect(calls.filter((call) => ring.test(latest(call)))).toEqual([])
  return calls.filter((call) => deliveries(call).length > 0)
}

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("never rings an agent the person is mid-sentence in, and their prompt carries the message", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Warm up", "Warmed up."),
        sends("Tell t1 the news", "t1", "The build is green."),
        own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
        own((call) => (asked(call, "about the weather") ? { text: "Sunny all day." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      await turn(t1, "Warm up", "Warmed up.")
      const calls = run.model.mark()
      const mark = t1.mark()

      // The person starts a sentence at t1's prompt, Settled, and has yet to finish it.
      t1.press("Tell me")
      await t1.until("Tell me")
      const drafting = await t1.reached("drafting", { after: mark })

      // A message comes for t1: it waits, and t1 is never rung.
      await message(t2, t1, "Tell t1 the news")
      await unrungFor(t1, "t2", drafting.index)

      // They finish the sentence and submit it: their prompt's hook delivers the message
      // beside it, and the turn is theirs.
      await t1.submit(" about the weather")
      const prompt = await run.model.waitFor((call) => holding(call, "about the weather"), {
        after: calls,
      })
      expect(latest(prompt)).toContain("Tell me about the weather")
      expect(deliveries(prompt)).toEqual([{ from: "t2", text: "The build is green." }])
      await t1.until("Sunny all day.")
      await through(t1, ["working", holds("t2", "t1", "delivered"), "settled"], {
        after: drafting.index,
      })
      expect(carried(run, calls)).toEqual([prompt])
      expect(states(t1, mark)).not.toContain("ringing")
    })

    it("delivers through the prompt the person queued during the turn, never its Stop", async ({
      e2e: run,
    }) => {
      // The turn's reply is held, so the message and the person's queued prompt both come
      // while it runs, the message first.
      const held = gate()
      run.model.use(
        own(async (call) => {
          if (!asked(call, "Start the long job")) return undefined
          await held.opened
          return { text: "Long job done." }
        }),
        sends("Tell t1 the plan", "t1", "The plan is ready."),
        own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
        replies("Then sum it up", "Summed up."),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.submit("Start the long job")
      await run.model.waitFor((call) => holding(call, "Start the long job"), { after: calls })
      await t1.reached("working", { after: mark })
      await message(t2, t1, "Tell t1 the plan")

      // The person queues their next prompt while the turn runs.
      await t1.submit("Then sum it up")
      held.open()

      // Their prompt's hook delivers the message; no Stop continues the turn with it.
      const prompt = await run.model.waitFor((call) => holding(call, "Then sum it up"), {
        after: calls,
      })
      expect(deliveries(prompt)).toEqual([{ from: "t2", text: "The plan is ready." }])
      await t1.until("Summed up.")
      await through(t1, [holds("t2", "t1", "delivered"), "settled"], { after: mark })
      expect(carried(run, calls).every((call) => holding(call, "Then sum it up"))).toBe(true)
      expect(states(t1, mark)).not.toContain("ringing")
    })

    it("leaves the person drafting their next prompt at the Stop, and that prompt carries what came since", async ({
      e2e: run,
    }) => {
      // The turn's reply is held, so the person types while it runs.
      const held = gate()
      run.model.use(
        own(async (call) => {
          if (!asked(call, "Start the long job")) return undefined
          await held.opened
          return { text: "Long job done." }
        }),
        sends("Tell t1 the plan", "t1", "The plan is ready."),
        sends("Tell t1 the date", "t1", "It ships on Friday."),
        own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
        own((call) =>
          deliveries(call).some((one) => one.text === "The plan is ready.") &&
          !holding(call, "then sum it up")
            ? { text: "Read the plan." }
            : undefined,
        ),
        replies("then sum it up", "Summed up."),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.submit("Start the long job")
      await run.model.waitFor((call) => holding(call, "Start the long job"), { after: calls })
      await t1.reached("working", { after: mark })

      // The person types their next prompt while the agent works, and doesn't submit it.
      t1.press("Read it")
      await t1.until("Read it")

      // A message comes during the turn. The person submitted nothing, so the Stop
      // continues the turn with it ("States", Working), and the turn then ends Drafting.
      await message(t2, t1, "Tell t1 the plan")
      held.open()
      const stopped = await run.model.waitFor(
        (call) => deliveries(call).some((one) => one.text === "The plan is ready."),
        { after: calls },
      )
      expect(latest(stopped)).not.toContain("Read it")
      await t1.until("Read the plan.")
      const drafting = await t1.reached("drafting", { after: mark })
      expect(states(t1, mark).slice(0, drafting.index - mark)).not.toContain("settled")

      // A message coming now waits, never rung; their prompt, once submitted, carries it.
      const later = run.model.mark()
      await message(t2, t1, "Tell t1 the date")
      await unrungFor(t1, "t2", drafting.index)
      await t1.submit(", then sum it up")
      const prompt = await run.model.waitFor((call) => holding(call, "then sum it up"), {
        after: later,
      })
      expect(latest(prompt)).toContain("Read it, then sum it up")
      expect(deliveries(prompt)).toEqual([{ from: "t2", text: "It ships on Friday." }])
      await t1.until("Summed up.")
      await through(t1, ["working", "settled"], { after: drafting.index })
      expect(carried(run, later)).toEqual([prompt])
      expect(messages(t1).map((one) => one.state)).toEqual(["delivered", "delivered"])
    })

    it("never rings a Ready agent the person types in, and their prompt carries the message", async ({
      e2e: run,
    }) => {
      run.model.use(
        sends("Tell t1 the news", "t1", "The build is green."),
        own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
        replies("about the weather", "Sunny all day."),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      // The person types at t1's first prompt, Ready.
      t1.press("Tell me")
      await t1.until("Tell me")
      const drafting = await t1.reached("drafting", { after: mark })

      await message(t2, t1, "Tell t1 the news")
      await unrungFor(t1, "t2", mark)

      await t1.submit(" about the weather")
      const prompt = await run.model.waitFor((call) => holding(call, "about the weather"), {
        after: calls,
      })
      expect(latest(prompt)).toContain("Tell me about the weather")
      expect(deliveries(prompt)).toEqual([{ from: "t2", text: "The build is green." }])
      await t1.until("Sunny all day.")
      await through(t1, ["working", holds("t2", "t1", "delivered"), "settled"], {
        after: drafting.index,
      })
      expect(carried(run, calls)).toEqual([prompt])
    })

    it("takes a cursor key at an empty prompt as the person's input, never ringing what it opened", async ({
      e2e: run,
    }) => {
      // No caret moves in an empty box, so what Home does there is the harness's own, as
      // Claude Code's Left opens its agents view, whose field would take the ring's line
      // and its Enter start a new session with it ("What counts"). That view's session
      // outlives the deck, so the person presses Home here: the same rule.
      run.model.use(
        replies("Warm up", "Warmed up."),
        sends("Tell t1 the news", "t1", "The build is green."),
        own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
        replies("What's new?", "The build is green, I hear."),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      await turn(t1, "Warm up", "Warmed up.")
      const calls = run.model.mark()
      const mark = t1.mark()

      // The person presses Home at t1's empty prompt, Settled: a draft.
      t1.press("\x1b[H")
      const drafting = await t1.reached("drafting", { after: mark })

      // A message comes for t1: it waits, and t1 is never rung.
      await message(t2, t1, "Tell t1 the news")
      await unrungFor(t1, "t2", drafting.index)

      // Their next prompt, which Home put nothing in front of, carries it.
      await t1.submit("What's new?")
      const prompt = await run.model.waitFor((call) => holding(call, "What's new?"), {
        after: calls,
      })
      expect(deliveries(prompt)).toEqual([{ from: "t2", text: "The build is green." }])
      await t1.until("The build is green, I hear.")
      await through(t1, ["working", holds("t2", "t1", "delivered"), "settled"], {
        after: drafting.index,
      })
      expect(carried(run, calls)).toEqual([prompt])
      expect(states(t1, mark)).not.toContain("ringing")
    })

    it("takes what the person types while the agent starts as a draft, and never rings it", async ({
      e2e: run,
    }) => {
      run.model.use(
        sends("Tell t2 the news", "t2", "The build is green."),
        own((call) => (sent(call, "t2") ? { text: "Told t2." } : undefined)),
        replies("about the weather", "Sunny all day."),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const t2 = await run.deck.open(setup.agent)

      // The person types once the shell has taken the command that starts the agent, from
      // the file Novadeck left it in its shell folder (keys before then cancel the start,
      // and reach the shell instead): before any session binds. Novadeck takes keys in the
      // write itself, so the state read right after is what they met: Unbound. Whether the
      // harness had drawn its first screen by then is a race a fast one wins, and what it
      // takes of the keys is its own either way.
      await t2.poll(
        () => (readdirSync(run.deck.shell.resume).length === 0 ? true : undefined),
        "the shell to take the command starting its agent",
      )
      t2.press("Hello")
      expect(t2.messages().delivery).toBe("unbound")

      // Its prompt shows (or its session binds) as Drafting, never Ready nor rung.
      const drafting = await t2.reached("drafting", { timeoutMs: 60_000 })
      expect(states(t2).find((state) => state !== "unbound")).toBe("drafting")
      await prompted(t2, setup)
      await message(t1, t2, "Tell t2 the news")
      await unrungFor(t2, "t1", 0)
      expect(states(t2)).not.toContain("ready")

      // Whatever of the keys reached its box, the person's next prompt carries the message.
      await t2.submit(" about the weather")
      const prompt = await run.model.waitFor((call) => holding(call, "about the weather"), {
        after: calls,
      })
      expect(deliveries(prompt)).toEqual([{ from: "t1", text: "The build is green." }])
      await t2.until("Sunny all day.")
      await through(t2, ["working", holds("t1", "t2", "delivered"), "settled"], {
        after: drafting.index,
      })
      expect(carried(run, calls)).toEqual([prompt])
    })

    it("delivers a ring whose window the person resizes as its line lands", async ({
      e2e: run,
    }) => {
      run.model.use(
        sends("Tell t2 the news", "t2", "The build is green."),
        own((call) => (sent(call, "t2") ? { text: "Told t2." } : undefined)),
        own((call) => (deliveries(call).length > 0 ? { text: "Noted." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      const calls = run.model.mark()
      const from2 = t2.mark()

      // A pane changing size mid-ring, as a layout change or the companion bar makes it:
      // the resize redraws the screen the line is checked on, so it waits for the ring.
      await t1.submit("Tell t2 the news")
      await t2.reached("ringing", { after: from2 })
      await sleep(40)
      t2.resize(120, 34)

      const rung = await run.model.waitFor((call) => deliveries(call).length > 0, { after: calls })
      expect(latest(rung)).toMatch(ring)
      expect(deliveries(rung)).toEqual([{ from: "t1", text: "The build is green." }])
      await t2.until("Noted.")
      await through(t2, ["ringing", "working", holds("t1", "t2", "delivered"), "settled"], {
        after: from2,
      })
      expect(t2.summary()).toMatchObject({ cols: 120, rows: 34 })
    })
  })
}
