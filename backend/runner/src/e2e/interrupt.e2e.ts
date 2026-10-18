import { setTimeout as sleep } from "node:timers/promises"

import { setups } from "./agents/index.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, gate, latest } from "./model/script.js"
import { own, replies, start, through } from "./scenarios.js"

// The chat's Stop, `agents.interrupt`, never leaves the agent's TUI in a state the chat
// can't recover from: it presses Escape once, only while a turn works, so no second Escape
// opens a rewind picker over an empty box (docs/backend-api.md).

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("presses one Escape for a double Stop, leaving an empty prompt with no picker, and takes the next prompt", async ({
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
      await Promise.all([t1.interrupt(), t1.interrupt()])
      await t1.reached("unknown", { after: mark })
      held.open()
      // Past the time a second Escape of Esc-Esc's would have taken to open the picker.
      await sleep(2500)
      const shown = await t1.screen()
      if (setup.rewind) expect(shown).not.toMatch(setup.rewind.shows)
      expect(shown).not.toContain("Too late.")

      // Nothing is left in the box: the next prompt goes alone, as a normal turn.
      const next = t1.mark()
      await t1.prompt("Carry on")
      await t1.until("Carried on.")
      await through(t1, ["working", "settled"], { after: next })
      expect(await t1.screen()).not.toMatch(setup.rewind?.shows ?? /(?!)/)
    })

    it("stops a turn that has a message queued behind it, and gives the queued words back out of the box", async ({
      e2e: run,
    }) => {
      const held = gate()
      const queuedHeld = gate()
      run.model.use(
        replies("Carry on", "Carried on."),
        own(async (call) => {
          // The queued message may start a turn of its own (Claude Code, Codex): held too.
          if (asked(call, "Queued beta")) {
            await queuedHeld.opened
            return { text: "Queued late." }
          }
          if (!asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Too late." }
        }),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.prompt("Hold on")
      await run.model.waitFor((call) => !call.side && latest(call).includes("Hold on"), {
        after: calls,
      })
      await t1.reached("working", { after: mark })
      await t1.prompt("Queued beta")
      await sleep(1000)
      const stopped = await t1.interrupt()
      held.open()
      queuedHeld.open()
      await sleep(2500)

      // Antigravity and Claude Code hand the queued words back; Codex sent them as a
      // steer, which the second Escape stopped.
      expect(stopped.returned).toBe(setup.agent === "codex" ? null : "Queued beta")
      const shown = await t1.screen()
      if (setup.rewind) expect(shown).not.toMatch(setup.rewind.shows)
      expect(shown).not.toContain("Too late.")
      expect(shown).not.toContain("Queued late.")
      expect(t1.summary().activity?.state).not.toBe("working")

      // The box is empty: the next prompt goes alone, as a normal turn.
      const next = t1.mark()
      await t1.prompt("Carry on")
      await t1.until("Carried on.")
      await through(t1, ["working", "settled"], { after: next })
    })

    it("gives back both of two queued messages, or what was left of them", async ({ e2e: run }) => {
      const held = gate()
      const queuedHeld = gate()
      run.model.use(
        replies("Carry on", "Carried on."),
        own(async (call) => {
          if (asked(call, "Queued")) {
            await queuedHeld.opened
            return { text: "Queued late." }
          }
          if (!asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Too late." }
        }),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()

      await t1.prompt("Hold on")
      await run.model.waitFor((call) => !call.side && latest(call).includes("Hold on"), {
        after: calls,
      })
      await t1.reached("working", { after: mark })
      await t1.prompt("Queued beta")
      await t1.prompt("Queued gamma")
      await sleep(1000)
      const stopped = await t1.interrupt()
      held.open()
      queuedHeld.open()
      await sleep(2500)

      expect(stopped.returned).toBe(setup.agent === "codex" ? null : "Queued beta\nQueued gamma")
      const shown = await t1.screen()
      expect(shown).not.toContain("Too late.")
      expect(shown).not.toContain("Queued late.")

      const next = t1.mark()
      await t1.prompt("Carry on")
      await t1.until("Carried on.")
      await through(t1, ["working", "settled"], { after: next })
    })

    it("clears a long prompt put back in the box, though it shows only its tail, and gives nothing back", async ({
      e2e: run,
    }) => {
      const held = gate()
      run.model.use(
        replies("Carry on", "Carried on."),
        own(async (call) => {
          if (!asked(call, "Hold on")) return undefined
          await held.opened
          return { text: "Too late." }
        }),
      )
      const t1 = await start(run, setup)
      const calls = run.model.mark()
      const mark = t1.mark()
      const long = ["Hold on", ...Array.from({ length: 24 }, (_, i) => `line ${i + 2} of it`)]

      await t1.prompt(long.join("\n"))
      await run.model.waitFor((call) => !call.side && latest(call).includes("Hold on"), {
        after: calls,
      })
      await t1.reached("working", { after: mark })
      const stopped = await t1.interrupt()
      // Let go only once the agent has taken the Escape: Antigravity and Codex take the key a
      // moment after it is written, and a reply let go before then still draws, its turn
      // finished (probes/interrupt-held-reply.e2e.ts). Their own account of the
      // interruption says they took it; Claude Code's is the prompt gone from the screen,
      // which the runner clears from its box before `interrupt` resolves.
      const account = setup.interrupted("Hold on")
      await t1.poll(
        async () => {
          const shown = await t1.screen()
          // Only Claude Code's account is the prompt gone: elsewhere a tall prompt's first
          // line may scroll off before the key is taken.
          const gone = setup.agent === "claude" && !shown.includes("Hold on")
          return account.test(shown) || gone ? true : undefined
        },
        "the harness to take the interrupt",
        30_000,
      )
      held.open()
      await sleep(1500)

      // The prompt is the chat's already: none of it goes back to the draft.
      expect(stopped.returned).toBeNull()
      expect(await t1.screen()).not.toContain("Too late.")

      // The box is empty: the next prompt goes alone, as a normal turn.
      const next = t1.mark()
      await t1.prompt("Carry on")
      await t1.until("Carried on.")
      await through(t1, ["working", "settled"], { after: next })
    })

    it("sends nothing for a Stop while idle, however often, so no picker opens", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Carry on", "Carried on."))
      const t1 = await start(run, setup)

      await Promise.all([t1.interrupt(), t1.interrupt(), t1.interrupt()])
      await t1.interrupt()
      await sleep(1500)
      if (setup.rewind) expect(await t1.screen()).not.toMatch(setup.rewind.shows)

      const mark = t1.mark()
      await t1.prompt("Carry on")
      await t1.until("Carried on.")
      await through(t1, ["working", "settled"], { after: mark })
    })
  })
}
