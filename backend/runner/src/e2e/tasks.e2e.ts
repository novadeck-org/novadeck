import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { latest } from "./model/script.js"
import {
  askedToClose,
  askedToLead,
  closed,
  closes,
  closingSelf,
  deliveries,
  delivered,
  holds,
  leads,
  opened,
  opens,
  own,
  result,
  released,
  releases,
  ring,
  start,
  through,
} from "./scenarios.js"

// An agent starting another with a task (docs/agent-messaging.md, "Starting a task"), or
// closing another's terminal (docs/agent-workspace.md), the same for every harness (see
// messaging.e2e.ts for the rule on parity).
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("starts an agent another asked for, with the message as its first task", async ({
      e2e: run,
    }) => {
      const requests = run.deck.answerRequests()
      run.model.use(
        opens("Start a helper", setup.agent, "Count the files in src."),
        own((call) => (opened(call, "fox") ? { text: "Started fox." } : undefined)),
        own((call) => (delivered(call, "moth") ? { text: "Counting now." } : undefined)),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.submit("Start a helper")

      const t2 = await requests.next()
      expect(t2.handle).toBe("fox")
      // Its first prompt is the doorbell's line, given on its command line, and its hook
      // adds the task beside it: the first thing its model is asked.
      const task = await run.model.waitFor((call) => delivered(call, "moth"), { after: calls })
      expect(latest(task)).toMatch(ring)
      expect(deliveries(task)).toEqual([{ from: "moth", text: "Count the files in src." }])
      expect(task.turns.filter((one) => one.role !== "user")).toEqual([])
      await t2.until("Counting now.")
      await through(t2, [holds("moth", "fox", "delivered"), "settled"])
      // It came with the start, never with a ring.
      expect(t2.history().map((one) => one.delivery)).not.toContain("ringing")
      expect(t2.summary().agent).toBe(setup.agent)
      await t1.until("Started fox.")
      await t1.reached("settled", { after: mark })
    })

    it("closes a terminal of an agent it leads at once", async ({ e2e: run }) => {
      const requests = run.deck.answerRequests()
      run.model.use(
        opens("Start a helper", setup.agent, "Count the files in src."),
        own((call) => (opened(call, "fox") ? { text: "Started fox." } : undefined)),
        own((call) => (delivered(call, "moth") ? { text: "Counting now." } : undefined)),
        closes("Close fox", "fox"),
        own((call) => (closed(call, "fox") ? { text: "Closed it." } : undefined)),
      )
      const t1 = await start(run, setup)
      await t1.submit("Start a helper")
      const t2 = await requests.next()
      await t1.until("Started fox.")
      await t1.reached("settled")
      // Its helper finishes its brief first: Claude Code on macOS keeps the Mac awake with
      // caffeinate while a turn runs, which a close mid-turn leaves behind.
      await t2.until("Counting now.")
      await t2.reached("settled")
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.submit("Close fox")

      const after = await run.model.waitFor((call) => closed(call, "fox"), { after: calls })
      expect(result(after)).toMatch(/Closed @fox(?: · [^,]+)?, which ran \S/)
      await t1.until("Closed it.")
      await t1.reached("settled", { after: mark })
      expect(() => run.deck.terminals.get(t2.id)).toThrow(
        expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
      )
    })

    it("closes another agent's terminal once the user confirms, and tells the agent that asked", async ({
      e2e: run,
    }) => {
      const asks = run.deck.answerApprovals(true)
      run.model.use(
        closes("Close fox", "fox"),
        own((call) => (askedToClose(call, "fox") ? { text: "Asked." } : undefined)),
        own((call) => (delivered(call, "novadeck") ? { text: "Closed it." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      expect(t2.handle).toBe("fox")
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.submit("Close fox")

      const after = await run.model.waitFor((call) => askedToClose(call, "fox"), { after: calls })
      expect(result(after)).toMatch(/Asked the user to confirm closing @fox/)
      await t1.until("Asked.")
      const ask = await asks.next()
      expect(ask).toMatchObject({ from: t1.id, terminalId: t2.id })
      // The person's yes comes back to the agent as a message from Novadeck.
      const told = await run.model.waitFor((call) => delivered(call, "novadeck"), { after: calls })
      // The one notice, which Claude Code's continuation quotes twice when the notice comes
      // while the turn runs: as the Stop hook's feedback and again as its blocking error.
      expect([...new Set(deliveries(told).map((one) => one.text))]).toEqual([
        expect.stringContaining("The user confirmed closing @fox"),
      ])
      await t1.until("Closed it.")
      await t1.reached("settled", { after: mark })
      expect(() => run.deck.terminals.get(t2.id)).toThrow(
        expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
      )
      expect(run.deck.store.terminal(t2.id)).toBeUndefined()
    })

    it("keeps another agent's terminal open when the user declines, and tells the agent", async ({
      e2e: run,
    }) => {
      const asks = run.deck.answerApprovals(false)
      run.model.use(
        closes("Close fox", "fox"),
        own((call) => (askedToClose(call, "fox") ? { text: "Asked." } : undefined)),
        own((call) => (delivered(call, "novadeck") ? { text: "Left it." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      const calls = run.model.mark()

      await t1.submit("Close fox")

      await asks.next()
      const told = await run.model.waitFor((call) => delivered(call, "novadeck"), { after: calls })
      // The one notice, which Claude Code's continuation quotes twice: as the Stop hook's
      // feedback and again as its blocking error (2.1.287). The deck answers at once, so it
      // comes while the turn still runs, to be carried by its Stop.
      expect([...new Set(deliveries(told).map((one) => one.text))]).toEqual([
        expect.stringContaining("The user kept @fox"),
      ])
      await t1.until("Left it.")
      expect(run.deck.terminals.get(t2.id).exit).toBeNull()
    })

    it("leads an agent already running once the user approves, sends its brief, and releases it", async ({
      e2e: run,
    }) => {
      const asks = run.deck.answerApprovals(true)
      run.model.use(
        leads("Lead fox", "fox", "Count the files in src."),
        own((call) => (askedToLead(call, "fox") ? { text: "Asked." } : undefined)),
        own((call) => (delivered(call, "novadeck") ? { text: "Leading fox." } : undefined)),
        releases("Release fox", "fox"),
        own((call) => (released(call, "fox") ? { text: "Released." } : undefined)),
        own((call) => (delivered(call, "moth") ? { text: "Counting now." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      expect(t2.handle).toBe("fox")
      const calls = run.model.mark()

      await t1.submit("Lead fox")

      const ask = await asks.next()
      expect(ask).toMatchObject({
        from: t1.id,
        terminalId: t2.id,
        action: { type: "lead", brief: "Count the files in src." },
      })
      // The brief reaches fox from moth, as from its lead.
      const brief = await run.model.waitFor((call) => delivered(call, "moth"), { after: calls })
      expect(deliveries(brief).map((one) => one.text)).toContain("Count the files in src.")
      await t1.until("Leading fox.")
      expect(run.deck.store.terminal(t2.id)?.ledBy).toBe("moth")

      await t1.submit("Release fox")

      await t1.until("Released.")
      expect(run.deck.store.terminal(t2.id)?.ledBy ?? null).toBeNull()
    })

    it("closes its own terminal when the agent asks, a moment after answering", async ({
      e2e: run,
    }) => {
      run.model.use(
        closes("Close yourself", "moth"),
        own((call) => (closingSelf(call, "moth") ? { text: "Bye." } : undefined)),
      )
      const t1 = await start(run, setup)
      expect(t1.handle).toBe("moth")

      await t1.submit("Close yourself")

      // Only its own close_terminal closes it. Its shell ends a moment after the answer,
      // which on Windows takes the agent's whole process tree a few seconds: as long as the
      // deck's other waits allow. Whether the agent passed the answer on to its model before
      // then is the harness's timing, so the answer's text is the integration tests' to check.
      await expect
        .poll(
          () => {
            try {
              run.deck.terminals.get(t1.id)
              return false
            } catch {
              return true
            }
          },
          { timeout: 30_000 },
        )
        .toBe(true)
      expect(run.deck.store.terminal(t1.id)).toBeUndefined()
    })
  })
}
