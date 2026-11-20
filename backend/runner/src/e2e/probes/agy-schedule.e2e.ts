// PROBE: whether Antigravity can cancel what its `schedule` tool set, as `scheduleChange`
// (terminals/schedules.ts) needs to know: it tracks a cron, or a timer set out longer than a
// day, by `<conversation>:<stepIdx>` of the call's PreToolUse hook, and never untracks one. The
// fake model sets a cron and a 25-hour timer, lists the tasks, kills each by the id the list or
// the call's result names, and lists again. Runs only with NOVADECK_E2E_PROBES=1, by path; with
// PROBE_OUT set it writes $PROBE_OUT/agy-schedule.probe.json: the two tools' declarations, every
// tool result the model saw, the PreToolUse and PostToolUse payloads, and the transcript.
// Run: PROBE_OUT=<dir> NOVADECK_E2E_PROBES=1 NOVADECK_E2E_AGENTS=agy pnpm -C backend/runner exec \
//   vitest run --config vitest.e2e.config.ts src/e2e/probes/agy-schedule.e2e.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { agy } from "../agents/agy.js"
import { describe, e2e, expect, supported, type E2E } from "../fixture.js"
import type { Call, Reply } from "../model/script.js"
import { answers, own, result, start } from "../scenarios.js"
import { sleep } from "./support.js"

type Hook = {
  readonly event: string
  readonly payload: { readonly stepIdx?: number; readonly toolCall?: { readonly name?: string } }
}

// The steps of the schedule calls' hooks of `event`.
const scheduleSteps = (hooks: readonly Hook[], event: string): (number | undefined)[] =>
  hooks
    .filter((hook) => hook.event === event && hook.payload.toolCall?.name === "schedule")
    .map((hook) => hook.payload.stepIdx)

// Logs each hook's payload, one JSON line each, and prints nothing: the call goes on.
const logger = `
const { appendFileSync } = require("node:fs")
let input = ""
process.stdin.on("data", (chunk) => (input += chunk))
process.stdin.on("end", () => {
  appendFileSync(process.argv[2], JSON.stringify({ event: process.argv[3], payload: input }) + "\\n")
})
`

const lines = (path: string): unknown[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown)
    : []

// Registers a hook that logs every tool event's payload, before Antigravity starts; its log.
const hooked = (run: E2E): string => {
  const dir = join(run.sandbox.root, "probe")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "hook.cjs"), logger)
  const log = join(dir, "log.jsonl")
  mkdirSync(join(run.sandbox.project, ".agents"), { recursive: true })
  // Tool events take matcher groups, as Novadeck's own plugin registers them.
  writeFileSync(
    join(run.sandbox.project, ".agents", "hooks.json"),
    JSON.stringify({
      probe: Object.fromEntries(
        ["PreToolUse", "PostToolUse"].map((event) => [
          event,
          [
            {
              matcher: "*",
              hooks: [
                {
                  type: "command",
                  command: `node ${join(dir, "hook.cjs")} ${log} ${event}`,
                  timeout: 30,
                },
              ],
            },
          ],
        ]),
      ),
    }),
  )
  return log
}

// What a run leaves for the fixture: the hook payloads and the newest conversation's transcript.
const gathered = (run: E2E, log: string) => {
  const brain = join(run.sandbox.home, ".gemini", "antigravity-cli", "brain")
  const newest = readdirSync(brain)
    .map((name) => ({ name, at: statSync(join(brain, name)).mtimeMs }))
    .toSorted((a, b) => b.at - a.at)[0]
  return {
    hooks: lines(log).map((line) => {
      const { event, payload } = line as { event: string; payload: string }
      try {
        return { event, payload: JSON.parse(payload) as unknown }
      } catch {
        return { event, payload }
      }
    }),
    transcript: newest
      ? lines(join(brain, newest.name, ".system_generated", "logs", "transcript_full.jsonl"))
      : [],
  }
}

const written = (name: string, found: unknown): void => {
  const out = process.env.PROBE_OUT
  if (!out) return
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, `${name}.json`), JSON.stringify(found, null, 2))
}

describe.skipIf(!supported || process.env.NOVADECK_E2E_PROBES === undefined)(
  "probe: cancelling Antigravity's schedules",
  () => {
    const it = e2e(agy)
    it("sets a cron and a long timer, then kills each", async ({ e2e: run }) => {
      const log = hooked(run)
      const found: Record<string, unknown> = { results: [] as string[] }
      const results = found.results as string[]
      // The id the latest result names for a task, in the forms Antigravity prints one.
      const idIn = (text: string): string | undefined =>
        /task id:?\s*([\w-]+\/task-\d+)/i.exec(text)?.[1] ??
        /([0-9a-f-]{36}\/task-\d+)/i.exec(text)?.[1]
      const ids: string[] = []
      const steps: ((call: Call) => Reply)[] = [
        () => ({
          calls: [
            {
              name: "schedule",
              input: { CronExpression: "*/5 * * * *", Prompt: "probe cron" },
            },
          ],
        }),
        () => ({
          calls: [
            {
              name: "schedule",
              input: { DurationSeconds: 90_000, Prompt: "probe timer" },
            },
          ],
        }),
        () => ({ calls: [{ name: "manage_task", input: { Action: "list" } }] }),
        () => ({
          calls: [{ name: "manage_task", input: { Action: "kill", TaskId: ids[0] ?? "" } }],
        }),
        () => ({
          calls: [{ name: "manage_task", input: { Action: "kill", TaskId: ids[1] ?? "" } }],
        }),
        () => ({ calls: [{ name: "manage_task", input: { Action: "list" } }] }),
        () => ({ text: "Probe done." }),
      ]
      run.model.use(
        answers("Probe the schedules", (call) => {
          found.tools = call.tools.filter((name) => /schedule|manage_task/.test(name))
          found.declarations = (call.rawTools ?? []).filter((tool) =>
            /"(schedule|manage_task)"/.test(JSON.stringify(tool).slice(0, 300)),
          )
          return steps[0]!(call)
        }),
        own((call) => {
          const text = result(call)
          if (text === undefined) return undefined
          results.push(text)
          const id = idIn(text)
          if (id && results.length <= 2) ids.push(id)
          return steps[results.length]?.(call) ?? { text: "Probe done." }
        }),
      )
      const t = await start(run, agy)
      await t.submit("Probe the schedules")
      await t.until("Probe done.", 120_000)
      await sleep(1500)
      found.ids = ids
      Object.assign(found, gathered(run, log), { screen: await t.screen() })
      written("agy-schedule-kill", found)
      // What scheduleChange relies on: each schedule's PostToolUse comes once it is killed,
      // with its PreToolUse's stepIdx, the step of the task id a kill names.
      const hooks = found.hooks as Hook[]
      const set = scheduleSteps(hooks, "PreToolUse")
      expect(set).toHaveLength(2)
      expect(ids).toEqual(set.map((step) => expect.stringMatching(new RegExp(`/task-${step}$`))))
      expect(scheduleSteps(hooks, "PostToolUse").toSorted()).toEqual(set.toSorted())
      expect(results.at(-1)).toMatch(/No background tasks/)
    })

    it("fires a cron each minute, and lists it still running after", async ({ e2e: run }) => {
      const log = hooked(run)
      const results: string[] = []
      run.model.use(
        answers("Start a minute cron", () => ({
          calls: [
            { name: "schedule", input: { CronExpression: "* * * * *", Prompt: "cron fired" } },
          ],
        })),
        answers("cron fired", () => ({ text: "Fired." })),
        answers("List the tasks", () => ({
          calls: [{ name: "manage_task", input: { Action: "list" } }],
        })),
        own((call) => {
          const text = result(call)
          if (text === undefined) return undefined
          results.push(text)
          return { text: results.length === 1 ? "Set." : "Listed." }
        }),
      )
      const t = await start(run, agy)
      await t.submit("Start a minute cron")
      await t.until("Set.", 60_000)
      // Past its first firing, and well into its second minute.
      await t.until("Fired.", 100_000)
      await sleep(5000)
      await t.submit("List the tasks")
      await t.until("Listed.", 60_000)
      await sleep(1500)
      const fired = { results, ...gathered(run, log), screen: await t.screen() }
      written("agy-schedule-fires", fired)
      // A firing ends nothing: no PostToolUse, and the cron still runs.
      expect(scheduleSteps(fired.hooks as Hook[], "PostToolUse")).toEqual([])
      expect(results.at(-1)).toMatch(/"toolName":"schedule"/)
    })
  },
)
