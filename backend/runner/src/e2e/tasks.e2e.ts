import { readFileSync, writeFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

import { onTestFinished } from "vitest"

import { harnesses } from "../harnesses/registry.js"
import { logs, useLogger } from "../log.js"
import { tracer } from "../messaging/doorbell.js"
import { setups } from "./agents/index.js"
import { describe, e2e, expect, gated, supported } from "./fixture.js"
import { latest, tool, type Call } from "./model/script.js"
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
// Whether the call's latest user turn delivered a Novadeck notice holding `part`.
const notified = (call: Call, part: string): boolean =>
  deliveries(call).some((one) => one.from === "novadeck" && one.text.includes(part))

/**
 * Makes Novadeck's MCP server start `seconds` late in every agent started from now on: its
 * launcher sleeps first, as a loaded machine's start can take. Windows starts the relay
 * itself, with no launcher.
 */
const slowMcp = (launcher: string, seconds: number): void => {
  const script = readFileSync(launcher, "utf8")
  if (!/^exec /m.test(script)) throw new Error(`No exec line in the MCP launcher:\n${script}`)
  writeFileSync(launcher, script.replace(/^exec /m, `sleep ${seconds}\nexec `))
}

// The notice Novadeck puts in a terminal's first prompt, which names that terminal's
// conversation: no other terminal's holds the same one.
const notice = (call: Call): string | undefined =>
  /\[Novadeck: [^\]]*\]/.exec(call.turns.find((turn) => turn.role === "user")?.text ?? "")?.[0]

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
      // Its first prompt is the doorbell's line, given on its command line (or rung, for a
      // harness whose first turn could miss Novadeck's tools), and its hook adds the task
      // beside it: the first thing its model is asked.
      const task = await run.model.waitFor((call) => delivered(call, "moth"), { after: calls })
      expect(latest(task)).toMatch(ring)
      expect(deliveries(task)).toEqual([{ from: "moth", text: "Count the files in src." }])
      expect(task.turns.filter((one) => one.role !== "user")).toEqual([])
      await t2.until("Counting now.")
      await through(t2, [holds("moth", "fox", "delivered"), "settled"])
      // It came with the start, never with a ring, but where its harness takes its MCP
      // tools only as a turn starts: there the doorbell rings it once they are listed.
      expect(
        t2
          .history()
          .map((one) => one.delivery)
          .includes("ringing"),
      ).toBe(harnesses[setup.agent].messaging.toolsAtTurnStart)
      expect(t2.summary().agent).toBe(setup.agent)
      await t1.until("Started fox.")
      await t1.reached("settled", { after: mark })
    })

    gated(
      it,
      process.platform === "win32"
        ? "Windows starts the relay as the MCP server, with no launcher to slow"
        : undefined,
    )(
      "gives an agent started with a task Novadeck's tools in the task's turn, though its MCP server starts late",
      async ({ e2e: run }) => {
        const atTurnStart = harnesses[setup.agent].messaging.toolsAtTurnStart
        const brief = "List the agents."
        // The doorbell's word that it waits for an agent's tools, by terminal, and the
        // runner's that a wait ran out, which only a wait that never heard of them makes.
        const waited = new Set<string>()
        const sink = tracer.sink
        tracer.sink = (terminalId, line, screen) => {
          if (line.includes("for its MCP tools")) waited.add(terminalId)
          sink?.(terminalId, line, screen)
        }
        onTestFinished(() => {
          if (sink) tracer.sink = sink
        })
        const late: unknown[] = []
        const before = logs.current()
        useLogger({
          ...before,
          for: (name) => {
            const inner = before.for(name)
            return {
              ...inner,
              warn: (evt, message, detail) => {
                if (evt === "doorbell.tools-late") late.push(detail)
                inner.warn(evt, message, detail)
              },
            }
          },
        })
        onTestFinished(() => useLogger(before))
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
        // The calls of the worker's turn that went without Novadeck's tools.
        let without = 0
        const requests = run.deck.answerRequests()
        run.model.use(
          opens("Start a lister", setup.agent, brief),
          own((call) => (opened(call, "fox") ? { text: "Started fox." } : undefined)),
          own(async (call) => {
            if (!works(call)) return undefined
            if (/You are @fox\b/.test(result(call) ?? "")) return { text: "Listed the agents." }
            // Only the tools its own request offers: the harness refuses any other.
            const agents = tool(call, "agents")
            if (agents) return { calls: [{ name: agents, input: {} }] }
            without += 1
            // A harness that adds a server's tools to a running turn is given time, a
            // harmless command at a time; one that takes them as a turn starts gets none.
            if (atTurnStart || without > 10 || !setup.shell)
              return { text: "No Novadeck tools in this turn." }
            await sleep(500)
            return setup.shell.run(call, "ls")
          }),
        )
        const t1 = await start(run, setup)
        // The lead's own server started in time; the worker's starts late, as a loaded macOS
        // runner's took over 1 s, past Antigravity's first request: for a harness whose ring
        // waits for its tools, past the doorbell's settle after its prompt shows too, so the
        // ring goes only once its server has listed them.
        slowMcp(run.deck.shell.mcp, atTurnStart ? 9 : 2)
        await t1.submit("Start a lister")
        const t2 = await requests.next()
        expect(t2.handle).toBe("fox")
        const shown = await t2.until(/Listed the agents\.|No Novadeck tools in this turn\./, 60_000)
        expect(shown).toContain("Listed the agents.")
        await through(t2, [holds("moth", "fox", "delivered"), "settled"])
        // Its ring waited for the listing, which reached the doorbell: no wait ran out.
        expect(waited.has(t2.id)).toBe(atTurnStart)
        expect(late).toEqual([])
      },
    )

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

    it("closes another agent's terminal once the person confirms, and tells the agent that asked", async ({
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
      // The one notice, read once (#589), though it may come while the turn runs, carried by
      // its Stop.
      expect(deliveries(told).map((one) => one.text)).toEqual([
        expect.stringContaining("The user confirmed closing @fox"),
      ])
      await t1.until("Closed it.")
      await t1.reached("settled", { after: mark })
      expect(() => run.deck.terminals.get(t2.id)).toThrow(
        expect.objectContaining({ code: "TERMINAL_NOT_FOUND" }),
      )
      expect(run.deck.store.terminal(t2.id)).toBeUndefined()
    })

    it("keeps another agent's terminal open when the person declines, and tells the agent", async ({
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
      // The one notice, read once (#589). The deck answers at once, so it comes while the
      // turn still runs, to be carried by its Stop.
      expect(deliveries(told).map((one) => one.text)).toEqual([
        expect.stringContaining("The user kept @fox"),
      ])
      await t1.until("Left it.")
      expect(run.deck.terminals.get(t2.id).exit).toBeNull()
    })

    it("leads an agent already running once the person approves, sends its brief, and releases it", async ({
      e2e: run,
    }) => {
      const asks = run.deck.answerApprovals(true)
      run.model.use(
        leads("Lead fox", "fox", "Count the files in src."),
        own((call) => (askedToLead(call, "fox") ? { text: "Asked." } : undefined)),
        // Fox's first delivery carries the brief, and the notice that moth leads it with it.
        own((call) => (delivered(call, "moth") ? { text: "Counting now." } : undefined)),
        // Moth is told its lead formed; fox may also get the notice on its own.
        own((call) => (notified(call, "you now lead @fox") ? { text: "Leading fox." } : undefined)),
        own((call) => (notified(call, "lead you from now on") ? { text: "Noted." } : undefined)),
        releases("Release fox", "fox"),
        own((call) => (released(call, "fox") ? { text: "Released." } : undefined)),
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
      // Marked as its lead's, in this delivery's own mark.
      const wrapped = latest(brief)
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
      expect(wrapped).toMatch(/<message\b[^>]*from="moth"[^>]* lead="[0-9A-Za-z]{8}"/)
      // And fox was told the person let moth lead it, in this delivery or the one before.
      await run.model.waitFor((call) => !call.side && notified(call, "lead you from now on"), {
        after: calls,
      })
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
