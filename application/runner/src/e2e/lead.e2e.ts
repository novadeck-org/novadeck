import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, gate, text, tool, type Call } from "./model/script.js"
import {
  delivered,
  holds,
  messages,
  opened,
  opens,
  own,
  sends,
  sent,
  start,
  through,
} from "./scenarios.js"

// An agent's lead (docs/agent-messaging.md, "Authority"): the agent whose terminal opened
// its terminal. Its messages are marked `lead="<mark>"`, a mark new in every delivery, and
// while the agent's turn runs they reach it at its next tool call ("The lead's messages
// mid-turn"), where a peer's wait for the Stop. The same for every harness (see messaging.e2e.ts for the rule on parity).

const leadNote = "are from your lead, the agent that opened this terminal"

// The brief the lead opens its worker with, the lead's message when it sends one midway,
// and a peer's message to the worker.
const brief = "Survey the project and report back."
const redirect = "Also look into the docs folder."
const news = "FYI the build is green."

// The wrapper of every message in a call's text, in whichever way the harness carried it:
// plain beside a prompt or a tool result, or HTML-escaped inside a Stop's continuation.
const wrappers = (call: Call): string[] => {
  const all = text(call).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
  return [...all.matchAll(/<message\b[^>]*>/g)].map(([tag]) => tag)
}

// The opening tag of the message from `from` that the call carries, if it does.
const wrapper = (call: Call, from: string): string | undefined =>
  wrappers(call).find((tag) => tag.includes(`from="${from}"`))

// How many tool calls the agent has made in the conversation so far.
const made = (call: Call): number =>
  call.turns.filter((turn) => turn.role === "assistant" && turn.calls.length > 0).length

// The notice Novadeck puts in a terminal's first prompt, which names that terminal's
// conversation: no other terminal's holds the same one.
const notice = (call: Call): string | undefined =>
  /\[Novadeck: [^\]]*\]/.exec(call.turns.find((turn) => turn.role === "user")?.text ?? "")?.[0]

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("marks the brief of the agent that opened a terminal as its lead's", async ({
      e2e: run,
    }) => {
      const requests = run.deck.answerRequests()
      run.model.use(
        opens("Start a helper", setup.agent, brief),
        own((call) => (opened(call, "t2") ? { text: "Started t2." } : undefined)),
        own((call) => (delivered(call, "t1") ? { text: "Surveying now." } : undefined)),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()

      await t1.submit("Start a helper")

      const t2 = await requests.next()
      const first = await run.model.waitFor((call) => delivered(call, "t1"), {
        after: calls,
      })
      const tag = wrapper(first, "t1")
      const mark = / lead="([0-9A-Za-z]{8})"/.exec(tag ?? "")?.[1]
      if (!mark) throw new Error(`no lead mark in ${tag}`)
      expect(text(first)).toContain(leadNote)
      // The note names the very mark of the message, in single quotes within its attribute.
      expect(text(first)).toContain(`lead='${mark}'`)
      expect(text(first)).toContain(brief)
      await t2.until("Surveying now.")
    })

    it("delivers its lead's message at the next tool call of a turn, a peer's at the Stop", async ({
      e2e: run,
    }) => {
      // t3's first reply is held until both messages wait for it, so they arrive while its
      // turn runs; its last reply is held until the test has looked at what the tool call
      // brought and at the messages' states.
      const working = gate()
      // The worker's conversation, known by its first request, the one holding the brief.
      let home: string | undefined
      const works = (call: Call): boolean => {
        if (call.side) return false
        if (
          home === undefined &&
          call.turns.some((t) => t.role === "user" && t.text.includes(brief))
        )
          home = notice(call)
        return home !== undefined && notice(call) === home
      }
      const finishing = gate()
      // Its first request goes out before its MCP tools load, so the tool is named as
      // the other terminals' requests offer it.
      const agents = (call: Call) => {
        const name = [call, ...run.model.calls].map((one) => tool(one, "agents")).find(Boolean)
        return { calls: [{ name: name!, input: {} }] }
      }
      run.model.use(
        opens("Start a worker", setup.agent, brief),
        own((call) => (opened(call, "t3") ? { text: "Started t3." } : undefined)),
        sends("Redirect t3", "t3", redirect),
        sends("Tell t3", "t3", news),
        own((call) => (sent(call, "t3") ? { text: "Told t3." } : undefined)),
        // The worker: a turn of two tool calls, then its end, which the peer's message
        // continues.
        own((call) =>
          works(call) && delivered(call, "t2") ? { text: "Noted the news." } : undefined,
        ),
        own(async (call) => {
          if (!works(call)) return undefined
          if (asked(call, brief)) {
            await working.opened
            return agents(call)
          }
          if (made(call) === 1) return agents(call)
          if (made(call) === 2) {
            await finishing.opened
            return { text: "Surveyed." }
          }
          return undefined
        }),
      )
      const requests = run.deck.answerRequests()
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      expect([t1.handle, t2.handle]).toEqual(["t1", "t2"])
      const calls = run.model.mark()

      await t1.submit("Start a worker")
      const t3 = await requests.next()
      expect(t3.handle).toBe("t3")
      // Its turn is running, its first reply held, when the lead and the peer send.
      await run.model.waitFor((call) => works(call) && asked(call, brief), {
        after: calls,
      })
      await t3.reached("working")
      const from = t3.mark()
      await t1.until("Started t3.")
      await t1.submit("Redirect t3")
      await t1.until("Told t3.")
      await t3.reached(holds("t1", "t3", "queued"), { after: from })
      await t2.submit("Tell t3")
      await t3.reached(holds("t2", "t3", "queued"), { after: from })

      working.open()

      // The request after its first tool call carries the lead's message, marked, and
      // not the peer's.
      const midway = await run.model.waitFor(
        (call) => works(call) && made(call) === 1 && text(call).includes(redirect),
        { after: calls },
      )
      expect(wrapper(midway, "t1")).toMatch(/ lead="[0-9A-Za-z]{8}"/)
      expect(text(midway)).toContain(leadNote)
      expect(text(midway)).not.toContain(news)
      expect(wrapper(midway, "t2")).toBeUndefined()
      await t3.reached(holds("t1", "t3", "delivered"), { after: from })
      // The turn goes on: the peer's message still waits.
      await run.model.waitFor((call) => works(call) && made(call) === 2, {
        after: calls,
      })
      expect(
        messages(t3)
          .filter((one) => one.from === "t2")
          .map((one) => one.state),
      ).toEqual(["queued"])
      finishing.open()

      // The peer's message arrives at the Stop, unmarked.
      const stop = await run.model.waitFor((call) => works(call) && delivered(call, "t2"), {
        after: calls,
      })
      expect(wrapper(stop, "t2")).not.toMatch(/ lead="[0-9A-Za-z]{8}"/)
      expect(text(stop)).toContain(news)
      await t3.until("Noted the news.")
      await through(t3, [holds("t2", "t3", "delivered"), "settled"], {
        after: from,
      })
    })
  })
}
