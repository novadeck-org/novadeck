// PROBE, not a test of Novadeck: what Codex reports when a spawned subagent ends without
// finishing its turn: the root closing it (close_agent) mid-turn, then resuming it and
// sending it input; the person's Esc on the root while it runs; its turn aborted by Esc on
// its request, then used again; and what /agent offers the person while one runs. For each step, every hook report, the subagents' rollouts' last
// records, the screen and Novadeck's activity summary.
// Runs only with NOVADECK_E2E_PROBES=1, by path; writes $PROBE_OUT/subagent-ends-codex.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { codex } from "../agents/codex.js"
import { describe, e2e, expect, supported } from "../fixture.js"
import { asked, gate, type Call } from "../model/script.js"
import { own, result, start } from "../scenarios.js"
import { listen } from "./subagent-ends-support.js"
import { probing, sleep } from "./support.js"

const tasks = {
  a: "Helper task A: wait",
  b: "Helper task B: wait",
  c: "Helper task C: ask",
  d: "Helper task D: wait",
} as const

// The subagent whose conversation holds `task`.
const of = (call: Call, task: string) =>
  !call.side && call.turns.some((turn) => turn.role === "user" && turn.text.includes(task))

const spawnTool = (call: Call) => call.tools.find((name) => name.endsWith("spawn_agent"))
const named = (call: Call, end: string) => call.tools.find((name) => name.endsWith(end))

describe.skipIf(!supported || !probing)("probe: a Codex subagent that ends unfinished", () => {
  const it = e2e(codex)
  it("records what each end reports", async ({ e2e: run }) => {
    const ears = listen()
    const holdA = gate()
    const holdB = gate()
    const holdRoot = gate()
    const holdD = gate()
    const ids: Record<string, string> = {}
    const out: Record<string, unknown> = { harness: "codex" }
    let cAsked = 0
    run.model.use(
      own(async (call) => {
        if (!of(call, tasks.a)) return undefined
        if (call.turns.some((turn) => turn.role === "user" && turn.text.includes("Again A")))
          return { text: "A again done." }
        await holdA.opened
        return { text: "A done." }
      }),
      own(async (call) => {
        if (!of(call, tasks.b)) return undefined
        await holdB.opened
        return { text: "B done." }
      }),
      own(async (call) => {
        if (!of(call, tasks.d)) return undefined
        await holdD.opened
        return { text: "D done." }
      }),
      own((call) => {
        if (!of(call, tasks.c)) return undefined
        if (call.turns.some((turn) => turn.role === "user" && turn.text.includes("Again C")))
          return { text: "C again done." }
        cAsked += 1
        return codex.approval!.request(call)
      }),
      // The root: spawns, closes, resumes and messages, each by its tool.
      own((call) => {
        for (const [word, task] of [
          ["Spawn A", tasks.a],
          ["Spawn C", tasks.c],
          ["Spawn D", tasks.d],
        ] as const)
          if (asked(call, word))
            return { calls: [{ name: spawnTool(call)!, input: { message: task } }] }
        if (asked(call, "Spawn B and wait")) {
          out.rawTools = call.rawTools?.filter((one) =>
            /close_agent|resume_agent|send_input|spawn_agent/.test(
              JSON.stringify(one).slice(0, 300),
            ),
          )
          return { calls: [{ name: spawnTool(call)!, input: { message: tasks.b } }] }
        }
        if (asked(call, "Close A"))
          return { calls: [{ name: named(call, "close_agent")!, input: { target: ids.a } }] }
        if (asked(call, "Resume A"))
          return { calls: [{ name: named(call, "resume_agent")!, input: { id: ids.a } }] }
        if (asked(call, "Message A"))
          return {
            calls: [
              { name: named(call, "send_input")!, input: { target: ids.a, message: "Again A" } },
            ],
          }
        if (asked(call, "Message C"))
          return {
            calls: [
              { name: named(call, "send_input")!, input: { target: ids.c, message: "Again C" } },
            ],
          }
        return undefined
      }),
      own(async (call) => {
        const answer = result(call)
        if (answer === undefined) return undefined
        // The root's look at B's spawn is held: its turn runs on, B with it.
        const last = call.turns.findLast((turn) => turn.role === "user")
        if (last?.role === "user" && last.text.includes("Spawn B and wait")) {
          await holdRoot.opened
          return { text: "Root went on." }
        }
        return { text: `Result: ${answer.slice(0, 200)}` }
      }),
      own(() => ({ text: "OK." })),
    )
    const t = await start(run, codex)
    let at = 0
    const rollouts = () => {
      const sessions = join(run.sandbox.home, ".codex", "sessions")
      if (!existsSync(sessions)) return {}
      const files = readdirSync(sessions, { recursive: true, encoding: "utf8" }).filter((one) =>
        one.endsWith(".jsonl"),
      )
      return Object.fromEntries(
        files.map((file) => [
          file.replace(/^.*rollout-[^-]+-[^-]+-[^-]+-[^-]+-[^-]+-[^-]+-/, ""),
          readFileSync(join(sessions, file), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { type?: string; payload?: { type?: string } })
            .filter(({ type }) => type === "event_msg")
            .map(({ payload }) => payload?.type)
            .slice(-12),
        ]),
      )
    }
    const step = async (label: string) => {
      await sleep(3000)
      out[label] = {
        hooks: ears.heard.slice(at).filter(({ event }) => event !== "StatusLine"),
        activity: t.summary().activity,
        screen: screenRecord(await t.screen()),
        rollouts: rollouts(),
      }
      at = ears.heard.length
    }
    const spawned = (task: string) =>
      t.poll(() => {
        const begun = ears.heard.find(
          ({ event, payload }) =>
            event === "SubagentStart" &&
            typeof payload.agent_id === "string" &&
            !Object.values(ids).includes(payload.agent_id),
        )
        return begun?.payload.agent_id as string | undefined
      }, `the SubagentStart of ${task}`)
    try {
      await t.submit("Spawn A")
      ids.a = await spawned("A")
      await t.until(/Result:/)
      await step("1 A spawned, held")

      await t.submit("Close A")
      await step("2 A closed by close_agent")
      // What Novadeck reads as the close (decode.ts `closed`): close_agent's PostToolUse names
      // the spawned agent's own id as its target, and no SubagentStop comes for it.
      const closing = ears.heard.find(
        ({ event, payload }) =>
          event === "PostToolUse" && String(payload.tool_name).endsWith("close_agent"),
      )
      expect(closing?.payload.tool_input).toMatchObject({ target: ids.a })
      expect(
        ears.heard.some(
          ({ event, payload }) => event === "SubagentStop" && payload.agent_id === ids.a,
        ),
      ).toBe(false)

      await t.submit("Resume A")
      await step("3 A resumed")
      await t.submit("Message A")
      await step("4 A messaged")
      // A later turn of it starts with its prompt's hook alone, no SubagentStart.
      expect(
        ears.heard.filter(
          ({ event, payload }) => event === "SubagentStart" && payload.agent_id === ids.a,
        ),
      ).toHaveLength(1)
      expect(
        ears.heard.some(
          ({ event, payload }) =>
            event === "UserPromptSubmit" &&
            payload.agent_id === ids.a &&
            payload.prompt === "Again A",
        ),
      ).toBe(true)

      await t.submit("Spawn B and wait")
      ids.b = await spawned("B")
      await sleep(2000)
      await step("5 B spawned, root working")
      await t.escape()
      await sleep(3000)
      await step("6 root Esc while B runs")
      holdRoot.open()

      await t.submit("Spawn C")
      ids.c = await spawned("C")
      await t.until(codex.approval!.shows)
      await step("7 C asks")
      await t.escape()
      await sleep(3000)
      await step("8 C's request Esc")
      await t.submit("Message C")
      await sleep(4000)
      await step("9 C messaged again")
      out.cAsked = cAsked

      await t.submit("Spawn D")
      ids.d = await spawned("D")
      await t.until(/Result:/)
      await step("10 D spawned, held")
      // Where the person might reach D's thread to stop it: /agent opens Codex's command
      // center, which 0.170.0 lists root tasks in, not subagents.
      await t.submit("/agent")
      await sleep(2000)
      out["11 /agent"] = screenRecord(await t.screen())
      await t.escape()
      await sleep(1500)
    } finally {
      holdA.open()
      holdB.open()
      holdRoot.open()
      holdD.open()
      ears.stop()
      out.ids = ids
      const dir = process.env.PROBE_OUT ?? "probe-out"
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "subagent-ends-codex.json"), JSON.stringify(out, null, 2))
    }
  })
})
