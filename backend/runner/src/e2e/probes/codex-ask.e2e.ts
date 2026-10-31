import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

import { screenRecord, type ScreenRecord } from "@novadeck/harness-core/testing/probes"
import { afterAll } from "vitest"

import { adapterFolder } from "../../testing/adapters.js"
import { codex } from "../agents/codex.js"
import type { DeckTerminal } from "../deck.js"
import { poll } from "../deck.js"
import { describe, e2e, supported, type E2E } from "../fixture.js"
import { installHarness, pins } from "../install.js"
import { asked, type Call, type Rule } from "../model/script.js"
import { prompted } from "../scenarios.js"
import { sleep } from "./support.js"

// PROBE, not a test of Novadeck: how Codex (the pin, or the newest with NOVADECK_E2E_HARNESS=latest) asks the person for things in its
// interactive TUI, which hooks fire, what its rollout records and which keys answer, for
// the chat view's "answer from the chat" decision. Each scenario writes what it saw into
// harnesses/codex/src/fixtures/ask.probe.json (afterAll), scrubbed of the sandbox's paths.

const it = e2e(codex)

// The pinned release writes ask.probe.json; with NOVADECK_E2E_HARNESS=latest a newer one
// writes ask.probe.<version>.json beside it, so the pin's screens are never overwritten (a
// latest that is the pin writes ask.probe.json).
const fixtureFolder = join(adapterFolder("codex"), "fixtures")

type Json = Record<string, unknown>
const captured: Record<string, Json> = {}

// ---------------------------------------------------------------- probe hook

// Logs every hook it runs to events.jsonl in its folder. A PermissionRequest hook in
// `wait` mode (a file named `mode` holding it, read when the hook starts) holds until
// `answer.json` appears, then prints its `stdout`/`stderr` and exits with its `exit`.
const hookScript = `
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
const [dir, event] = process.argv.slice(2)
let input = ""
for await (const chunk of process.stdin) input += chunk
const payload = JSON.parse(input)
const log = (kind, extra = {}) =>
  appendFileSync(dir + "/events.jsonl", JSON.stringify({ t: Date.now(), kind, event, pid: process.pid, ...extra }) + "\\n")
log("start", { payload })
{
  const mode = existsSync(dir + "/mode") ? readFileSync(dir + "/mode", "utf8").trim() : "pass"
  if ((event === "PermissionRequest" && mode === "wait") ||
      (event === "PreToolUse" && mode === "wait-pre" && payload.tool_name === "request_user_input")) {
    while (!existsSync(dir + "/answer.json")) await sleep(100)
    const answer = JSON.parse(readFileSync(dir + "/answer.json", "utf8"))
    rmSync(dir + "/answer.json")
    log("answered", { answer })
    if (answer.stdout !== undefined) process.stdout.write(answer.stdout)
    if (answer.stderr) process.stderr.write(answer.stderr)
    process.exit(answer.exit ?? 0)
  }
}
log("end")
`

const events = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "Interrupt",
]

type Probe = {
  readonly dir: string
  /** Every hook line so far. */
  readonly log: () => Json[]
  /** Sets the PermissionRequest hook's mode for hooks started from now on. */
  readonly mode: (mode: "pass" | "wait" | "wait-pre") => void
  /** Releases a waiting PermissionRequest hook with what it prints. */
  readonly answer: (answer: { stdout?: string; stderr?: string; exit?: number }) => void
}

/**
 * Registers the probe hook for every event in Codex's own hooks.json (run with the trust
 * bypass). With `matcher`, a second PreToolUse hook under it logs as `PreToolUse[matched]`.
 */
const probe = (run: E2E, timeout = 600, matcher?: string): Probe => {
  const dir = join(run.sandbox.root, "probe")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "hook.mjs"), hookScript)
  writeFileSync(
    join(run.sandbox.home, ".codex", "hooks.json"),
    JSON.stringify({
      hooks: Object.fromEntries(
        events.map((event) => [
          event,
          [
            {
              hooks: [
                {
                  type: "command",
                  command: `node ${join(dir, "hook.mjs")} ${dir} ${event}`,
                  timeout,
                },
              ],
            },
            ...(event === "PreToolUse" && matcher !== undefined
              ? [
                  {
                    matcher,
                    hooks: [
                      {
                        type: "command",
                        command: `node ${join(dir, "hook.mjs")} ${dir} PreToolUse[matched]`,
                        timeout,
                      },
                    ],
                  },
                ]
              : []),
          ],
        ]),
      ),
    }),
  )
  return {
    dir,
    log: () =>
      existsSync(join(dir, "events.jsonl"))
        ? readFileSync(join(dir, "events.jsonl"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Json)
        : [],
    mode: (mode) => writeFileSync(join(dir, "mode"), mode),
    answer: (answer) => writeFileSync(join(dir, "answer.json"), JSON.stringify(answer)),
  }
}

// ---------------------------------------------------------------- helpers

/** Opens the pinned Codex, its probe hooks trusted for this run, at its prompt. */
const open = async (run: E2E, flags = ""): Promise<DeckTerminal> => {
  const t = await run.deck.open(`codex --dangerously-bypass-hook-trust ${flags}`.trim())
  await t.reached("ready", { timeoutMs: 60_000 })
  await prompted(t, codex)
  return t
}

const rolloutFile = (run: E2E): string | undefined => {
  const sessions = join(run.sandbox.home, ".codex", "sessions")
  if (!existsSync(sessions)) return undefined
  const file = readdirSync(sessions, {
    recursive: true,
    encoding: "utf8",
  }).find((one) => one.endsWith(".jsonl"))
  return file ? join(sessions, file) : undefined
}

const rollout = (run: E2E): Json[] => {
  const file = rolloutFile(run)
  return file
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Json)
    : []
}

// The context Codex writes as the person's message (the environment, AGENTS.md), which
// differs run to run and which the chat leaves out.
const contextMessage = /^\s*(<environment_context>|# AGENTS\.md instructions)/

const isContext = (payload: Json): boolean =>
  Array.isArray(payload.content) &&
  payload.content.some(
    (part) =>
      typeof (part as Json).text === "string" && contextMessage.test(String((part as Json).text)),
  )

/**
 * The rollout's records that say what was asked and answered, not the context noise: the
 * tool calls, their outputs and the person's and the agent's messages, which the chat's
 * transcript is made of.
 */
const interesting = (records: Json[]): Json[] =>
  records.filter((record) => {
    const payload = record.payload as Json | undefined
    const type = String(payload?.type ?? "")
    if (record.type === "response_item")
      return (
        [
          "function_call",
          "function_call_output",
          "custom_tool_call",
          "custom_tool_call_output",
        ].includes(type) ||
        (type === "message" &&
          (payload?.role === "user" || payload?.role === "assistant") &&
          !isContext(payload))
      )
    if (record.type === "event_msg")
      return (
        !/token_count|agent_message|user_message|thread_name/.test(type) ||
        /user_message/.test(type)
      )
    return false
  })

// What differs from one run of the same scenario to the next: times, durations, process
// ids and ids made per run, by their key wherever they sit. Two recordings at 0.163.0,
// compared, differed in these and in one race only: which of exec-two-queued's commands
// Codex asks for first, which varies run to run.
const perRun = new Set([
  "askedAt",
  "at",
  "completed_at",
  "completed_at_ms",
  "create_time",
  "duration_ms",
  "nanos",
  "process_id",
  "started_at",
  "started_at_ms",
  "t",
  "time_to_first_token_ms",
  "timestamp",
])
const perRunIds = new Set(["actor", "ref"])
const fixedInstant = "2000-01-01T00:00:00.000Z"

const scrubbed = (value: unknown, key?: string): unknown => {
  if (Array.isArray(value)) return value.map((each) => scrubbed(each))
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([k, each]) =>
        // A dialog's id hashes what it shows, the sandbox's path included.
        key === "dialog" && k === "id" ? [k, "<id>"] : [k, scrubbed(each, k)],
      ),
    )
  // Each stays of its kind, as readers parse them: an instant one fixed instant, any other
  // number 0.
  if (key !== undefined && perRun.has(key)) {
    if (typeof value === "number") return 0
    if (typeof value === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)) return fixedInstant
    if (typeof value === "string" && /^-?[\d.]+$/.test(value)) return "0"
  }
  if (key !== undefined && perRunIds.has(key) && typeof value === "string") return "<id>"
  return value
}

const scrub = (run: E2E, value: unknown): unknown => {
  const text = JSON.stringify(value)
    .split(run.sandbox.root)
    .join("/tmp/sandbox")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/call_[0-9a-f]{24}/g, "call_<id>")
    .replace(/\b(fc|msg)_[0-9a-f]{24}\b/g, "$1_<id>")
    .replace(
      /sessions\/\d{4}\/\d\d\/\d\d\/rollout-[\dT-]+-<uuid>/g,
      "sessions/<date>/rollout-<time>-<uuid>",
    )
    .replace(/Chunk ID: [0-9a-f]{6}/g, "Chunk ID: <id>")
    .replace(/Wall time: \d+\.\d+ seconds/g, "Wall time: <n> seconds")
    .replace(/aborted by user after [\d.]+s/g, "aborted by user after <n>s")
    // A finished turn's line, its time and the clock: "Worked for 4s • 15:49".
    .replace(/Worked for [^"•]*• \d\d:\d\d/g, "Worked for <n> • <HH:MM>")
    // A running call's mark blinks between • and ◦.
    .replace(/"◦ /g, '"• ')
  return scrubbed(JSON.parse(text))
}

const waitScreen = (t: DeckTerminal, shows: string | RegExp, timeoutMs = 20_000) =>
  t.until(shows, timeoutMs)

/** The screen once it has stayed the same for a moment, or as it is after a few seconds of animation. */
const settled = async (t: DeckTerminal, forMs = 800): Promise<string> => {
  let last = { shown: "", since: Date.now() }
  const until = Date.now() + 4000
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop -- The screen is looked at in turn.
    const shown = await t.screen()
    if (shown !== last.shown) last = { shown, since: Date.now() }
    if (Date.now() - last.since >= forMs) return shown
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(100)
  }
  return last.shown
}

/** The screen's non-blank rows, as the probe fixture keeps a screen (`columns` where it is known). */
const rows = (screen: string, columns?: number): ScreenRecord =>
  screenRecord(
    screen
      .split("\n")
      .filter((line) => line.trim() !== "")
      .join("\n"),
    { columns },
  )

/** The screen's non-blank rows at 120x40 and again at 60x20. */
const shoot = async (t: DeckTerminal): Promise<{ wide: ScreenRecord; narrow: ScreenRecord }> => {
  t.resize(120, 40)
  const wide = rows(await settled(t), 120)
  t.resize(60, 20)
  await sleep(500)
  const narrow = rows(await settled(t), 60)
  t.resize(120, 40)
  await sleep(500)
  await settled(t)
  return { wide, narrow }
}

const lastTool = (run: E2E): string | undefined =>
  run.model.calls.flatMap((call) => call.turns).findLast((turn) => turn.role === "tool")?.text

/** A rule: the first look at `words` answers with `reply`; the tool's result ends with "Finished". */
const script = (words: string, reply: (call: Call) => ReturnType<Rule>): Rule[] => [
  // Never the harness's own calls, such as the title's: they offer no tools to call.
  (call) => (!call.side && asked(call, words) ? reply(call) : undefined),
  (call) => {
    const turn = call.turns.at(-1)
    return turn?.role === "tool" ? { text: "Finished the request." } : undefined
  },
]

const modelSaw = (run: E2E) => run.model.calls.map((call) => call.turns)

const save = (run: E2E, name: string, data: Json) => {
  captured[name] = scrub(run, data) as Json
}

afterAll(async () => {
  // A run that probed no Codex scenario (another harness's, or none supported) writes nothing.
  if (Object.keys(captured).length === 0) return
  // A latest release that is the pin's writes the pin's file, not a copy of it.
  const { version } = await installHarness("codex")
  const pinned = version === pins.codex?.version
  const fixturePath = join(fixtureFolder, pinned ? "ask.probe.json" : `ask.probe.${version}.json`)
  // A filtered run adds to what the file already holds.
  const before = existsSync(fixturePath)
    ? ((
        JSON.parse(readFileSync(fixturePath, "utf8")) as {
          scenarios?: Record<string, Json>
        }
      ).scenarios ?? {})
    : {}
  // By name, so a re-recording's diff shows what changed, not the order scenarios ran in.
  const scenarios = Object.fromEntries(
    Object.entries({ ...before, ...captured }).toSorted(([a], [b]) => a.localeCompare(b)),
  )
  writeFileSync(
    fixturePath,
    `${JSON.stringify(
      {
        harness: "codex",
        version,
        source: "captured",
        how: "the codex TUI in the e2e sandbox against the fake model (Responses API), driven through Novadeck's terminals at 120x40 and 60x20, with a probe hook (hooks.json, --dangerously-bypass-hook-trust) logging each hook's payload; paths and ids scrubbed",
        scenarios,
      },
      null,
      2,
    )}\n`,
  )
  // In the repository's own style, as committed, so a rewrite by a run that saw nothing new
  // changes nothing.
  const root = join(fixtureFolder, "..", "..", "..", "..")
  execFileSync(
    process.execPath,
    [join(root, "node_modules", "oxfmt", "bin", "oxfmt"), fixturePath],
    {
      cwd: root,
      stdio: ["ignore", "ignore", "inherit"],
    },
  )
})

// ---------------------------------------------------------------- surfaces

const exec = (command: string) => () => ({
  calls: [
    {
      name: "exec_command",
      input: {
        cmd: command,
        sandbox_permissions: "require_escalated",
        justification: "Echo outside the sandbox",
      },
    },
  ],
})

const hookLines = (hooks: Probe) =>
  hooks.log().map((line) => ({
    kind: line.kind,
    event: line.event,
    payload: line.payload,
  }))

/**
 * Brings up a dialog with `prompt`, captures what Codex, its hooks and its rollout show
 * while it waits, presses `keys` one by one (each with its settle), and captures the
 * outcome. `keys` entries are `[label, key]`.
 */
const surface = async (
  run: E2E,
  name: string,
  options: {
    readonly flags?: string
    readonly before?: (t: DeckTerminal) => Promise<void>
    readonly prompt: string
    readonly shows: RegExp
    readonly keys: readonly (readonly [string, string])[]
    readonly settle?: number
  },
): Promise<{ t: DeckTerminal; hooks: Probe }> => {
  const hooks = probe(run)
  const t = await open(run, options.flags)
  await options.before?.(t)
  await t.prompt(options.prompt)
  await waitScreen(t, options.shows)
  const screens = await shoot(t)
  const during = hookLines(hooks)
  const rolloutDuring = interesting(rollout(run))
  const detail = await t.detail()
  const novadeckSees = { activity: detail.activity, requests: detail.requests }
  const pressed: Json[] = []
  for (const [label, key] of options.keys) {
    t.press(key)
    // eslint-disable-next-line no-await-in-loop -- The keys are pressed in turn.
    await sleep(options.settle ?? 2500)
    // eslint-disable-next-line no-await-in-loop -- As above.
    pressed.push({ label, key, screen: rows(await settled(t)) })
  }
  await sleep(1000)
  save(run, name, {
    screens,
    novadeckSees,
    hooksBeforeAnswer: during,
    hooksAll: hookLines(hooks),
    rolloutBeforeAnswer: rolloutDuring,
    pressed,
    rolloutAfter: interesting(rollout(run)),
    toolOutputSeenByModel: lastTool(run) ?? null,
  })
  return { t, hooks }
}

describe.skipIf(!supported)("Codex ask surfaces (probe)", () => {
  // The command approval, answered with each of its keys.
  for (const [key, label] of [
    ["y", "approve"],
    ["p", "approve-prefix"],
    ["a", "approve-session-key-not-offered"],
    ["d", "decline-key-not-offered"],
    ["n", "cancel"],
  ] as const) {
    it(`exec approval: ${label} (${key})`, async ({ e2e: run }) => {
      run.model.use(...script("Run the command", exec("echo approved > probe-out.txt")))
      await surface(run, `exec-${label}`, {
        prompt: "Run the command",
        shows: /Would you like to run the following command/,
        keys: [[label, key]],
      })
    })
  }

  // A file written outside the workspace, through the apply_patch Codex intercepts in a
  // shell command: the patch approval.
  for (const [key, label] of [
    ["y", "approve"],
    ["a", "approve-session"],
    ["n", "cancel"],
  ] as const) {
    it(`apply_patch approval: ${label} (${key})`, async ({ e2e: run }) => {
      const outside = join(run.sandbox.project, "patched.txt")
      const patch = `apply_patch <<'EOF'\n*** Begin Patch\n*** Add File: ${outside}\n+hello\n*** End Patch\nEOF`
      run.model.use(
        ...script("Patch the file", () => ({
          calls: [{ name: "exec_command", input: { cmd: patch } }],
        })),
      )
      await surface(run, `patch-${label}`, {
        flags: "-s read-only",
        prompt: "Patch the file",
        shows: /Would you like to make the following edits|Do you want to approve|Would you like/,
        keys: [[label, key]],
      })
    })
  }

  // request_user_input, which Codex offers in Plan mode only (its default-mode gate is
  // the feature `default_mode_request_user_input`).
  const questions = {
    questions: [
      {
        id: "color",
        header: "Color",
        question: "Which color should the button be?",
        options: [
          { label: "Blue (Recommended)", description: "The house color." },
          { label: "Green", description: "Calmer." },
        ],
      },
    ],
  }
  const planMode = async (t: DeckTerminal) => {
    await t.submit("/plan")
    await waitScreen(t, /Plan mode/)
    await settled(t)
  }
  for (const [label, keys] of [
    ["digit-1", [["1", "1"]]],
    ["digit-2", [["2", "2"]]],
    ["esc", [["esc", "\x1b"]]],
    ["wrong-key-y", [["y", "y"]]],
  ] as const) {
    it(`request_user_input in Plan mode: ${label}`, async ({ e2e: run }) => {
      run.model.use(
        ...script("Ask me about the button", () => ({
          calls: [{ name: "request_user_input", input: questions }],
        })),
      )
      await surface(run, `rui-plan-${label}`, {
        before: planMode,
        prompt: "Ask me about the button",
        shows: /Which color should the button be/,
        keys,
      })
    })
  }

  it("request_user_input in default mode (feature off): what the model is told", async ({
    e2e: run,
  }) => {
    // Codex refuses the call here, which is what the probe records.
    run.model.expectRejection((one) => one.call.name === "request_user_input")
    run.model.use(
      ...script("Ask me about the button", () => ({
        calls: [{ name: "request_user_input", input: questions }],
      })),
    )
    const hooks = probe(run)
    const t = await open(run)
    await t.prompt("Ask me about the button")
    await t.until("Finished the request.")
    // Its Stop hook may still be running when the reply shows.
    await poll(
      () =>
        hookLines(hooks).some((line) => line.kind === "end" && line.event === "Stop")
          ? true
          : undefined,
      "its Stop hook to end",
      10_000,
    )
    save(run, "rui-default-off", {
      hooksAll: hookLines(hooks),
      toolOutputSeenByModel: lastTool(run) ?? null,
      screen: rows(await settled(t)),
    })
  })

  it("request_user_input in default mode (feature on)", async ({ e2e: run }) => {
    run.model.use(
      ...script("Ask me about the button", () => ({
        calls: [{ name: "request_user_input", input: questions }],
      })),
    )
    await surface(run, "rui-default-on", {
      flags: "--enable default_mode_request_user_input",
      prompt: "Ask me about the button",
      shows: /Which color should the button be/,
      keys: [["2", "2"]],
    })
  })

  // "Chat about this" on every harness: the question abandoned with Esc (which interrupts
  // the turn), then the person's words sent as the next prompt; against answering with
  // "None of the above" and notes. What each leaves: the turn, the hooks, the rollout, the
  // composer, and what the model is shown of the question.
  const clarifying: Rule[] = [
    (call) => (asked(call, "Let me clarify") ? { text: "Understood." } : undefined),
  ]

  it("request_user_input: Esc, then the person's words as the next prompt", async ({
    e2e: run,
  }) => {
    run.model.use(
      ...script("Ask me about the button", () => ({
        calls: [{ name: "request_user_input", input: questions }],
      })),
      ...clarifying,
    )
    const { t, hooks } = await surface(run, "rui-esc-then-prompt", {
      flags: "--enable default_mode_request_user_input",
      prompt: "Ask me about the button",
      shows: /Which color should the button be/,
      keys: [],
    })
    // Not agents.interrupt, which the runner refuses while a request waits (its Esc would
    // answer the dialog): the key an adapter's answer steps would press.
    t.press("\x1b")
    await sleep(2500)
    const afterEsc = rows(await settled(t))
    const detailAfterEsc = await t.detail()
    const hooksAfterEsc = hookLines(hooks)
    const rolloutAfterEsc = interesting(rollout(run))
    // How long the chat's prompt is refused as the request still waiting.
    const waited = Date.now()
    await t.poll(
      async () => ((await t.detail()).requests.length === 0 ? true : undefined),
      "the abandoned request settled",
      20_000,
    )
    const settledAfterMs = Date.now() - waited
    await t.prompt("Let me clarify: I want purple, not these")
    await waitScreen(t, /Understood\./)
    await sleep(1000)
    const afterPrompt = rows(await settled(t))
    save(run, "rui-esc-then-prompt", {
      ...captured["rui-esc-then-prompt"]!,
      screenAfterEsc: afterEsc,
      novadeckSeesAfterEsc: {
        activity: detailAfterEsc.activity,
        requests: detailAfterEsc.requests,
      },
      hooksAfterEsc,
      rolloutAfterEsc,
      // To the second: the milliseconds vary run to run, a held request would not.
      requestSettledAfterMs: Math.round(settledAfterMs / 1000) * 1000,
      screenAfterPrompt: afterPrompt,
      hooksFinal: hookLines(hooks),
      rolloutFinal: interesting(rollout(run)),
      modelSaw: modelSaw(run),
    })
  })

  it("request_user_input: none of the above with notes answers it (the model carries on)", async ({
    e2e: run,
  }) => {
    run.model.use(
      ...script("Ask me about the button", () => ({
        calls: [{ name: "request_user_input", input: questions }],
      })),
    )
    const hooks = probe(run)
    const t = await open(run, "--enable default_mode_request_user_input")
    await t.prompt("Ask me about the button")
    await waitScreen(t, /Which color should the button be/)
    const steps: Json[] = []
    for (const [label, key] of [
      ["down", "\x1b[B"],
      ["down", "\x1b[B"],
      ["tab", "\t"],
    ] as const) {
      t.press(key)
      // eslint-disable-next-line no-await-in-loop -- The keys are pressed in turn.
      await sleep(600)
      // eslint-disable-next-line no-await-in-loop -- As above.
      steps.push({ label, key, screen: rows(await settled(t)) })
    }
    await t.submit("I want purple, not these")
    await sleep(3000)
    const done = rows(await settled(t))
    save(run, "rui-none-of-the-above-notes", {
      steps,
      screenAfterEnter: done,
      hooksAll: hookLines(hooks),
      rolloutAfter: interesting(rollout(run)),
      toolOutputSeenByModel: lastTool(run) ?? null,
      modelSaw: modelSaw(run),
    })
  })
})

// ---------------------------------------------------------------- (H) the hook route

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits for the probe hook of `event` to have started, and returns its pid. */
const started = (hooks: Probe, event: string, nth = 0) =>
  poll(() => {
    const lines = hooks.log().filter((line) => line.kind === "start" && line.event === event)
    return lines[nth] ? (lines[nth]!.pid as number) : undefined
  }, `the ${event} hook to start`)

type Step = (ctx: { t: DeckTerminal; hooks: Probe; run: E2E; pid: number }) => Promise<void>

/**
 * With the PermissionRequest hook holding (`wait` mode) it runs `prompt`, and watches what
 * Codex shows and Novadeck sees while the hook is pending, then does `after`, and watches
 * the outcome.
 */
const pending = async (
  run: E2E,
  name: string,
  options: {
    readonly prompt: string
    readonly timeout?: number
    readonly after: Step
    readonly watchMs?: number
    readonly flags?: string
    readonly before?: (t: DeckTerminal) => Promise<void>
    readonly event?: string
    readonly mode?: "wait" | "wait-pre"
  },
) => {
  const hooks = probe(run, options.timeout)
  hooks.mode(options.mode ?? "wait")
  const t = await open(run, options.flags)
  let pid = 0
  try {
    await options.before?.(t)
    await t.prompt(options.prompt)
    pid = await started(hooks, options.event ?? "PermissionRequest")
    const startedAt = Date.now()
    await sleep(options.watchMs ?? 3000)
    const duringScreen = rows(await t.screen())
    const duringDetail = await t.detail()
    const during = {
      screen: duringScreen,
      novadeckRequests: duringDetail.requests,
      novadeckActivity: duringDetail.activity,
      hookAlive: alive(pid),
      rolloutTypes: interesting(rollout(run)).map(
        (r) => `${r.type}:${(r.payload as Json).type}:${(r.payload as Json).name ?? ""}`,
      ),
    }
    await options.after({ t, hooks, run, pid })
    await sleep(3000)
    const after = rows(await t.screen())
    save(run, name, {
      during,
      screenAfter: after,
      hookAliveAfter: alive(pid),
      hooks: hooks.log().map((line) => ({
        t: (line.t as number) - startedAt,
        kind: line.kind,
        event: line.event,
        ...(line.answer ? { answer: line.answer } : {}),
        ...(line.kind === "start" &&
        line.event !== "SessionStart" &&
        line.event !== "UserPromptSubmit"
          ? { payload: line.payload }
          : {}),
      })),
      rollout: interesting(rollout(run)),
      toolOutputSeenByModel: lastTool(run) ?? null,
      wrote: existsSync(join(run.sandbox.project, "probe-out.txt")),
    })
  } finally {
    // A hook still waiting would outlive the deck: let it go.
    if (pid && alive(pid)) {
      hooks.answer({ stdout: "" })
      await sleep(1500)
    }
  }
}

const deny = (message: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message },
    },
  })

describe.skipIf(!supported)("Codex pending PermissionRequest hook (probe)", () => {
  const rules = () => script("Run the command", exec("echo approved > probe-out.txt"))
  const allow = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" },
    },
  })

  it("hook allows after a wait", async ({ e2e: run }) => {
    run.model.use(...rules())
    await pending(run, "hook-allow", {
      prompt: "Run the command",
      after: async ({ hooks }) => hooks.answer({ stdout: allow }),
    })
  })

  it("hook denies with a reason after a wait", async ({ e2e: run }) => {
    run.model.use(...rules())
    await pending(run, "hook-deny", {
      prompt: "Run the command",
      after: async ({ hooks }) => hooks.answer({ stdout: deny("The chat said: not today") }),
    })
  })

  it("hook exits 2 with a reason", async ({ e2e: run }) => {
    run.model.use(...rules())
    await pending(run, "hook-exit2", {
      prompt: "Run the command",
      after: async ({ hooks }) => hooks.answer({ stderr: "Refused from the chat", exit: 2 }),
    })
  })

  it("hook returns no decision after a wait", async ({ e2e: run }) => {
    run.model.use(...rules())
    await pending(run, "hook-no-decision", {
      prompt: "Run the command",
      after: async ({ hooks }) => hooks.answer({ stdout: "" }),
    })
  })

  it("hook asks for session scope (updatedPermissions) as a way to approve for the session", async ({
    e2e: run,
  }) => {
    run.model.use(...rules())
    await pending(run, "hook-allow-with-updatedPermissions", {
      prompt: "Run the command",
      after: async ({ hooks }) =>
        hooks.answer({
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: {
                behavior: "allow",
                updatedPermissions: [{ type: "session" }],
              },
            },
          }),
        }),
    })
  })

  it("hook times out (8 s) with nobody answering", async ({ e2e: run }) => {
    run.model.use(...rules())
    await pending(run, "hook-timeout", {
      prompt: "Run the command",
      timeout: 8,
      watchMs: 11_000,
      after: async ({ t }) => {
        // What the person sees now: whatever Codex fell back to.
        await waitScreen(t, /Would you like to run the following command|Finished/, 20_000).catch(
          () => "",
        )
      },
    })
  })

  it("the person presses y in the TUI while the hook waits, then the hook answers", async ({
    e2e: run,
  }) => {
    run.model.use(...rules())
    await pending(run, "hook-person-presses-y", {
      prompt: "Run the command",
      after: async ({ t, hooks }) => {
        t.press("y")
        await sleep(1500)
        hooks.answer({ stdout: allow })
      },
    })
  })

  it("the person presses Esc in the TUI while the hook waits", async ({ e2e: run }) => {
    run.model.use(...rules())
    await pending(run, "hook-person-presses-esc", {
      prompt: "Run the command",
      after: async ({ t, hooks }) => {
        t.press("\x1b")
        await sleep(3000)
        // A late answer from the chat, after the turn was interrupted.
        hooks.answer({ stdout: allow })
      },
    })
  })

  it("the hook allows and the wait sees Novadeck's own hooks too (request visible to Novadeck)", async ({
    e2e: run,
  }) => {
    run.model.use(...rules())
    await pending(run, "hook-novadeck-view", {
      prompt: "Run the command",
      watchMs: 4000,
      after: async ({ hooks }) => hooks.answer({ stdout: allow }),
    })
  })
})

// ---------------------------------------------------------------- more surfaces and risks

const planQuestions = {
  questions: [
    {
      id: "color",
      header: "Color",
      question: "Which color should the button be?",
      options: [
        { label: "Blue (Recommended)", description: "The house color." },
        { label: "Green", description: "Calmer." },
      ],
    },
  ],
}

describe.skipIf(!supported)("Codex more surfaces and risks (probe)", () => {
  const planMode = async (t: DeckTerminal) => {
    await t.submit("/plan")
    await waitScreen(t, /Plan mode/)
    await settled(t)
  }

  it("a long, multi-line command at 120x40 and 60x20", async ({ e2e: run }) => {
    const long = `echo ${"x".repeat(90)} && echo ${"y".repeat(90)}\\\n && echo second line of a long command && printf '%s' ${"z".repeat(60)} > probe-out.txt`
    run.model.use(...script("Run the command", exec(long)))
    await surface(run, "exec-long-command", {
      prompt: "Run the command",
      shows: /Would you like to run the following command/,
      keys: [["n", "n"]],
    })
  })

  // Codex asks for the two in either order, run to run, so this scenario's record may
  // swap them between recordings with nothing changed.
  it("two approvals queued: one y, then y again", async ({ e2e: run }) => {
    run.model.use(
      ...script("Run both", () => ({
        calls: [
          ...exec("echo first > probe-first.txt")().calls,
          ...exec("echo second > probe-second.txt")().calls,
        ],
      })),
    )
    await surface(run, "exec-two-queued", {
      prompt: "Run both",
      shows: /Would you like to run the following command/,
      keys: [
        ["y (first)", "y"],
        ["y (second)", "y"],
      ],
    })
  })

  it("y with no dialog up lands in the composer", async ({ e2e: run }) => {
    const hooks = probe(run)
    run.model.use((call) => (asked(call, "Say hi") ? { text: "Hi." } : undefined))
    const t = await open(run)
    await t.prompt("Say hi")
    await t.until("Hi.")
    await sleep(1500)
    t.press("y")
    await sleep(800)
    save(run, "y-with-no-dialog", {
      screen: rows(await settled(t)),
      hooks: hookLines(hooks).length,
    })
  })

  it("request_permissions tool", async ({ e2e: run }) => {
    run.model.use(
      ...script("Ask for permission", () => ({
        calls: [
          {
            name: "request_permissions",
            input: {
              reason: "Need network for the build",
              permissions: { network: { enabled: true } },
            },
          },
        ],
      })),
    )
    await surface(run, "request-permissions", {
      flags: "--enable request_permissions_tool",
      prompt: "Ask for permission",
      shows: /Would you like to grant|grant these permissions|permissions/i,
      keys: [["y", "y"]],
    })
  })

  it("the plan prompt after a plan in Plan mode", async ({ e2e: run }) => {
    run.model.use((call) =>
      asked(call, "Plan the button")
        ? {
            text: "<proposed_plan>\n# Button plan\n\n- Make it blue\n- Ship it\n</proposed_plan>",
          }
        : undefined,
    )
    await surface(run, "plan-prompt", {
      before: planMode,
      prompt: "Plan the button",
      shows: /Implement this plan/,
      keys: [["esc", "\x1b"]],
    })
  })

  it("the plan prompt answered with a digit", async ({ e2e: run }) => {
    run.model.use((call) =>
      asked(call, "Plan the button")
        ? {
            text: "<proposed_plan>\n# Button plan\n\n- Make it blue\n</proposed_plan>",
          }
        : undefined,
    )
    await surface(run, "plan-prompt-digit-3", {
      before: planMode,
      prompt: "Plan the button",
      shows: /Implement this plan/,
      keys: [["3", "3"]],
    })
  })

  it("request_user_input: the PreToolUse hook holds, then blocks with the answer as its reason", async ({
    e2e: run,
  }) => {
    run.model.use(
      ...script("Ask me about the button", () => ({
        calls: [{ name: "request_user_input", input: planQuestions }],
      })),
    )
    await pending(run, "hook-rui-pretooluse-block", {
      mode: "wait-pre",
      event: "PreToolUse",
      before: planMode,
      prompt: "Ask me about the button",
      after: async ({ hooks }) =>
        hooks.answer({
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: 'The person answered question "color": Green',
            },
          }),
        }),
    })
  })
})

// ---------------------------------------------------------------- MCP

// A stdio MCP server of the probe's own: `touch` runs at once, `ask_color` asks the
// person through elicitation/create (a form) before it answers.
const mcpServer = `
import { createInterface } from "node:readline"
const out = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n")
let next = 1000
const waiting = new Map()
const tools = [
  { name: "touch", description: "Touches a file.", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
  { name: "ask_color", description: "Asks the person for a color.", inputSchema: { type: "object", properties: {} } },
]
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line)
  if (message.method === undefined) return waiting.get(message.id)?.(message)
  const reply = (result) => out({ id: message.id, result })
  if (message.method === "initialize")
    return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } })
  if (message.method === "tools/list") return reply({ tools })
  if (message.method === "tools/call") {
    if (message.params.name === "touch") return reply({ content: [{ type: "text", text: "touched " + (message.params.arguments?.name ?? "") }] })
    const id = next++
    waiting.set(id, (answer) => reply({ content: [{ type: "text", text: "elicitation answered: " + JSON.stringify(answer.result ?? answer.error) }] }))
    return out({ id, method: "elicitation/create", params: { message: "Which color do you want?", requestedSchema: { type: "object", properties: { color: { type: "string", title: "Color", enum: ["blue", "green"] } }, required: ["color"] } } })
  }
  if (message.id !== undefined) out({ id: message.id, result: {} })
})
`

const withMcp = (run: E2E, approval: "prompt" | "approve") => {
  const dir = join(run.sandbox.root, "mcp")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "server.mjs"), mcpServer)
  appendFileSync(
    join(run.sandbox.home, ".codex", "config.toml"),
    `\n[mcp_servers.probe]\ncommand = "node"\nargs = [${JSON.stringify(join(dir, "server.mjs"))}]\ndefault_tools_approval_mode = "${approval}"\n`,
  )
}

describe.skipIf(!supported)("Codex MCP asks (probe)", () => {
  it("MCP tool approval (approval mode prompt)", async ({ e2e: run }) => {
    withMcp(run, "prompt")
    run.model.use(
      ...script("Touch it", () => ({
        calls: [{ name: "mcp__probe.touch", input: { name: "a.txt" } }],
      })),
    )
    await surface(run, "mcp-tool-approval", {
      prompt: "Touch it",
      shows: /Allow this request|Allow the|probe/,
      keys: [["1 (allow)", "1"]],
    })
  })

  it("MCP tool approval, declined with Esc", async ({ e2e: run }) => {
    withMcp(run, "prompt")
    run.model.use(
      ...script("Touch it", () => ({
        calls: [{ name: "mcp__probe.touch", input: { name: "a.txt" } }],
      })),
    )
    await surface(run, "mcp-tool-approval-esc", {
      prompt: "Touch it",
      shows: /Allow this request|Allow the|probe/,
      keys: [["esc", "\x1b"]],
    })
  })

  it("MCP elicitation form from the server", async ({ e2e: run }) => {
    withMcp(run, "approve")
    run.model.use(
      ...script("Ask the server", () => ({
        calls: [{ name: "mcp__probe.ask_color", input: {} }],
      })),
    )
    await surface(run, "mcp-elicitation", {
      prompt: "Ask the server",
      shows: /Which color do you want/,
      keys: [["2", "2"]],
    })
  })

  it("MCP tool approval held by a PermissionRequest hook, then allowed", async ({ e2e: run }) => {
    withMcp(run, "prompt")
    run.model.use(
      ...script("Touch it", () => ({
        calls: [{ name: "mcp__probe.touch", input: { name: "a.txt" } }],
      })),
    )
    await pending(run, "hook-mcp-allow", {
      prompt: "Touch it",
      after: async ({ hooks }) =>
        hooks.answer({
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: { behavior: "allow" },
            },
          }),
        }),
    })
  })
})

// ---------------------------------------------------------------- request_user_input_async

// request_user_input_async: the question tool Codex offers outside Plan mode (seen from
// 0.162.1). It returns {"accepted":true} at once and the turn goes on; the person's answer
// arrives later as a user message, <send_user_message_question_reply>. Novadeck's own
// PreToolUse matcher is registered beside the probe's (it fires for it only once the tool is named: matchers match the whole name).
const novadeckMatcher = "request_user_input|request_permissions|request_user_input_async"
const asyncQuestions = {
  questions: [{ title: "Which color should the button be?", options: ["Blue", "Green"] }],
}

describe.skipIf(!supported)("Codex request_user_input_async (probe)", () => {
  it("rui-async: offered, called, the turn ends with it up", async ({ e2e: run }) => {
    run.model.use(
      ...script("Ask me about the button", () => ({
        calls: [{ name: "request_user_input_async", input: asyncQuestions }],
      })),
    )
    const hooks = probe(run, 600, novadeckMatcher)
    const t = await open(run)
    await t.prompt("Ask me about the button")
    await t.until("Finished the request.", 30_000)
    await sleep(1500)
    const first = run.model.calls.find((call) => !call.side)
    const detail = await t.detail()
    save(run, "rui-async-offered", {
      offered: first?.tools.filter((name) => /request_user_input|question|ask/i.test(name)) ?? [],
      rawTool:
        (first?.rawTools ?? []).find(
          (tool) => (tool as Json).name === "request_user_input_async",
        ) ?? null,
      screens: await shoot(t),
      novadeckSees: { activity: detail.activity, requests: detail.requests },
      hooksAll: hookLines(hooks),
      rollout: interesting(rollout(run)),
      toolOutputSeenByModel: lastTool(run) ?? null,
    })
  })

  // The person answers by typing in the composer once the turn has ended.
  it("rui-async: typed in the composer after the turn ends", async ({ e2e: run }) => {
    run.model.use(
      ...script("Ask me about the button", () => ({
        calls: [{ name: "request_user_input_async", input: asyncQuestions }],
      })),
      (call) => (!call.side && asked(call, "Green please") ? { text: "Going green." } : undefined),
    )
    const hooks = probe(run, 600, novadeckMatcher)
    const t = await open(run)
    await t.prompt("Ask me about the button")
    await t.until("Finished the request.", 30_000)
    await sleep(1000)
    const before = hookLines(hooks).length
    const steps: Json[] = []
    for (const [label, key] of [
      ["up", "\x1b[A"],
      ["tab", "\t"],
      ["esc", "\x1b"],
    ] as const) {
      t.press(key)
      // eslint-disable-next-line no-await-in-loop -- The keys are pressed in turn.
      await sleep(800)
      // eslint-disable-next-line no-await-in-loop -- As above.
      steps.push({ label, key, screen: rows(await settled(t)) })
    }
    await t.prompt("Green please")
    await t.until("Going green.", 30_000)
    await sleep(1500)
    save(run, "rui-async-typed-after", {
      steps,
      screen: rows(await settled(t)),
      hooksAfterQuestion: hookLines(hooks).slice(before),
      rollout: interesting(rollout(run)),
      modelSaw: modelSaw(run).at(-1) ?? null,
    })
  })

  // The model holds its turn (a slow answer) while the question is up: what shows, and
  // what a prompt typed meanwhile becomes.
  it("rui-async: answered while the turn runs", async ({ e2e: run }) => {
    run.model.use(
      (call) =>
        !call.side && asked(call, "Ask me about the button") && call.turns.at(-1)?.role === "user"
          ? { calls: [{ name: "request_user_input_async", input: asyncQuestions }] }
          : undefined,
      async (call) => {
        const last = call.turns.at(-1)
        if (call.side || last?.role !== "tool" || !/accepted/.test(last.text)) return undefined
        await sleep(15_000)
        return { text: "Finished the request." }
      },
      (call) => (!call.side && asked(call, "Green please") ? { text: "Going green." } : undefined),
    )
    const hooks = probe(run, 600, novadeckMatcher)
    const t = await open(run)
    await t.prompt("Ask me about the button")
    await t.until("Which color should the button be?", 30_000)
    await sleep(2000)
    const during = rows(await settled(t))
    const detail = await t.detail()
    await t.submit("Green please")
    await sleep(1500)
    const afterTyping = rows(await settled(t))
    await t.until(/Going green\.|Finished the request\./, 40_000)
    await sleep(3000)
    save(run, "rui-async-while-running", {
      during,
      novadeckSeesDuring: { activity: detail.activity, requests: detail.requests },
      afterTyping,
      screen: rows(await settled(t)),
      hooksAll: hookLines(hooks),
      rollout: interesting(rollout(run)),
      modelSaw: modelSaw(run),
    })
  })

  // Its answer panel, opened with shift+left while the question is pending, then steps in
  // turn (a key, or a key then Enter once `shows` draws again): each step's screen, then
  // what the model and hooks get once the held turn ends and its queue goes in.
  type Press = readonly [label: string, key: string, shows?: RegExp]
  const shiftLeft = "\x1b[1;2D"
  const answering = (
    name: string,
    steps: readonly Press[],
    options: {
      readonly holdMs?: number
      readonly afterTurn?: boolean
      readonly two?: boolean
      readonly free?: boolean
    } = {},
  ) =>
    it(`rui-async: panel ${name}`, async ({ e2e: run }) => {
      const input = options.two
        ? { questions: [...asyncQuestions.questions, { title: "What should its label say?" }] }
        : options.free
          ? { questions: [{ title: "What should its label say?" }] }
          : asyncQuestions
      run.model.use(
        (call) =>
          !call.side && asked(call, "Ask me about the button") && call.turns.at(-1)?.role === "user"
            ? { calls: [{ name: "request_user_input_async", input }] }
            : undefined,
        async (call) => {
          const last = call.turns.at(-1)
          if (call.side || last?.role !== "tool" || !/accepted/.test(last.text)) return undefined
          await sleep(options.holdMs ?? 20_000)
          return { text: "Finished the request." }
        },
        (call) => {
          const last = call.turns.at(-1)
          return !call.side && last?.role === "user" && /question_reply/.test(last.text)
            ? { text: "Thanks for the answer." }
            : undefined
        },
      )
      const hooks = probe(run, 600, novadeckMatcher)
      const t = await open(run)
      await t.prompt("Ask me about the button")
      await t.until(
        options.free ? "What should its label say?" : "Which color should the button be?",
        30_000,
      )
      if (options.afterTurn) await t.until("Finished the request.", 30_000)
      await sleep(1500)
      const before = rows(await settled(t))
      const shown: Json[] = []
      for (const [label, key, shows] of steps) {
        try {
          // eslint-disable-next-line no-await-in-loop -- The steps go in turn.
          if (shows) await t.confirm(shows, async () => key && t.press(key), { timeoutMs: 8000 })
          else t.press(key)
        } catch (error) {
          shown.push({ label, failed: String(error).split("\n")[0] })
        }
        // eslint-disable-next-line no-await-in-loop -- As above.
        await sleep(900)
        // eslint-disable-next-line no-await-in-loop -- As above.
        shown.push({ label, screen: rows(await settled(t)) })
      }
      const answered = await t
        .until(/Thanks for the answer\./, 40_000)
        .then(() => true)
        .catch(() => false)
      await sleep(2000)
      save(run, `rui-async-panel-${name}`, {
        before,
        steps: shown,
        answered,
        screen: rows(await settled(t)),
        hooksAll: hookLines(hooks),
        rollout: interesting(rollout(run)),
        modelSaw: modelSaw(run).map((turns) => turns.at(-1)),
      })
    })

  answering("enter", [["shift+left, enter", shiftLeft, /enter submit/]])
  answering("down-enter", [
    ["shift+left", shiftLeft],
    ["down, enter", "\x1b[B", /› 2\. Green/],
  ])
  answering("digit-2", [
    ["shift+left", shiftLeft],
    ["2", "2"],
  ])
  answering("esc", [
    ["shift+left", shiftLeft],
    ["esc", "\x1b"],
  ])
  answering("skip", [
    ["shift+left", shiftLeft],
    ["ctrl+]", "\x1d"],
  ])
  answering("other-text", [
    ["shift+left", shiftLeft],
    ["3", "3"],
    ["Purple, enter", "Purple", /Purple/],
  ])
  // The words typed with the Other row highlighted, then Enter (confirm types them, waits
  // for them to show, and presses it), with the turn held long enough that none of it
  // races the turn's end. The screens before Enter are those of the words' own steps.
  answering(
    "other-typed",
    [
      ["shift+left", shiftLeft],
      ["3", "3"],
      ["Purple, enter", "Purple", /Purple/],
    ],
    { holdMs: 60_000 },
  )
  // What the words look like before Enter, for a reader of the screen to wait on.
  answering(
    "other-words",
    [
      ["shift+left", shiftLeft],
      ["3", "3"],
      ["Purple", "Purple"],
    ],
    { holdMs: 30_000 },
  )
  answering(
    "free-words",
    [
      ["shift+left", shiftLeft],
      ["Large", "Large"],
    ],
    {
      holdMs: 30_000,
      free: true,
    },
  )
  // The same with the words pasted, as the driver's `type` step writes them.
  answering(
    "other-pasted",
    [
      ["shift+left", shiftLeft],
      ["3", "3"],
      ["Purple, enter", "\x1b[200~Purple\x1b[201~", /Purple/],
    ],
    { holdMs: 60_000 },
  )
  // A question with no options: its field, the words typed in it, then Enter.
  answering(
    "free-text",
    [
      ["shift+left", shiftLeft],
      ["Large, enter", "Large", /Large/],
    ],
    { holdMs: 60_000, free: true },
  )
  // The first of two answered with Other's words: does the second follow at once?
  answering(
    "two-other",
    [
      ["shift+left", shiftLeft],
      ["3", "3"],
      ["Purple, enter", "Purple", /Purple/],
      ["Large, enter", "Large", /Large/],
    ],
    { holdMs: 60_000, two: true },
  )
  answering(
    "two-questions",
    [
      ["shift+left", shiftLeft],
      ["1", "1"],
      ["Large, enter", "Large", /Large/],
    ],
    { two: true },
  )
  answering("after-turn", [["shift+left, enter", shiftLeft, /enter submit/]], {
    afterTurn: true,
    holdMs: 1000,
  })
})
