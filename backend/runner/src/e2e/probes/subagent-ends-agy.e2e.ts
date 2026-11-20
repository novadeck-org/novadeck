// PROBE, not a test of Novadeck: what Antigravity's status line lists of a subagent that
// ends without finishing: killed by the root (manage_subagents kill, then kill_all), one
// whose model call fails, and one sent a message after it was killed. For each step,
// every hook report (status line snapshots included), the screen and Novadeck's activity.
// Runs only with NOVADECK_E2E_PROBES=1, by path; writes $PROBE_OUT/subagent-ends-agy.json.
/* eslint-disable no-await-in-loop -- A probe's steps run in order, each after the screen settles. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { agy } from "../agents/agy.js"
import { describe, e2e, expect, supported } from "../fixture.js"
import { asked, gate, Refusal, type Call } from "../model/script.js"
import { own, result, start } from "../scenarios.js"
import { listen } from "./subagent-ends-support.js"
import { probing, sleep } from "./support.js"

const work = { a: "Work A held", b: "Work B fails", c: "Work C held", d: "Work D held" } as const

// The subagent whose conversation holds `prompt`.
const of = (call: Call, prompt: string) =>
  !call.side &&
  call.system.includes("<subagent_reminder>") &&
  call.turns.some((turn) => turn.role === "user" && turn.text.includes(prompt))

const invoke = (role: string, prompt: string) => ({
  calls: [{ name: "invoke_subagent", input: { TypeName: "self", Role: role, Prompt: prompt } }],
})

describe.skipIf(!supported || !probing)(
  "probe: an Antigravity subagent that ends unfinished",
  () => {
    const it = e2e(agy)
    it("records what each end reports", async ({ e2e: run }) => {
      const ears = listen()
      const hold = gate()
      const ids: Record<string, string> = {}
      const out: Record<string, unknown> = { harness: "agy" }
      run.model.use(
        own(async (call) => {
          if (of(call, "Come back")) return { text: "Back and done." }
          if (!of(call, work.a) && !of(call, work.c) && !of(call, work.d)) return undefined
          await hold.opened
          return { text: "Held work done." }
        }),
        own((call) => {
          if (of(call, work.b)) throw new Refusal(400)
          return undefined
        }),
        own((call) => {
          if (asked(call, "Start A")) {
            out.rawTools = call.rawTools?.filter((one) =>
              /manage_subagents|send_message|invoke_subagent/.test(
                JSON.stringify(one).slice(0, 300),
              ),
            )
            return invoke("Helper A", work.a)
          }
          if (asked(call, "Start B")) return invoke("Helper B", work.b)
          if (asked(call, "Start C")) return invoke("Helper C", work.c)
          if (asked(call, "Start D")) return invoke("Helper D", work.d)
          if (asked(call, "Kill A"))
            return {
              calls: [
                { name: "manage_subagents", input: { Action: "kill", ConversationIds: [ids.a] } },
              ],
            }
          if (asked(call, "Kill all"))
            return { calls: [{ name: "manage_subagents", input: { Action: "kill_all" } }] }
          if (asked(call, "Message A"))
            return {
              calls: [
                {
                  name: "send_message",
                  input: { Recipient: ids.a, Message: "Come back" },
                },
              ],
            }
          return undefined
        }),
        own((call) => {
          const answer = result(call)
          if (answer === undefined) return undefined
          const id = /"conversationId":\s*"([^"]+)"/.exec(answer)?.[1]
          if (id) {
            const which = (["a", "b", "c", "d"] as const).find(
              (key) =>
                !ids[key] &&
                call.turns.some(
                  (turn) =>
                    turn.role === "user" && turn.text.includes(`Start ${key.toUpperCase()}`),
                ),
            )
            if (which) ids[which] = id
          }
          return { text: `Result: ${answer.slice(0, 160)}` }
        }),
        own(() => ({ text: "OK." })),
      )
      const t = await start(run, agy)
      let at = 0
      const step = async (label: string) => {
        await sleep(4000)
        const heard = ears.heard.slice(at)
        out[label] = {
          hooks: heard.filter(({ event }) => event !== "StatusLine"),
          statusLines: heard
            .filter(({ event }) => event === "StatusLine")
            .map(({ payload }) => ({
              state: payload.agent_state,
              subagents: payload.subagents,
              tasks: payload.task_count,
            })),
          activity: t.summary().activity,
          screen: screenRecord(await t.screen()),
        }
        at = ears.heard.length
      }
      try {
        await t.submit("Start A")
        await t.until(/Result:/)
        await step("1 A started, held")
        await t.submit("Kill A")
        await step("2 A killed")
        // What Novadeck counts (status-line.ts): the idle snapshot after a kill no longer names
        // the subagent running.
        const idle = ears.heard.findLast(
          ({ event, payload }) => event === "StatusLine" && payload.agent_state === "idle",
        )
        const listed = (idle?.payload.subagents ?? []) as { status?: string }[]
        expect(listed.length).toBeGreaterThan(0)
        expect(listed.filter(({ status }) => status === "running")).toEqual([])
        await t.submit("Message A")
        await sleep(4000)
        await step("3 A messaged after the kill")

        await t.submit("Start B")
        await sleep(4000)
        await step("4 B's model call failed")

        await t.submit("Start C")
        await sleep(2000)
        await t.submit("Kill all")
        await step("5 C killed by kill_all")

        await t.submit("Start D")
        await sleep(3000)
        await step("6 D started, held")
        out.ids = { ...ids }
      } finally {
        hold.open()
        ears.stop()
        out.ids = ids
        const dir = process.env.PROBE_OUT ?? "probe-out"
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, "subagent-ends-agy.json"), JSON.stringify(out, null, 2))
      }
    })
  },
)
