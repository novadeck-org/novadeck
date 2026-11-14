import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, tool } from "./model/script.js"
import { delivered, messages, own, result, sent, start, through } from "./scenarios.js"

// A handle that went to a new terminal (docs/agent-messaging.md, "Handles come back"): the
// agent that knew the old one is refused its first call to the handle, which names the new
// holder, and its second goes through. The same for every harness (see messaging.e2e.ts
// for the rule on parity). The project here has only `moth` and `fox` to give, and takes a
// closed terminal's handle back at once, as it does in an hour.

const brief = "hello again"

/** What a refusal of a handle that went to a new terminal asks the agent to do. */
const sameHandleAgain = "call again with the same handle"

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e.recycling(setup)

    it("is refused once to an agent that knew the old terminal, naming the new one, then goes through", async ({
      e2e: run,
    }) => {
      run.model.use(
        // The agent lists the terminals: the first fox is shown to it.
        own((call) => {
          const agents = tool(call, "agents")
          return agents && asked(call, "List the terminals")
            ? { calls: [{ name: agents, input: {} }] }
            : undefined
        }),
        own((call) =>
          /You are @moth\b/.test(result(call) ?? "") ? { text: "Listed them." } : undefined,
        ),
        own((call) => {
          const send = tool(call, "send")
          return send && asked(call, "Tell fox")
            ? { calls: [{ name: send, input: { to: "fox", text: brief } }] }
            : undefined
        }),
        // Refused, the agent calls again with the same handle, as the refusal says.
        own((call) => {
          const send = tool(call, "send")
          return send && result(call)?.includes(sameHandleAgain) === true
            ? { calls: [{ name: send, input: { to: "fox", text: brief } }] }
            : undefined
        }),
        own((call) => (sent(call, "fox") ? { text: "Told fox." } : undefined)),
        own((call) => (delivered(call, "moth") ? { text: "Heard you." } : undefined)),
      )
      const t1 = await start(run, setup)
      const old = await start(run, setup)
      expect(old.handle).toBe("fox")
      await t1.submit("List the terminals")
      await t1.until("Listed them.")
      await t1.reached("settled")

      // The first fox closes, and the next terminal made is given its handle.
      await run.deck.terminals.close({ terminalId: old.id })
      // Its record and its saved row are gone, and nothing holds the handle any more, a
      // moment later: the row goes after the record (it is when the handle starts to rest),
      // later for a harness whose shell takes longer to end.
      const gone = () => {
        try {
          run.deck.terminals.get(old.id)
          return false
        } catch {
          return !run.deck.store.terminals().some((row) => row.id === old.id)
        }
      }
      await expect.poll(gone, { timeout: 30_000 }).toBe(true)
      const fresh = await start(run, setup)
      expect(fresh.handle).toBe("fox")
      expect(fresh.id).not.toBe(old.id)
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.submit("Tell fox")

      // Its first call was refused, with the new holder and the closed one named.
      const refused = await run.model.waitFor(
        (call) => result(call)?.includes(sameHandleAgain) === true,
        { after: calls },
      )
      // Antigravity wraps the text in JSON, escaping its quotes.
      const told = result(refused)!.replaceAll('\\"', '"')
      expect(told).toContain("Nothing was done.")
      expect(told).toMatch(/@fox now is "[^"]+"/)
      expect(told).toMatch(/known as @fox \("[^"]+"\) closed/)
      // The second went through, to the new terminal.
      await t1.until("Told fox.")
      await t1.reached("settled", { after: mark })
      await fresh.until("Heard you.")
      await through(fresh, ["settled"])
      expect(messages(fresh).map(({ from, to, text }) => ({ from, to, text }))).toEqual([
        { from: "moth", to: "fox", text: brief },
      ])
    })
  })
}
