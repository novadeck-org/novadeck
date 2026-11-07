import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { AgentSetup } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, gated, supported, type E2E } from "./fixture.js"
import { asked, gate, latest } from "./model/script.js"
import { own, replies, start, through } from "./scenarios.js"

// The chat's Stop, `agents.interrupt`, never leaves the agent's TUI in a state the chat
// can't recover from: it presses Escape once, while a turn works or its queued messages go
// on, so no second Escape opens a rewind picker over an empty box (docs/backend-api.md).

// Waits until the message queued last is through what its harness runs before it can send
// it, where its screen says (Claude Code's UserPromptSubmit hooks, over a second each on
// Windows CI), and a second more.
const queuedUp = async (terminal: DeckTerminal, setup: AgentSetup, prompt: string) => {
  if (setup.queued) await terminal.until(setup.queued(prompt))
  await sleep(1000)
}

// A prompt hook as slow as Claude Code's on Windows (over a second each), whose log in the
// project says it ran.
const slowHook = "slow-hook.cjs"
const slowHookLog = "slow-hook.log"
const seedSlowHook = ({ sandbox }: E2E, ms = 1300) =>
  writeFileSync(
    join(sandbox.project, slowHook),
    `const { appendFileSync } = require("node:fs")
const { join } = require("node:path")
appendFileSync(join(__dirname, ${JSON.stringify(slowHookLog)}), "ran\\n")
setTimeout(() => console.log("{}"), ${ms})
`,
  )

// A hook after each tool, long enough to stay on the spinner through the Stop.
const slowToolHook = "slow-tool-hook.cjs"
const seedSlowToolHook = ({ sandbox }: E2E) =>
  writeFileSync(join(sandbox.project, slowToolHook), `setTimeout(() => console.log("{}"), 6000)\n`)

for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)
    const slow = e2e.seeded({ promptHook: slowHook }, setup)
    const slowTool = e2e.seeded({ promptHook: slowHook, toolHook: slowToolHook }, setup)

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
      await queuedUp(t1, setup, "Queued beta")
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

    // Two prompts queued behind a held turn, a Stop once `ready` says it may come: both come
    // back, or as a steer stop (Codex), and neither runs as a turn of its own.
    const twoQueued = async (
      run: E2E,
      ready: (terminal: DeckTerminal) => Promise<unknown>,
      {
        replyMidStop = false,
        inTool = false,
        stopped: onStopped,
      }: { replyMidStop?: boolean; inTool?: boolean; stopped?: () => void } = {},
    ) => {
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
          if (inTool && !call.turns.some((turn) => turn.role === "tool"))
            return { calls: [{ name: "Bash", input: { command: "sleep 2", description: "Wait" } }] }
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
      if (inTool) await t1.until("sleep 2")
      const beta = await t1.prompt("Queued beta")
      const gamma = await t1.prompt("Queued gamma")
      await ready(t1)
      const stopping = t1.interrupt()
      if (replyMidStop) {
        await sleep(100)
        held.open()
      }
      const stopped = await stopping
      held.open()
      queuedHeld.open()
      await sleep(2500)
      onStopped?.()

      expect(stopped.returned).toBe(setup.agent === "codex" ? null : "Queued beta\nQueued gamma")
      // Words given back are the person's draft again, and none went: Claude Code's record
      // holds them, written as the queued turn started, which the chat shows no more.
      if (stopped.returned !== null) {
        const { prompts = [] } = await t1.detail()
        const left = prompts.filter(({ ref }) => ref === beta.ref || ref === gamma.ref)
        expect(left.map(({ state }) => state)).toEqual(["withdrawn", "withdrawn"])
        const items = await t1.transcript()
        for (const { item } of left)
          if (item !== null)
            expect(items.find((each) => each.index === item)?.text).toContain("Queued")
      }
      const shown = await t1.screen()
      if (!replyMidStop) expect(shown).not.toContain("Too late.")
      expect(shown).not.toContain("Queued late.")

      const next = t1.mark()
      await t1.prompt("Carry on")
      await t1.until("Carried on.")
      await through(t1, ["working", "settled"], { after: next })
      // What the chat leaves out rests on this: a harness that starts to send them breaks it.
      if (stopped.returned !== null) {
        const last = run.model.calls.findLast((call) => !call.side)!
        expect(JSON.stringify(last.turns)).not.toContain("Queued")
      }
    }

    it("gives back both of two queued messages, or what was left of them", ({ e2e: run }) =>
      twoQueued(run, (terminal) => queuedUp(terminal, setup, "Queued gamma")))

    // The Stop lands with the hooks' screen up, where its harness has one: its words changed,
    // this fails rather than the hold going quietly. Elsewhere it lands as soon after.
    const midHook = (run: E2E) => async (terminal: DeckTerminal) => {
      expect(existsSync(join(run.sandbox.project, slowHookLog))).toBe(true)
      if (setup.queueing) await terminal.until(setup.queueing)
      else await sleep(300)
    }

    slow(
      "gives back both of two queued messages with their slow prompt hooks still running",
      ({ e2e: run }) => {
        seedSlowHook(run)
        return twoQueued(run, midHook(run))
      },
    )

    gated(slow, setup.queueing ? undefined : "it holds no Stop for queued messages")(
      "gives back both of two queued messages where the turn ends as the Stop waits on their hooks",
      ({ e2e: run }) => {
        seedSlowHook(run)
        return twoQueued(run, midHook(run), { replyMidStop: true })
      },
    )

    // The tool ends while the queued messages' hooks run, which outlast it, and its hook takes
    // over the spinner. A Stop that went at once would kill theirs, which run again: the own
    // prompt's hook and the two queued ones' are all the log may hold.
    gated(slowTool, setup.toolHooking ? undefined : "its spinner tells of no tool's hook")(
      "gives back both of two queued messages where a tool's hook has taken over their spinner",
      async ({ e2e: run }) => {
        seedSlowHook(run, 3500)
        seedSlowToolHook(run)
        let ran = ""
        const onSpinner = (terminal: DeckTerminal) => terminal.until(setup.toolHooking!)
        await twoQueued(run, onSpinner, {
          inTool: true,
          stopped: () => {
            ran = readFileSync(join(run.sandbox.project, slowHookLog), "utf8")
          },
        })
        expect(ran).toBe("ran\nran\nran\n")
      },
    )

    // Its words can't all be read, so they stay: nothing here may take them, not the Stop, not
    // the chat's own take of what the box holds. The next message goes along with them.
    for (const [what, message] of [
      ["a line", "Carry on"],
      ["a message that shows as a placeholder", `Carry on\n${"and on\n".repeat(40)}and on`],
      // Antigravity shows long paragraphs whole, taller than it has room for.
      [
        "a message taller than the box",
        `Carry on\n\n${`${"and on ".repeat(150)}\n\n`.repeat(3)}done`,
      ],
    ] as const)
      gated(it, setup.agent === "codex" ? "it steers what is queued into the turn" : undefined)(
        `leaves a queue taller than the box in it, for nothing to take, and ${what} takes it along`,
        async ({ e2e: run }) => {
          const held = gate()
          run.model.use(
            own((call) => (asked(call, "Carry on") ? { text: "Carried on." } : undefined)),
            own(async (call) => {
              if (!asked(call, "Hold on")) return undefined
              await held.opened
              return { text: "Too late." }
            }),
          )
          const t1 = await start(run, setup)
          const calls = run.model.mark()
          const mark = t1.mark()
          const lines = Array.from({ length: 30 }, (_, i) => `queued line ${i + 1}`)
          await t1.prompt("Hold on")
          await run.model.waitFor((call) => !call.side && latest(call).includes("Hold on"), {
            after: calls,
          })
          await t1.reached("working", { after: mark })
          await t1.prompt(lines.join("\n"))
          await t1.until(/Press up to edit queued messages/)
          await sleep(1500)
          await expect(t1.interrupt()).rejects.toMatchObject({ code: "BOX_NOT_CLEARED" })
          held.open()
          await sleep(1000)
          expect((await run.deck.terminals.takeBox(t1.id)).returned).toBeNull()
          expect(await t1.screen()).toContain("queued line 30")

          const next = run.model.mark()
          await t1.prompt(message)
          const carried = await run.model.waitFor(
            (call) => !call.side && latest(call).includes("queued line 30"),
            { after: next },
          )
          for (const line of [lines[0]!, lines[9]!, lines[29]!]) {
            expect(latest(carried)).toContain(line)
          }
          expect(latest(carried)).toContain("Carry on")
        },
      )

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
      // interruption says they took it, as Claude Code's does from 2.1.304; to 2.1.287 its
      // account is the prompt gone from the screen, which the runner clears from its box
      // before `interrupt` resolves.
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
