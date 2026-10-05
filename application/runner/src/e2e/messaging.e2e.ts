import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  type Dirent,
} from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { Harness } from "../harnesses/harness.js"
import { harnesses } from "../harnesses/registry.js"
import { setups } from "./agents/index.js"
import { describe, e2e, expect, gated, supported } from "./fixture.js"
import { asked, gate, latest, tool } from "./model/script.js"
import {
  deliveries,
  delivered,
  holds,
  lacking,
  messages,
  own,
  result,
  replies,
  ring,
  sends,
  sent,
  start,
  through,
  turn,
} from "./scenarios.js"

// The JSON files under `folder`, passing over a folder a harness removes meanwhile, as
// Codex does its own temporary ones.
const jsonFiles = (folder: string): string[] => {
  let entries: Dirent[]
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) return jsonFiles(path)
    return entry.isFile() && entry.name.endsWith(".json") ? [path] : []
  })
}

// Rewrites every JSON file under `root` that names the MCP launcher `from` to name `to`,
// as a plugin installed by another build would, and returns the files it rewrote.
const renamePlugins = (root: string, from: string, to: string): string[] => {
  const [named, renamed] = [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)]
  return jsonFiles(root).filter((path) => {
    const text = existsSync(path) ? readFileSync(path, "utf8") : ""
    if (!text.includes(named)) return false
    writeFileSync(path, text.replaceAll(named, renamed))
    return true
  })
}

// How long a terminal is watched for what a stale record, read late, would change.
const quiet = 3000

// The same scenarios for every harness. Where one differs, it is a trait of its setup or
// a known gap (known-gaps.ts), never a check of which harness this is.
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)

    it("starts straight at its prompt, which NovaDeck sees as Ready", async ({ e2e: run }) => {
      // Ready is NovaDeck's word that the agent's own empty prompt shows, past any trust,
      // onboarding, sign-in, key, update or hooks screen, each harness telling it its own
      // way (docs/agent-messaging.md, "States").
      const t1 = await start(run, setup)

      // Only the screen shows that it is the harness's own first screen.
      await t1.until(setup.banner)
      // Nothing waits on the person, and a harness that starts its session as it starts
      // has bound it at Ready; the others bind at their first prompt.
      const detail = await t1.detail()
      expect(detail.requests).toEqual([])
      expect(detail.sessionId !== null).toBe(setup.bindsAtReady)
      expect(t1.summary().agent).toBe(setup.bindsAtReady ? setup.agent : null)
      // Its terminal shows it idle at that prompt, NovaDeck hearing from it, either way.
      if (!setup.bindsAtReady)
        await t1.poll(
          () => (t1.summary().ready === setup.agent ? true : undefined),
          "the agent named ready",
        )
      else expect(t1.summary().ready).toBeNull()
    })

    it("takes a prompt to the model and shows its reply, then ends its turn", async ({
      e2e: run,
    }) => {
      run.model.use(replies("Say the word", "Pelican-7 says hello."))
      const t1 = await start(run, setup)

      await turn(t1, "Say the word", "Pelican-7 says hello.")

      const call = await run.model.waitFor(
        (one) => !one.side && latest(one).includes("Say the word"),
      )
      expect(call.api).toBe(setup.dialect.api)
      expect(tool(call, "send")).toBeDefined()
      // By its first prompt, every harness has bound its session.
      expect(t1.summary().agent).toBe(setup.agent)
    })

    it("reaches its own NovaDeck's MCP server when another build connected it last", async ({
      e2e: run,
    }) => {
      // Another NovaDeck, as a development build beside the installed app, connecting the
      // agent after this one: every plugin copy names that build's launcher instead.
      const other = join(run.sandbox.root, "other build", "shell")
      const marker = join(run.sandbox.root, "other build", "started")
      mkdirSync(other, { recursive: true })
      const decoy = join(other, "mcp")
      writeFileSync(decoy, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 })
      // The copy the harness installed, not only NovaDeck's own source of it.
      const rewritten = renamePlugins(run.sandbox.root, run.deck.shell.mcp, decoy)
      expect(rewritten.some((path) => path.startsWith(run.sandbox.home))).toBe(true)
      run.model.use(replies("Say the word", "Pelican-7 says hello."))
      const t1 = await start(run, setup)

      await turn(t1, "Say the word", "Pelican-7 says hello.")

      // The terminal's NOVADECK_MCP started this NovaDeck's server, which offers its tools.
      const call = await run.model.waitFor(
        (one) => !one.side && latest(one).includes("Say the word"),
      )
      expect(tool(call, "send")).toBeDefined()
      expect(existsSync(marker)).toBe(false)
    })

    it("rings an idle agent for a message, and its answer reaches the sender", async ({
      e2e: run,
    }) => {
      // The answer's path is fixed: t2's answer waits until t1's turn has ended, so the
      // doorbell brings it rather than t1's Stop.
      const answering = gate()
      run.model.use(
        sends("Ask t2 for its colour", "t2", "What is your colour?"),
        own((call) => (sent(call, "t2") ? { text: "Asked." } : undefined)),
        own(async (call) => {
          if (!delivered(call, "t1")) return undefined
          const reply = await sends("What is your colour?", "t1", "Mine is teal.")(call)
          if (reply) await answering.opened
          return reply
        }),
        own((call) => (delivered(call, "t2") ? { text: "t2 says teal." } : undefined)),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      const calls = run.model.mark()
      const [from1, from2] = [t1.mark(), t2.mark()]

      await t1.submit("Ask t2 for its colour")

      // t2, Ready at its first screen, is rung: its prompt is the doorbell's line, and its
      // hook adds the message from t1 beside it.
      const rung = await run.model.waitFor((call) => delivered(call, "t1"), { after: calls })
      expect(latest(rung)).toMatch(ring)
      expect(deliveries(rung)).toEqual([{ from: "t1", text: "What is your colour?" }])
      await through(
        t2,
        [holds("t1", "t2", "queued"), "ringing", "working", holds("t1", "t2", "delivered")],
        { after: from2 },
      )
      // t1's turn ends; then t2 answers, and the doorbell rings t1.
      const done = await t1.reached("settled", { after: from1 })
      answering.open()
      await through(t1, ["ringing", "working"], { after: done.index })
      const answer = await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
      expect(deliveries(answer)).toEqual([{ from: "t2", text: "Mine is teal." }])
      await t1.until("t2 says teal.")
      await through(t1, [holds("t2", "t1", "delivered"), "settled"], { after: from1 })

      expect(messages(t1).map((one) => [one.from, one.to, one.state])).toEqual([
        ["t1", "t2", "delivered"],
        ["t2", "t1", "delivered"],
      ])
      expect(messages(t2)).toEqual(messages(t1))
    })

    gated(it, lacking(setup, "approval"))(
      "works on through a Stop it continues with a message, waiting on the person as it asks",
      async ({ e2e: run }) => {
        // t1's turn ends only once t2's message waits for it; its Stop then delivers it,
        // and the continuation asks the person before a tool runs.
        const ending = gate()
        run.model.use(
          sends("Tell t1 the news", "t1", "The build is green."),
          own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
          own((call) => {
            if (!delivered(call, "t2")) return undefined
            if (result(call) !== undefined) return { text: "Noted the news." }
            return setup.approval!.request(call)
          }),
          own(async (call) => {
            if (call.side || !asked(call, "Hold then stop")) return undefined
            await ending.opened
            return { text: "First done." }
          }),
        )
        const t1 = await start(run, setup)
        const t2 = await start(run, setup)
        const mark = t1.mark()
        await t1.submit("Hold then stop")
        await t1.reached("working", { after: mark })
        await t2.submit("Tell t1 the news")
        await t1.reached(holds("t2", "t1", "queued"), { after: mark })
        ending.open()

        // Its Stop continued the turn: it works on, and waits on the person as it asks,
        // past any record of that Stop, as Claude Code's transcript writes one.
        await t1.until(setup.approval!.shows)
        await t1.poll(
          () => (t1.summary().activity?.attention.pending === 1 ? true : undefined),
          "the continuation's request",
        )
        await sleep(quiet)
        expect(t1.summary().activity).toMatchObject({
          state: "working",
          attention: { pending: 1 },
        })
        expect(t1.history().at(-1)?.delivery).toBe("working")
      },
    )

    it("works on through a Stop it continues with a message, until the continuation's Stop", async ({
      e2e: run,
    }) => {
      const ending = gate()
      const continuing = gate()
      run.model.use(
        sends("Tell t1 the news", "t1", "The build is green."),
        own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
        own(async (call) => {
          if (!delivered(call, "t2")) return undefined
          await continuing.opened
          return { text: "Noted the news." }
        }),
        own(async (call) => {
          if (call.side || !asked(call, "Hold then stop")) return undefined
          await ending.opened
          return { text: "First done." }
        }),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      const mark = t1.mark()
      const calls = run.model.mark()
      await t1.submit("Hold then stop")
      await t1.reached("working", { after: mark })
      await t2.submit("Tell t1 the news")
      await t1.reached(holds("t2", "t1", "queued"), { after: mark })
      ending.open()

      // The continuation's model call waits: the agent works, as delivery says, and as its
      // terminal shows, whatever records its Stop left.
      await run.model.waitFor((call) => delivered(call, "t2"), { after: calls })
      await sleep(quiet)
      expect(t1.summary().activity?.state).toBe("working")
      expect(t1.history().at(-1)?.delivery).toBe("working")
      continuing.open()
      await t1.until("Noted the news.")
      await t1.reached("settled", { after: mark })
      await t1.poll(
        () => (t1.summary().activity?.state === "idle" ? true : undefined),
        "the agent idle",
      )
    })

    it("ends a continuation whose own Stop hook's report never came, as its records tell", async ({
      e2e: run,
    }) => {
      // As when NovaDeck's hook failed to run for the continuation's Stop: its records, or
      // Antigravity's idle status line, end the turn all the same.
      const ending = gate()
      run.model.use(
        sends("Tell t1 the news", "t1", "The build is green."),
        own((call) => (sent(call, "t1") ? { text: "Told t1." } : undefined)),
        own((call) => (delivered(call, "t2") ? { text: "Noted the news." } : undefined)),
        own(async (call) => {
          if (call.side || !asked(call, "Hold then stop")) return undefined
          await ending.opened
          return { text: "First done." }
        }),
      )
      const t1 = await start(run, setup)
      const t2 = await start(run, setup)
      const harness = harnesses[setup.agent] as { decode: Harness["decode"] }
      const { decode } = harness
      // t1's second Stop, its continuation's, never reports.
      let stops = 0
      harness.decode = (report) => {
        if (report.event !== "Stop" || report.terminalId !== t1.id) return decode(report)
        stops += 1
        return stops === 2 ? [] : decode(report)
      }
      try {
        const mark = t1.mark()
        await t1.submit("Hold then stop")
        await t1.reached("working", { after: mark })
        await t2.submit("Tell t1 the news")
        await t1.reached(holds("t2", "t1", "queued"), { after: mark })
        ending.open()
        await t1.until("Noted the news.")
        await t1.poll(
          () => (t1.summary().activity?.state === "idle" ? true : undefined),
          "the continuation to end",
        )
        await t1.poll(
          () => (t1.history().at(-1)?.delivery !== "working" ? true : undefined),
          "delivery to take the continuation as over",
        )
        expect(stops).toBe(2)
      } finally {
        harness.decode = decode
      }
    })

    gated(it, lacking(setup, "idleCommand"))(
      "keeps telling its agent at its prompt after a command there that submits nothing",
      async ({ e2e: run }) => {
        const t1 = await start(run, setup)
        const heard = () => t1.summary().ready === setup.agent || t1.summary().agent === setup.agent
        await t1.poll(() => (heard() ? true : undefined), "the agent at its prompt")
        await t1.submit(setup.idleCommand!)
        // Its prompt still shows: NovaDeck hears it there again within moments.
        await t1.poll(() => (heard() ? true : undefined), "the agent at its prompt again", 10_000)
        expect(t1.summary().activity?.state ?? "idle").toBe("idle")
      },
    )

    it("reaches no model or login but the fake one", async ({ e2e: run }) => {
      run.model.use(own(() => ({ text: "Nothing left the machine." })))
      const t1 = await start(run, setup)

      await turn(t1, "Is this hermetic", "Nothing left the machine.")

      expect(run.model.foreign).toBe(0)
      expect(run.model.errors).toEqual([])
      // Every request to the fake model was one a dialect answered. The only others are
      // tunnels the proxy refused, to hosts the harness is known to try with no setting
      // that turns them off.
      const unexpected = run.model.strays.filter((stray) => {
        const [method, host = ""] = stray.split(" ")
        return method !== "CONNECT" || !setup.refused.includes(host)
      })
      expect(unexpected).toEqual([])
    })
  })
}
