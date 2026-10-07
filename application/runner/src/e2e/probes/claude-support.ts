// Probe support for the Claude Code ask-surface probes (claude-ask*.e2e.ts). Not a test:
// a probe-only hook registered in the sandbox's user settings, beside Novadeck's own, that
// logs every payload it gets and, per event, can wait for a reply file before answering.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import type { DeckTerminal } from "../deck.js"
import type { E2E } from "../fixture.js"

export const events = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PermissionDenied",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "Elicitation",
  "ElicitationResult",
  "Stop",
  "SubagentStop",
]

const script = `
import { appendFileSync, existsSync, readFileSync, renameSync } from "node:fs"
import { join } from "node:path"
const [dir, event] = process.argv.slice(2)
const log = (extra) => appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ t: Date.now(), event, ...extra }) + "\\n")
let input = ""
for await (const chunk of process.stdin) input += chunk
let payload
try { payload = JSON.parse(input) } catch { payload = input }
log({ phase: "start", payload })
const cfgPath = join(dir, event + ".cfg")
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {}
const finish = (why, out) => {
  log({ phase: "end", why, out })
  if (out && out.stdout !== undefined) process.stdout.write(typeof out.stdout === "string" ? out.stdout : JSON.stringify(out.stdout))
  if (out && out.stderr) process.stderr.write(out.stderr)
  process.exit(out?.exit ?? 0)
}
if (cfg.wait) {
  const reply = join(dir, event + ".reply")
  const until = Date.now() + cfg.wait
  while (Date.now() < until) {
    if (existsSync(reply)) {
      const out = JSON.parse(readFileSync(reply, "utf8"))
      renameSync(reply, reply + "." + Date.now())
      finish("replied", out)
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  finish("waited-out", cfg.after ?? {})
}
finish("immediate", cfg.now ?? {})
`

export type Out = { stdout?: unknown; stderr?: string; exit?: number }
export type Cfg = { wait?: number; after?: Out; now?: Out }

export type Probe = {
  readonly dir: string
  /** Configure what the probe hook does for an event, before it fires. */
  readonly config: (event: string, cfg: Cfg | null) => void
  /** Answer a waiting hook. */
  readonly reply: (event: string, out: Out) => void
  /** Every logged line. */
  readonly log: () => {
    t: number
    event: string
    phase: string
    [k: string]: unknown
  }[]
  /** Hook payloads of an event, start phase. */
  readonly payloads: (event: string) => unknown[]
  readonly waitLog: (event: string, phase: string, timeoutMs?: number) => Promise<void>
}

/** Registers the probe hook for every event in the sandbox's Claude Code settings; call before the terminal starts. */
export const install = (run: E2E, options: { timeout?: number } = {}): Probe => {
  const dir = join(run.sandbox.root, "probe")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "hook.mjs"), script)
  const settingsPath = join(run.sandbox.home, ".claude", "settings.json")
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
  settings.hooks = Object.fromEntries(
    events.map((event) => [
      event,
      [
        {
          hooks: [
            {
              type: "command",
              command: `node ${join(dir, "hook.mjs")} ${dir} ${event}`,
              timeout: options.timeout ?? 600,
            },
          ],
        },
      ],
    ]),
  )
  writeFileSync(settingsPath, JSON.stringify(settings))
  const read = () =>
    existsSync(join(dir, "log.jsonl"))
      ? readFileSync(join(dir, "log.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : []
  return {
    dir,
    config: (event, cfg) => {
      if (cfg === null) writeFileSync(join(dir, `${event}.cfg`), "{}")
      else writeFileSync(join(dir, `${event}.cfg`), JSON.stringify(cfg))
    },
    reply: (event, out) => {
      const tmp = join(dir, `${event}.tmp`)
      writeFileSync(tmp, JSON.stringify(out))
      renameSync(tmp, join(dir, `${event}.reply`))
    },
    log: read,
    payloads: (event) =>
      read()
        .filter((l) => l.event === event && l.phase === "start")
        .map((l) => l.payload),
    waitLog: async (event, phase, timeoutMs = 30_000) => {
      const until = Date.now() + timeoutMs
      while (Date.now() < until) {
        if (read().some((l) => l.event === event && l.phase === phase)) return
        // eslint-disable-next-line no-await-in-loop -- The log is polled at intervals.
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error(`no ${phase} of ${event} hook in ${timeoutMs} ms`)
    },
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Shortened text of a transcript item list. */
export const brief = (items: readonly unknown[]) => JSON.parse(JSON.stringify(items))

// Captures, written one file per scenario, merged into the fixture afterwards.
const capDir = process.env.PROBE_OUT ?? "/tmp/claude-probe-out"
export const capture = (name: string, data: unknown) => {
  mkdirSync(capDir, { recursive: true })
  writeFileSync(join(capDir, `${name}.json`), JSON.stringify(data, null, 2))
}

export const snap = async (t: DeckTerminal) =>
  (await t.screen()).split("\n").filter((l, i, a) => a.slice(i).some(Boolean))
export { appendFileSync }

import { readFileSync as readFile } from "node:fs"

import type { AgentSetup } from "../agents/agent.js"
import type { Reply } from "../model/script.js"
import { own, result, answers, start } from "../scenarios.js"

export type Outcome = {
  /** What the model's next call carried as the tool's result. */
  toolResult?: string
  /** Hook log, trimmed. */
  hooks: {
    t: number
    event: string
    phase: string
    why?: unknown
    out?: unknown
    payload?: unknown
  }[]
  /** Raw transcript records after the prompt, trimmed. */
  transcript: unknown[]
}

export const rawTranscript = (probe: Probe): unknown[] => {
  const path = (probe.payloads("PreToolUse")[0] as { transcript_path?: string } | undefined)
    ?.transcript_path
  if (!path || !existsSync(path)) return []
  return readFile(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

/** Settings tweak before start. */
export const tweak = (run: E2E, change: (settings: Record<string, any>) => void) => {
  const path = join(run.sandbox.home, ".claude", "settings.json")
  const settings = JSON.parse(readFile(path, "utf8"))
  change(settings)
  writeFileSync(path, JSON.stringify(settings))
}

/** Rules: the prompt text answers with `reply`; the tool's result is recorded and answered "Done.". */
export const rules = (prompt: string, reply: Reply, seen: { result?: string }) => [
  answers(prompt, () => reply),
  own((call) => {
    const r = result(call)
    if (r === undefined) return undefined
    seen.result = r
    return { text: "Done." }
  }),
]
export type { AgentSetup }
export { start }

import { claude } from "../agents/claude.js"
import { describe, e2e, supported } from "../fixture.js"
import type { Rule } from "../model/script.js"
export type Shot = (label: string, wait?: number) => Promise<void>
type Step = (t: DeckTerminal, probe: Probe, shot: Shot) => Promise<void>
export type Spec = {
  name: string
  prompt?: string
  reply: Reply
  /** Replaces the default rules. */
  custom?: (seen: { result?: string }) => Rule[]
  /** Regex of the dialog as it shows. */
  shows?: RegExp
  /** Extra ms to wait after the hook start before capturing. */
  settle?: number
  /** Probe hook timeout in seconds. */
  hookTimeout?: number
  /** Event whose hook start to wait for when there is no dialog expected. */
  hookStart?: string
  /** Keys to press after captures; each item pressed, then screen captured. */
  drive?: Step
  setup?: (run: E2E, probe: Probe) => void
  expectResult?: boolean
  sizes?: [number, number][]
}

export const surface = (spec: Spec) =>
  describe.skipIf(!supported)(`claude ask surface: ${spec.name}`, () => {
    const it = e2e(claude)
    it("captures", async ({ e2e: run }) => {
      const probe = install(
        run,
        spec.hookTimeout === undefined ? {} : { timeout: spec.hookTimeout },
      )
      spec.setup?.(run, probe)
      const seen: { result?: string } = {}
      const prompt = spec.prompt ?? "Ask now"
      run.model.use(...(spec.custom ? spec.custom(seen) : rules(prompt, spec.reply, seen)))
      const t = await start(run, claude)
      await t.submit(prompt)
      if (spec.shows) await t.until(spec.shows, 30_000)
      else await probe.waitLog(spec.hookStart ?? "PermissionRequest", "start")
      await sleep(700 + (spec.settle ?? 0))
      const screens: Record<string, string[]> = {}
      screens["120x40"] = await snap(t)
      for (const [c, r] of spec.sizes ?? (spec.shows ? [[60, 20]] : [])) {
        t.resize(c, r)
        // eslint-disable-next-line no-await-in-loop -- The sizes are tried in turn.
        await sleep(900)
        // eslint-disable-next-line no-await-in-loop -- As above.
        screens[`${c}x${r}`] = await snap(t)
      }
      t.resize(120, 40)
      await sleep(900)
      const steps: Record<string, string[]> = {}
      const shot: Shot = async (label, wait = 700) => {
        await sleep(wait)
        steps[label] = await snap(t)
      }
      if (spec.drive) await spec.drive(t, probe, shot)
      await sleep(1500)
      steps.after = await snap(t)
      capture(spec.name, {
        screens,
        steps,
        toolResult: seen.result,
        hooks: probe.log(),
        transcript: rawTranscript(probe),
      })
    })
  })
