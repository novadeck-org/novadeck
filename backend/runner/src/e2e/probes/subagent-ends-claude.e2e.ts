// PROBE, not a test of Novadeck: what Claude Code reports when a background subagent ends
// without finishing: stopped by the root's TaskStop, then resumed with SendMessage, and one
// the person stops from Claude Code's own task list; and the subagents a root turn the person
// Escapes had started. For each step, every hook payload, the root transcript's records, the
// screen and Novadeck's activity summary; and it asserts what Novadeck's reconcile rests on.
// Runs only with NOVADECK_E2E_PROBES=1, by path; writes $PROBE_OUT/subagent-ends-claude.json
// and $PROBE_OUT/subagent-escape-claude.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { claude } from "../agents/claude.js"
import { describe, e2e, expect, supported } from "../fixture.js"
import { asked, gate, type Call } from "../model/script.js"
import { own, result, start } from "../scenarios.js"
import { install } from "./claude-support.js"
import { probing, sleep } from "./support.js"

const first = "novadeck-probe-first-work"
const second = "novadeck-probe-second-work"
const nestedFore = "novadeck-probe-nested-foreground"
const nestedBack = "novadeck-probe-nested-background"

// The subagent whose conversation opens with `marker`.
const opens = (call: Call, marker: string) =>
  !call.side && (call.turns.find((turn) => turn.role === "user")?.text.includes(marker) ?? false)

const background = (marker: string, description: string) => ({
  calls: [
    {
      name: "Agent",
      input: {
        description,
        prompt: `${marker}: reply when done.`,
        subagent_type: "general-purpose",
        run_in_background: true,
      },
    },
  ],
})

describe.skipIf(!supported || !probing)(
  "probe: a Claude Code subagent that ends unfinished",
  () => {
    const it = e2e(claude)
    it("records what each end reports", async ({ e2e: run }) => {
      const probe = install(run)
      const holdFirst = gate()
      const holdResumed = gate()
      const holdSecond = gate()
      const holdNested = gate()
      const ids: Record<string, string> = {}
      let resumed = false
      const out: Record<string, unknown> = { harness: "claude" }
      run.model.use(
        // The first subagent: held until stopped; once resumed, held again, then done.
        own(async (call) => {
          if (!opens(call, first)) return undefined
          if (call.turns.some((turn) => turn.role === "user" && turn.text.includes("Keep going"))) {
            resumed = true
            await holdResumed.opened
            return { text: "Resumed work done." }
          }
          await holdFirst.opened
          return { text: "First work done." }
        }),
        own(async (call) => {
          if (!opens(call, nestedFore) && !opens(call, nestedBack)) return undefined
          await holdNested.opened
          return { text: "Nested work done." }
        }),
        own(async (call) => {
          if (!opens(call, second)) return undefined
          // What a subagent is offered, for whether it can nest.
          out.subagentTools = call.tools
          // It starts one subagent in the background and one in the foreground, held.
          if (!call.turns.some((turn) => turn.role === "tool"))
            return {
              calls: [
                background(nestedBack, "Nested background").calls[0]!,
                {
                  name: "Agent",
                  input: {
                    description: "Nested foreground",
                    prompt: `${nestedFore}: reply when done.`,
                    subagent_type: "general-purpose",
                  },
                },
              ],
            }
          await holdSecond.opened
          return { text: "Second work done." }
        }),
        own((call) =>
          asked(call, "Start the work") ? background(first, "First work") : undefined,
        ),
        own((call) =>
          asked(call, "Start more work") ? background(second, "Second work") : undefined,
        ),
        own((call) => {
          if (!asked(call, "Stop the work")) return undefined
          out.taskStopSchema = call.rawTools?.find((one) =>
            JSON.stringify(one).includes("TaskStop"),
          )
          return { calls: [{ name: "TaskStop", input: { task_id: ids.first } }] }
        }),
        own((call) => {
          if (!asked(call, "Resume the work")) return undefined
          out.sendMessageSchema = call.rawTools?.find((one) =>
            JSON.stringify(one).includes('"SendMessage"'),
          )
          return {
            calls: [{ name: "SendMessage", input: { to: ids.first, message: "Keep going" } }],
          }
        }),
        own((call) => (result(call) !== undefined ? { text: "Done with that." } : undefined)),
        own(() => ({ text: "OK." })),
      )
      const t = await start(run, claude)
      let at = 0
      const step = async (label: string) => {
        await sleep(3000)
        const log = probe.log()
        const transcriptPath = (
          probe.payloads("UserPromptSubmit")[0] as { transcript_path?: string } | undefined
        )?.transcript_path
        const records =
          transcriptPath && existsSync(transcriptPath)
            ? readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean)
            : []
        out[label] = {
          hooks: log.slice(at).filter((line) => line.phase === "start"),
          activity: t.summary().activity,
          screen: screenRecord(await t.screen()),
          transcript: records.map((line) => JSON.parse(line)),
        }
        at = log.length
      }
      const idOf = async () =>
        t.poll(() => {
          const started = probe.payloads("SubagentStart") as { agent_id?: string }[]
          return started.at(-1)?.agent_id
        }, "a SubagentStart")
      try {
        await t.submit("Start the work")
        await t.until("Done with that.")
        ids.first = await idOf()
        await step("1 started")
        // What the reconcile rests on (subagents-listed): a Stop while a background subagent
        // runs names it, by its own id, as a running subagent.
        const stops = (probe.payloads("Stop") as { background_tasks?: unknown }[]).filter(
          (payload) => Array.isArray(payload.background_tasks),
        )
        expect(stops.at(-1)?.background_tasks).toContainEqual(
          expect.objectContaining({ id: ids.first, type: "subagent", status: "running" }),
        )

        await t.submit("Stop the work")
        await sleep(2000)
        await step("2 stopped by TaskStop")
        // A TaskStop of a subagent says so, by the subagent's id, and fires no SubagentStop.
        const stopped = (
          probe.payloads("PostToolUse") as { tool_name?: string; tool_response?: unknown }[]
        ).find(({ tool_name: name }) => name === "TaskStop")
        expect(stopped?.tool_response).toMatchObject({
          task_id: ids.first,
          task_type: "local_agent",
        })
        expect(
          (probe.payloads("SubagentStop") as { agent_id?: string }[]).map(({ agent_id: id }) => id),
        ).not.toContain(ids.first)

        await t.submit("Resume the work")
        await t.poll(() => (resumed ? true : undefined), "the resumed subagent's model call")
        await step("3 resumed")
        holdResumed.open()
        await sleep(4000)
        await step("4 resumed one finished")

        await t.submit("Start more work")
        await t.poll(
          () => (probe.payloads("SubagentStart").length >= 5 ? true : undefined),
          "the second subagent and its two nested ones to start",
        )
        ids.second = (probe.payloads("SubagentStart") as { agent_id?: string }[]).at(-3)!.agent_id!
        await step("5 second and its nested started")
        // A root turn whose Stop lists what runs, the nested ones among it or not.
        await t.submit("Ping now")
        await t.until("OK.")
        await step("6 a root turn while nested run")
        // The person opens the task list from the footer and stops the agent there.
        t.press("\x1b[B")
        await sleep(1500)
        out["7a down"] = screenRecord(await t.screen())
        t.press("\x1b[B")
        await sleep(1500)
        out["7b down"] = screenRecord(await t.screen())
        t.press("x")
        await sleep(1500)
        out["7c x"] = screenRecord(await t.screen())
        await sleep(3000)
        await step("7 stopped from the task list")
        await t.escape()
        await sleep(3000)
        await step("8 after")
        holdNested.open()
        await sleep(4000)
        await step("9 nested released")
      } finally {
        holdFirst.open()
        holdSecond.open()
        holdNested.open()
        out.ids = ids
        const dir = process.env.PROBE_OUT ?? "probe-out"
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "subagent-ends-claude.json"), JSON.stringify(out, null, 2))
      }
    })

    // The person's Escape on a root turn that started subagents: one in the background, one
    // in the foreground, then both, each held at its model call. Then each is let go, and a
    // root turn's Stop says what runs.
    it("records what a root Escape does to the subagents its turn started", async ({
      e2e: run,
    }) => {
      const probe = install(run)
      const cases = ["background", "foreground", "both"] as const
      type Case = (typeof cases)[number]
      const marker = (which: Case, kind: "bg" | "fg") => `novadeck-probe-escape-${which}-${kind}`
      const holds = Object.fromEntries(
        cases.map((which) => [which, { root: gate(), sub: gate() }]),
      ) as Record<Case, { root: ReturnType<typeof gate>; sub: ReturnType<typeof gate> }>
      const out: Record<string, unknown> = { harness: "claude" }
      const foreground = (which: Case) => ({
        name: "Agent",
        input: {
          description: `Held ${which} fg`,
          prompt: `${marker(which, "fg")}: reply when done.`,
          subagent_type: "general-purpose",
        },
      })
      run.model.use(
        own(async (call) => {
          const which = cases.find(
            (each) => opens(call, marker(each, "bg")) || opens(call, marker(each, "fg")),
          )
          if (!which) return undefined
          await holds[which].sub.opened
          return { text: "Subagent done." }
        }),
        own((call) => {
          const which = cases.find((each) => asked(call, `Escape ${each}`))
          if (!which) return undefined
          const calls = [
            ...(which !== "foreground"
              ? background(marker(which, "bg"), `Held ${which} bg`).calls
              : []),
            ...(which !== "background" ? [foreground(which)] : []),
          ]
          return { calls }
        }),
        // The root's look at what it started is held: its turn runs until the Escape.
        own(async (call) => {
          if (result(call) === undefined) return undefined
          const last = call.turns.findLast((turn) => turn.role === "user")
          const which = cases.find(
            (each) => last?.role === "user" && last.text.includes(`Escape ${each}`),
          )
          if (!which) return { text: "Done with that." }
          await holds[which].root.opened
          return { text: "Root went on." }
        }),
        own(() => ({ text: "OK." })),
      )
      const t = await start(run, claude)
      let at = 0
      const step = async (label: string) => {
        await sleep(3000)
        const log = probe.log()
        out[label] = {
          hooks: log.slice(at).filter((line) => line.phase === "start"),
          activity: t.summary().activity,
          screen: screenRecord(await t.screen()),
        }
        at = log.length
      }
      const starts = () => probe.payloads("SubagentStart").length
      try {
        for (const which of cases) {
          const before = starts()
          await t.submit(`Escape ${which}`)
          await t.poll(
            () => (starts() >= before + (which === "both" ? 2 : 1) ? true : undefined),
            `the ${which} case's subagents to start`,
          )
          await sleep(2500)
          await step(`${which}: running`)
          await t.escape()
          await sleep(3000)
          await step(`${which}: after the Escape`)
          holds[which].root.open()
          holds[which].sub.open()
          await sleep(5000)
          await step(`${which}: subagents let go`)
          // Each ran on through the Escape, and ends with its own stop.
          const launched = (
            probe.payloads("PostToolUse") as { tool_name?: string; tool_response?: unknown }[]
          )
            .filter(({ tool_name: name }) => name === "Agent")
            .map(({ tool_response: response }) => (response as { agentId?: string }).agentId)
            .slice(which === "both" ? -2 : -1)
          const ended = (probe.payloads("SubagentStop") as { agent_id?: string }[]).map(
            ({ agent_id: id }) => id,
          )
          for (const id of launched) expect(ended).toContain(id)
          await t.submit("Ping now")
          await t.until("OK.")
          await sleep(4000)
          await step(`${which}: a root turn after`)
        }
      } finally {
        for (const which of cases) {
          holds[which].root.open()
          holds[which].sub.open()
        }
        const dir = process.env.PROBE_OUT ?? "probe-out"
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "subagent-escape-claude.json"), JSON.stringify(out, null, 2))
      }
    })
  },
)
