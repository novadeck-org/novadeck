import { setTimeout as sleep } from "node:timers/promises"

import type { AgentDetail, TranscriptItem } from "@novadeck/protocol"

import type { Question } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, gate, latest, tool, type Call } from "./model/script.js"
import {
  answers,
  deliveries,
  delivered,
  holds,
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
  wrappers,
  pointsBack,
} from "./scenarios.js"

type Dialog = NonNullable<AgentDetail["requests"][number]["dialog"]>

/** Waits until the terminal's first request shows a dialog of `type`, and returns it with its ref. */
const dialogOf = <T extends Dialog["type"]>(
  terminal: DeckTerminal,
  type: T,
): Promise<{ ref: string; dialog: Extract<Dialog, { type: T }> }> =>
  terminal.poll(
    async () => {
      const [request] = (await terminal.detail()).requests
      const dialog = request?.dialog
      return dialog?.type === type
        ? { ref: request!.ref, dialog: dialog as Extract<Dialog, { type: T }> }
        : undefined
    },
    `its request to show a ${type} dialog`,
    60_000,
  )

/** The root transcript as `agents.transcript` serves it, or undefined while none is bound. */
const served = async (terminal: DeckTerminal): Promise<readonly TranscriptItem[] | undefined> => {
  try {
    return await terminal.transcript()
  } catch (error) {
    if ((error as { code?: string }).code === "NOT_FOUND") return undefined
    throw error
  }
}

/** Waits until the served transcript passes `fits`, and returns it. */
const servedOnce = (
  terminal: DeckTerminal,
  fits: (items: readonly TranscriptItem[]) => boolean,
  what: string,
): Promise<readonly TranscriptItem[]> =>
  terminal.poll(
    async () => {
      const items = await served(terminal)
      return items && fits(items) ? items : undefined
    },
    what,
    60_000,
  )

const userSaid = (items: readonly TranscriptItem[], words: string): number =>
  items.findIndex((one) => one.role === "user" && !one.interrupted && one.text.includes(words))

const colour: Question = {
  question: "Which color should the button be?",
  header: "Color",
  multiSelect: false,
  options: [
    { label: "Blue", description: "The house color." },
    { label: "Green", description: "Calmer." },
  ],
}

// Novadeck restarting under its agents, the same for every harness (see messaging.e2e.ts
// for the rule on parity).
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("serves the chat again after a restart as it was: a tool call, a question and their answers", async ({
      e2e: run,
    }) => {
      const { approval, asking } = setup
      if (!approval || !asking) throw new Error(`${setup.name} has no approval or questions`)
      run.model.use(
        answers("Make the file", (call) => approval.request(call)),
        answers("Ask me about the button", (call) => asking.questions(call, [colour])),
        own((call) => (result(call)?.includes("Green") ? { text: "Green it is." } : undefined)),
        own((call) => (result(call) !== undefined ? { text: "Made it." } : undefined)),
        replies("Carry on", "Carried on."),
      )
      const t1 = await start(run, setup)

      // A tool call the chat allows, through the harness's own permission dialog.
      const made = t1.mark()
      await t1.prompt("Make the file")
      const allow = await dialogOf(t1, "choices")
      const yes = allow.dialog.options.find((each) => each.label.startsWith("Yes") && each.text === null)
      if (!yes) throw new Error(`No yes in ${JSON.stringify(allow.dialog)}`)
      await t1.answer(allow.ref, { dialog: allow.dialog.id, type: "choice", option: yes.id })
      await t1.until("Made it.")
      await through(t1, ["working", "settled"], { after: made })

      // A question the chat answers, through the harness's own question tool.
      await asking.enter?.(t1)
      const askedAt = t1.mark()
      await t1.prompt("Ask me about the button")
      const question = await dialogOf(t1, "questions")
      const [first] = question.dialog.questions
      const green = first!.options.find(({ label }) => label === "Green")!
      await t1.answer(question.ref, {
        dialog: question.dialog.id,
        type: "questions",
        answers: [{ question: first!.id, options: [green.id] }],
      })
      await t1.until("Green it is.")
      await through(t1, ["working", "settled"], { after: askedAt })
      const before = await servedOnce(
        t1,
        (items) =>
          items.some((one) => one.role === "assistant" && one.text.includes("Green it is.")),
        "the chat to hold the answer's reply",
      )
      const calls = before.filter((one) => one.kind === "tool-call")
      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(
        calls.every((call) =>
          before.some((one) => one.kind === "tool-result" && one.call === call.call),
        ),
      ).toBe(true)

      await run.deck.restart()

      // The resumed session's next prompt binds it where its prompt doesn't, and the chat
      // is served from the transcript's start again: the same items, then the new turn's.
      const resumed = await run.deck.restore(t1, { resume: setup.agent })
      await resumed.reached("ready", { timeoutMs: 60_000 })
      await prompted(resumed, setup)
      await resumed.prompt("Carry on")
      await resumed.until("Carried on.")
      const after = await servedOnce(
        resumed,
        (items) =>
          items.some((one) => one.role === "assistant" && one.text.includes("Carried on.")),
        "the chat to hold the resumed turn",
      )
      expect(after.slice(0, before.length)).toEqual(before)
      expect(userSaid(after, "Carry on")).toBeGreaterThanOrEqual(before.length)
    })

    it("still shows where the person interrupted a turn once the runner restarts", async ({
      e2e: run,
    }) => {
      const held = gate()
      run.model.use(
        replies("Carry on", "Carried on."),
        own(async (call) => {
          if (!asked(call, "Take your time")) return undefined
          await held.opened
          return { text: "Too late." }
        }),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()
      await t1.prompt("Take your time")
      await run.model.waitFor((call) => !call.side && latest(call).includes("Take your time"), {
        after: calls,
      })
      await t1.reached("working", { after: mark })
      await t1.interrupt()
      await t1.reached("unknown", { after: mark })
      // Every harness's chat shows it: Claude Code's and Codex's transcripts record it,
      // and the runner keeps Antigravity's, which doesn't.
      const before = await servedOnce(
        t1,
        (items) => items.some((one) => one.interrupted),
        "the chat to show the interruption",
      )
      held.open()
      // The held reply is let go and must never show; the runner's verdict on the Escape,
      // which keeps Antigravity's mark, is in by now.
      await sleep(3000)
      expect(before.findIndex((one) => one.interrupted)).toBeGreaterThan(
        userSaid(before, "Take your time"),
      )

      await run.deck.restart()

      const resumed = await run.deck.restore(t1, { resume: setup.agent })
      await resumed.reached("ready", { timeoutMs: 60_000 })
      await prompted(resumed, setup)
      await resumed.prompt("Carry on")
      await resumed.until("Carried on.")
      const after = await servedOnce(
        resumed,
        (items) =>
          items.some((one) => one.role === "assistant" && one.text.includes("Carried on.")),
        "the chat to hold the resumed turn",
      )
      const noted = after.findIndex((one) => one.interrupted)
      expect(noted).toBeGreaterThan(userSaid(after, "Take your time"))
      expect(noted).toBeLessThan(userSaid(after, "Carry on"))
      expect(after.filter((one) => one.interrupted)).toHaveLength(1)
      expect(after.map((one) => one.text).join("\n")).not.toContain("Too late.")
    })

    it("points a session resumed after a restart to the rules note it was given before", async ({
      e2e: run,
    }) => {
      run.model.use(
        sends("Ask moth for the word", "moth", "Which word did you remember?"),
        own((call) =>
          !call.side && ring.test(latest(call)) && deliveries(call).length > 0
            ? { text: "Heron, as asked." }
            : undefined,
        ),
        own((call) => (sent(call, "moth") ? { text: "Asked." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      const before = run.model.mark()
      await t2.submit("Ask moth for the word")
      await run.model.waitFor((call) => delivered(call, "fox"), { after: before })
      await t1.until("Heron, as asked.")
      await t1.reached("settled")

      await run.deck.restart()
      const resumed = await run.deck.restore(t1, { resume: setup.agent })
      await resumed.reached("ready", { timeoutMs: 60_000 })
      await prompted(resumed, setup)
      const t3 = await start(run, setup)
      const calls = run.model.mark()
      await t3.submit("Ask moth for the word")

      // Where the harness keeps what its hooks print, its conversation holds the first
      // delivery with the note in full, and this one only points to it; elsewhere the
      // first is gone, and this one carries the note in full.
      const rung = await run.model.waitFor(
        (call) => !call.side && ring.test(latest(call)) && deliveries(call).length > 0,
        { after: calls },
      )
      expect(wrappers(rung).map(pointsBack)).toEqual(setup.keepsHookText ? [false, true] : [false])
      await resumed.until("Heron, as asked.")
    })

    it("resumes its session once the runner restarts, and is rung there for a message", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Remembered."),
        sends("Ask moth for the word", "moth", "Which word did you remember?"),
        own((call) => (delivered(call, "fox") ? { text: "Heron, as asked." } : undefined)),
      )
      const t1 = await start(run, setup)
      await turn(t1, "Remember the word heron", "Remembered.")
      const { sessionId } = await t1.detail()
      expect(sessionId).not.toBeNull()

      await run.deck.restart()

      // The new runner keeps the terminal as saved, with no shell, until a client restores
      // it, naming the agent that ran there.
      expect(
        run.deck.terminals.list(run.deck.sessionId).map((one) => [one.id, one.started]),
      ).toEqual([[t1.id, false]])
      const resumed = await run.deck.restore(t1, { resume: setup.agent })
      expect(resumed.handle).toBe("moth")
      await resumed.reached("ready", { timeoutMs: 60_000 })
      await prompted(resumed, setup)
      const t2 = await start(run, setup)
      const calls = run.model.mark()
      const mark = resumed.mark()

      await t2.submit("Ask moth for the word")

      // The resumed t1, Ready, is rung, in the conversation it had before the restart.
      const rung = await run.model.waitFor((call) => delivered(call, "fox"), { after: calls })
      expect(latest(rung)).toMatch(ring)
      expect(deliveries(rung)).toEqual([{ from: "fox", text: "Which word did you remember?" }])
      expect(
        rung.turns.some(
          (one) => one.role === "user" && one.text.includes("Remember the word heron"),
        ),
      ).toBe(true)
      await resumed.until("Heron, as asked.")
      // Its ring is confirmed, so the turn it started ends Settled, not Drafting.
      await through(
        resumed,
        [
          holds("fox", "moth", "queued"),
          "ringing",
          "working",
          holds("fox", "moth", "delivered"),
          "settled",
        ],
        { after: mark },
      )
      expect((await resumed.detail()).sessionId).toBe(sessionId)
    })

    it("still knows after a restart that the person gave a peer more to do after its done", async ({
      e2e: run,
    }) => {
      const named = (call: Call, name: string): string => {
        const found = [call, ...run.model.calls].map((one) => tool(one, name)).find(Boolean)
        if (!found) throw new Error(`Novadeck's ${name} tool is missing`)
        return found
      }
      const listings: string[] = []
      run.model.use(
        own((call) => {
          if (asked(call, "Finish up"))
            return {
              calls: [
                {
                  name: named(call, "done"),
                  input: { subject: "Fixed the login bug", body: "All green." },
                },
              ],
            }
          if (/Report [a-f0-9-]+ is in the user's Inbox/.test(result(call) ?? ""))
            return { text: "Reported it done." }
          if (asked(call, "Look around"))
            return { calls: [{ name: named(call, "agents"), input: {} }] }
          const listing = result(call)
          if (listing?.includes("Other terminals in this project and session")) {
            listings.push(listing)
            return { text: "Looked." }
          }
          return undefined
        }),
        replies("Next task", "On the next task."),
      )
      const t1 = await start(run, setup)
      await turn(t1, "Finish up", "Reported it done.")
      await turn(t1, "Next task", "On the next task.")

      await run.deck.restart()

      const resumed = await run.deck.restore(t1, { resume: setup.agent })
      await resumed.reached("ready", { timeoutMs: 60_000 })
      await prompted(resumed, setup)
      const t2 = await start(run, setup)
      await turn(t2, "Look around", "Looked.")
      // The person's prompt after the done is kept with the terminal: never a stale done.
      expect(listings[0]).not.toContain("reported done")
      // A harness that binds its resumed session at its prompt shows its reports at once;
      // the others only once their next prompt binds it.
      if (setup.bindsAtReady)
        expect(listings[0]).toMatch(/\n {2}latest update [^:\n]+: Fixed the login bug\n?/)
    })

    it("returns a message leased to its hook to queued when the runner restarts", async ({
      e2e: run,
    }) => {
      run.model.use(
        replies("Remember the word heron", "Remembered."),
        sends("Ask fox for its colour", "fox", "What is your colour?"),
        own((call) => (sent(call, "fox") ? { text: "Asked." } : undefined)),
        own((call) => (delivered(call, "moth") ? { text: "Mine is teal." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      // A turn first, so every harness has saved t2's session for its resume.
      await turn(t2, "Remember the word heron", "Remembered.")
      const { sessionId } = await t2.detail()
      const from2 = t2.mark()
      // The runner stops as soon as t2's ring's hook has the message leased, before its
      // acknowledgement can be heard: the listing that shows the lease comes in the tick
      // the runner leased it (its watches coalesce changes with setImmediate), and the
      // restart ends every lease at once, while the hook still has to read its answer,
      // print it and connect again to acknowledge.
      const restarted = t2
        .reached(holds("moth", "fox", "leased"), { after: from2 })
        .then(() => run.deck.restart())

      await t1.submit("Ask fox for its colour")
      await restarted

      // The new runner holds the message queued again, for the session t2's ring bound,
      // as t2's first listing there shows; resumed in that session, t2 is rung for it again.
      const calls = run.model.mark()
      const resumed = await run.deck.restore(t2, { resume: setup.agent })
      const [first] = resumed.history()
      expect(first?.messages.map((one) => [one.from, one.to, one.state])).toEqual([
        ["moth", "fox", "queued"],
      ])
      await through(resumed, ["ready", "ringing", "working", holds("moth", "fox", "delivered")], {
        timeoutMs: 60_000,
      })
      // At least once: the ring's hook may have printed it before the runner stopped, its
      // acknowledgement lost, and the agent then holds it twice, as the same message.
      const rung = await run.model.waitFor((call) => delivered(call, "moth"), { after: calls })
      const once = { from: "moth", text: "What is your colour?" }
      expect([[once], [once, once]]).toContainEqual(deliveries(rung))
      await resumed.until("Mine is teal.")
      expect((await resumed.detail()).sessionId).toBe(sessionId)
    })
  })
}
