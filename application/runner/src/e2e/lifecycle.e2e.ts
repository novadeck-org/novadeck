import type { AgentSetup } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import { occurrences, type DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { latest, type Call } from "./model/script.js"
import {
  deliveries,
  delivered,
  handing,
  holds,
  messages,
  own,
  prompted,
  replies,
  result,
  ring,
  sends,
  sent,
  start,
  through,
  turn,
} from "./scenarios.js"

// The terminal's lifecycle under its agent, the same for every harness (see
// messaging.e2e.ts for the rule on parity): the person clearing the conversation, and
// leaving the agent to start another in its terminal. All three clear with `/clear` and
// leave with `/exit`, typed at their prompt (probed 2026-10-02: Claude Code 2.1.287, Codex
// 0.159.3, Antigravity 1.2.14); a harness with another command would bring back a trait.

/** Whether the call holds the conversation before the clear: the prompt it began with. */
const remembers = (call: Call): boolean =>
  call.turns.some((one) => one.role === "user" && one.text.includes("Remember the word heron"))

/** Whether the call is of t2's turn asking t1 once more. */
const again = (call: Call): boolean =>
  call.turns.some((one) => one.role === "user" && one.text.includes("Ask t1 once more"))

/**
 * Has the person type `command` at the agent's prompt, then submit it once `meanwhile` has
 * run, so whatever it does happens while their command waits in the box: Drafting, so no
 * doorbell rings in between.
 */
const typed = async (
  terminal: DeckTerminal,
  command: string,
  meanwhile: () => Promise<unknown>,
): Promise<void> => {
  const mark = terminal.mark()
  await terminal.confirm(command, async () => {
    terminal.press(command)
    await terminal.reached("drafting", { after: mark })
    await meanwhile()
  })
}

/** Waits until the agent's own conversation has left the screen, as its clear shows it. */
const cleared = (terminal: DeckTerminal) =>
  terminal.poll(
    async () => (!(await terminal.screen()).includes("Remember the word heron") ? true : undefined),
    "its conversation to leave the screen",
  )

/**
 * Waits until the turn of the prompt submitted since `from` has ended, Settled, its reply
 * `shows` on screen: the person's next prompt goes to an idle agent. One submitted while the
 * turn still runs is the person's to steer into it, and one that lands just as it ends is
 * dropped by Codex (0.159.3, probed 2026-10-03: shown in its history, never sent to the
 * model), so a scenario that means a new turn waits for this first.
 */
const ended = async (terminal: DeckTerminal, from: number, shows: string): Promise<void> => {
  await terminal.until(shows)
  await through(terminal, ["working", "settled"], { after: from })
}

/**
 * Waits until the screen shows the harness's banner once more than the fewest times it
 * has since the call: the next instance's, drawn as it starts. One that clears its screen
 * as it exits (Claude Code, Codex) draws it again from none, one that leaves it there
 * (Antigravity) a second time, so the first's banner left on screen can't pass for it.
 * Called once the person's command to leave is submitted.
 */
const redrawn = (terminal: DeckTerminal, { banner, name }: AgentSetup): Promise<unknown> => {
  let fewest = Number.POSITIVE_INFINITY
  return terminal.poll(
    async () => {
      const shown = occurrences(await terminal.screen(), banner)
      fewest = Math.min(fewest, shown)
      return shown > fewest ? true : undefined
    },
    `${name} to draw its banner again as it starts anew`,
    60_000,
  )
}

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("is rung in the new session after /clear, which never sees the old conversation", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Remembered."),
        sends("Ask t1 for the word", "t1", "Which word did you remember?"),
        own((call) => (sent(call, "t1") ? { text: "Asked." } : undefined)),
        own((call) =>
          delivered(call, "t2") ? { text: "No word, a new conversation." } : undefined,
        ),
      )
      const t1 = await start(run, setup)
      await turn(t1, "Remember the word heron", "Remembered.")
      const before = (await t1.detail()).sessionId
      expect(before).not.toBeNull()
      const mark = t1.mark()

      await t1.submit("/clear")

      // The harness cleared: its own screen drops the conversation, and NovaDeck sees its
      // agent at an empty prompt again, the old session no longer bound (a new one, or
      // none yet where the harness binds its next session only with its first prompt).
      await cleared(t1)
      await t1.reached("ready", { after: mark })
      await t1.poll(
        async () => ((await t1.detail()).sessionId !== before ? true : undefined),
        "the session bound before the clear to end",
      )
      const t2 = await start(run, setup)
      const calls = run.model.mark()
      const from1 = t1.mark()

      await t2.submit("Ask t1 for the word")

      // Rung in the new session, which its hook delivers to, with nothing of the old.
      const rung = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
      expect(latest(rung)).toMatch(ring)
      expect(deliveries(rung)).toEqual([{ from: "t2", text: "Which word did you remember?" }])
      expect(remembers(rung)).toBe(false)
      await t1.until("No word, a new conversation.")
      await through(
        t1,
        [
          holds("t2", "t1", "queued"),
          "ringing",
          "working",
          holds("t2", "t1", "delivered"),
          "settled",
        ],
        { after: from1 },
      )
      const after = (await t1.detail()).sessionId
      expect(after).not.toBeNull()
      expect(after).not.toBe(before)
    })

    it("makes a message waiting for the session gone at /clear, and tells its sender", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Remembered."),
        sends("Ask t1 for the word", "t1", "Which word did you remember?"),
        sends("Ask t1 once more", "t1", "Any word at all?"),
        own((call) => (sent(call, "t1") ? { text: "Asked." } : undefined)),
        own((call) =>
          delivered(call, "t2") ? { text: "No word, a new conversation." } : undefined,
        ),
      )
      const t1 = await start(run, setup)
      await turn(t1, "Remember the word heron", "Remembered.")
      const before = (await t1.detail()).sessionId
      const t2 = await start(run, setup)
      const mark = t1.mark()
      const asking = t2.mark()

      // The person types /clear; while it waits in the box, Drafting, t2's message comes
      // for the session there, and waits for the person's prompt. They submit the clear.
      await typed(t1, "/clear", async () => {
        await t2.submit("Ask t1 for the word")
        await t1.reached(holds("t2", "t1", "queued"), { after: mark })
      })

      // The harness announced a new session: the message for the old one is gone.
      await cleared(t1)
      await t1.reached(holds("t2", "t1", "gone"), { after: mark })
      await t1.reached("ready", { after: mark })
      const [first] = messages(t1)
      expect(first).toMatchObject({ from: "t2", to: "t1", state: "gone" })
      expect((await t1.detail()).sessionId).not.toBe(before)
      await ended(t2, asking, "Asked.")
      const calls = run.model.mark()
      const from1 = t1.mark()

      await t2.submit("Ask t1 once more")

      // t2's next send says the first won't arrive; the new session is rung for the
      // second alone.
      const told = await run.model.waitFor((call) => sent(call, "t1") && again(call), {
        after: calls,
      })
      expect(result(told)).toContain(
        `Your earlier message ${first!.id} to t1 won't arrive: the agent session it was for ended there.`,
      )
      const rung = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
      expect(deliveries(rung)).toEqual([{ from: "t2", text: "Any word at all?" }])
      expect(remembers(rung)).toBe(false)
      await through(t1, ["ringing", "working", holds("t2", "t1", "delivered"), "settled"], {
        after: from1,
      })
      await t1.until("No word, a new conversation.")
      expect(messages(t1).map((one) => [one.id === first!.id, one.state])).toEqual([
        [true, "gone"],
        [false, "delivered"],
      ])
    })

    it("makes its messages gone when the person leaves it and starts an agent anew, telling the sender", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Remembered."),
        sends("Ask t1 for the word", "t1", "Which word did you remember?"),
        sends("Ask t1 once more", "t1", "Any word at all?"),
        own((call) => (sent(call, "t1") ? { text: "Asked." } : undefined)),
        own((call) => (delivered(call, "t2") ? { text: "No word, a new session." } : undefined)),
      )
      const t1 = await handing(run, setup, setup)
      await turn(t1, "Remember the word heron", "Remembered.")
      const before = (await t1.detail()).sessionId
      const t2 = await start(run, setup)
      const mark = t1.mark()
      const asking = t2.mark()

      // The person types /exit; while it waits in the box, t2's message comes for the
      // session there. They submit it, and the agent leaves; its terminal's command then
      // starts the agent again there, another session.
      await typed(t1, "/exit", async () => {
        await t2.submit("Ask t1 for the word")
        await t1.reached(holds("t2", "t1", "queued"), { after: mark })
      })
      const anew = redrawn(t1, setup)
      // Awaited below, once NovaDeck has seen the new start; a failure before then is the test's.
      anew.catch(() => {})

      // The agent left, and the message for its session won't arrive; then the new start is
      // Ready. With no shell prompt between the two, NovaDeck notices the first's process is
      // gone only as the next reports, in the same handling as the new session it binds, so
      // no Unbound need show between them ("Its harness announces a new session", in
      // docs/agent-messaging.md's transitions).
      await through(t1, [holds("t2", "t1", "gone"), "ready"], {
        after: mark,
        timeoutMs: 60_000,
      })
      await anew
      await prompted(t1, setup)
      const [first] = messages(t1)
      expect(first).toMatchObject({ from: "t2", to: "t1", state: "gone" })
      await ended(t2, asking, "Asked.")
      const calls = run.model.mark()
      const from1 = t1.mark()

      await t2.submit("Ask t1 once more")

      // t2's next send says the first won't arrive; the new session gets only the second.
      const told = await run.model.waitFor((call) => sent(call, "t1") && again(call), {
        after: calls,
      })
      expect(result(told)).toContain(
        `Your earlier message ${first!.id} to t1 won't arrive: the agent session it was for ended there.`,
      )
      const rung = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
      expect(deliveries(rung)).toEqual([{ from: "t2", text: "Any word at all?" }])
      expect(remembers(rung)).toBe(false)
      await through(t1, ["ringing", "working", holds("t2", "t1", "delivered"), "settled"], {
        after: from1,
      })
      await t1.until("No word, a new session.")
      const after = (await t1.detail()).sessionId
      expect(after).not.toBeNull()
      expect(after).not.toBe(before)
      expect(messages(t1).map((one) => [one.id === first!.id, one.state])).toEqual([
        [true, "gone"],
        [false, "delivered"],
      ])
    })
  })
}
