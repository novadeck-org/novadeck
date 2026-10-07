import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { screenRecord } from "../../testing/probes.js"
import { agy } from "../agents/agy.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, expect, supported, type E2E } from "../fixture.js"
import { gemini } from "../model/gemini.js"
import { asked, type Call, type Reply, type Rule } from "../model/script.js"
import { own, start } from "../scenarios.js"

// PROBE, not a regression test: what Antigravity's interactive TUI shows when it waits on
// the person (a command's confirmation, ask_question, plan feedback), which hooks fire,
// what its transcript and status line say meanwhile, and whether a hook can answer.
// Everything it sees goes to a folder (AGY_PROBE_OUT, default <tmp>/agy-probe), one file
// per scenario, for the report; the assertions only keep a probe from passing silently.
// Run: NOVADECK_E2E_AGENTS=agy pnpm --filter @novadeck/runner exec vitest run \
//   --config vitest.e2e.config.ts src/e2e/probes/agy-ask.e2e.ts

const out = process.env.AGY_PROBE_OUT ?? join(tmpdir(), "agy-probe")
mkdirSync(out, { recursive: true })

/** The raw bodies of every model request, so a tool's declaration can be read as sent. */
const raw: { path: string; body: unknown }[] = []
const recording = {
  ...agy,
  dialect: {
    ...gemini,
    handle: (
      request: Parameters<typeof gemini.handle>[0],
      reply: Parameters<typeof gemini.handle>[1],
    ) => {
      try {
        raw.push({ path: request.path, body: JSON.parse(request.body || "{}") })
      } catch {
        // Not JSON.
      }
      return gemini.handle(request, reply)
    },
  },
}

const save = (name: string, value: unknown): void =>
  writeFileSync(join(out, name), typeof value === "string" ? value : JSON.stringify(value, null, 2))

// The probe hook: logs its event and stdin with times; for PreToolUse, waits while a
// `hold` file exists (until `release` appears or `answer` does), then prints `answer`,
// else `default`, else {"decision":"ask"}. Other events print {}.
const hookScript = (dir: string): string => `#!/bin/sh
P=${dir}
ev="$1"
in=$(cat)
now() { date +%s.%N; }
printf '{"t":%s,"phase":"start","event":"%s","in":%s,"pid":%s,"ppid":%s}\\n' "$(now)" "$ev" "$in" "$$" "$PPID" >> "$P/hooks.jsonl"
if [ "$ev" = "PreToolUse" ]; then
  tool=$(printf '%s' "$in" | sed -n 's/.*"name":"\\([^"]*\\)".*/\\1/p' | head -1)
  if [ -f "$P/hold" ]; then
    while [ -f "$P/hold" ] && [ ! -f "$P/release" ]; do sleep 0.1; done
  fi
  if [ -f "$P/answer" ]; then out=$(cat "$P/answer");
  elif [ -f "$P/default" ]; then out=$(cat "$P/default");
  else out='{"decision":"ask"}'; fi
else
  out='{}'
fi
printf '{"t":%s,"phase":"end","event":"%s","out":%s}\\n' "$(now)" "$ev" "$(printf '%s' "$out" | sed 's/$/ /' | tr -d '\\n' | sed 's/ *$//')" >> "$P/hooks.jsonl"
printf '%s' "$out"
`

type Probe = {
  readonly dir: string
  readonly set: (file: "hold" | "release" | "answer" | "default", content?: string) => void
  readonly clear: (file: "hold" | "release" | "answer" | "default") => void
  readonly hooks: () => Record<string, unknown>[]
}

/**
 * Registers the probe hook for every event in the project's .agents/hooks.json, and tees
 * the status line's input into status.jsonl, before any terminal starts.
 */
const prepare = (
  run: E2E,
  { timeout = 30, alone = false }: { timeout?: number; alone?: boolean } = {},
): Probe => {
  const dir = join(run.sandbox.root, "probe")
  mkdirSync(dir, { recursive: true })
  const script = join(dir, "hook.sh")
  writeFileSync(script, hookScript(dir), { mode: 0o755 })
  const handler = (event: string) => ({ type: "command", command: `${script} ${event}`, timeout })
  mkdirSync(join(run.sandbox.project, ".agents"), { recursive: true })
  writeFileSync(
    join(run.sandbox.project, ".agents", "hooks.json"),
    JSON.stringify({
      probe: {
        PreToolUse: [{ matcher: "*", hooks: [handler("PreToolUse")] }],
        PostToolUse: [{ matcher: "*", hooks: [handler("PostToolUse")] }],
        PreInvocation: [handler("PreInvocation")],
        PostInvocation: [handler("PostInvocation")],
        Stop: [handler("Stop")],
      },
    }),
  )
  // The status line command Novadeck connected, with its input also appended to a file.
  const settings = join(run.sandbox.home, ".gemini", "antigravity-cli", "settings.json")
  const json = JSON.parse(readFileSync(settings, "utf8")) as { statusLine?: { command?: string } }
  if (json.statusLine?.command)
    json.statusLine.command = `tee -a ${dir}/status.jsonl | (${json.statusLine.command})`
  writeFileSync(settings, JSON.stringify(json, null, 2))
  save("settings.json", json)
  // What Novadeck installed: its plugin's hook registration, for the report.
  const plugins = join(run.sandbox.home, ".gemini", "config", "plugins")
  save("plugins.txt", spawnSync("find", [plugins, "-maxdepth", "3"], { encoding: "utf8" }).stdout)
  for (const file of spawnSync("find", [plugins, "-name", "hooks.json"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean)) {
    save(`plugin-${file.split("/").slice(-3).join("_")}`, readFileSync(file, "utf8"))
    // The Novadeck hook can be switched off for a scenario, to see a lone probe hook decide.
    if (alone) writeFileSync(file, "{}")
  }
  return {
    dir,
    set: (file, content = "") => writeFileSync(join(dir, file), content),
    clear: (file) => {
      try {
        unlinkSync(join(dir, file))
      } catch {
        // Already gone.
      }
    },
    hooks: () => {
      const file = join(dir, "hooks.jsonl")
      if (!existsSync(file)) return []
      return readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as Record<string, unknown>]
          } catch {
            return [{ unparsed: line }]
          }
        })
    },
  }
}

/** The status line inputs seen so far, consecutive repeats of what matters dropped. */
const statuses = (probe: Probe): Record<string, unknown>[] => {
  const file = join(probe.dir, "status.jsonl")
  if (!existsSync(file)) return []
  const seen: Record<string, unknown>[] = []
  let last = ""
  // The inputs come back to back, not one to a line.
  for (const line of readFileSync(file, "utf8")
    .split(/(?<=\})(?=\{)/)
    .filter(Boolean)) {
    try {
      const one = JSON.parse(line) as Record<string, unknown>
      const {
        quota: _q,
        context_window: _c,
        transcript_path: _t,
        cwd: _w,
        workspace: _ws,
        ...rest
      } = one
      const key = JSON.stringify(rest)
      if (key !== last) seen.push(rest)
      last = key
    } catch {
      // A partial line.
    }
  }
  return seen
}

const transcriptOf = (probe: Probe): unknown[] => {
  const path = probe
    .hooks()
    .map((one) => (one.in as { transcriptPath?: string } | undefined)?.transcriptPath)
    .find((one) => one !== undefined)
  if (!path) return []
  const full = path.replace(/transcript\.jsonl$/, "transcript_full.jsonl")
  if (!existsSync(full)) return []
  return readFileSync(full, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
}

// The screen once it has stayed the same for `forMs`, or as it is after 6 s of animation
// (a spinner never lets it settle).
const calm = async (terminal: DeckTerminal, forMs = 1200): Promise<string> => {
  let last = { shown: "", since: Date.now() }
  const deadline = Date.now() + 6000
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- Sampled one after another.
    const shown = await terminal.screen()
    if (shown !== last.shown) last = { shown, since: Date.now() }
    if (Date.now() - last.since >= forMs || Date.now() > deadline) return shown
    // eslint-disable-next-line no-await-in-loop -- As above.
    await sleep(100)
  }
}

/** The screen at 120x40, then at 60x20, then back. */
const looks = async (terminal: DeckTerminal): Promise<{ wide: string; small: string }> => {
  const wide = await calm(terminal)
  terminal.resize(60, 20)
  await sleep(500)
  const small = await calm(terminal)
  terminal.resize(120, 40)
  await sleep(500)
  await calm(terminal)
  return { wide, small }
}

const record = (name: string, extra: Record<string, unknown>): void => save(`${name}.json`, extra)

/** A reply calling a tool, once, for the first look at a prompt. */
const calls =
  (prompt: string, name: string, input: Record<string, unknown>): Rule =>
  (call: Call): Reply | undefined =>
    !call.side && asked(call, prompt) ? { calls: [{ name, input }] } : undefined

const after = (text: string): Rule =>
  own((call) => (call.turns.at(-1)?.role === "tool" ? { text } : undefined))

/** Everything seen of the terminal now, saved as <scenario>.<label>.json. */
const capture = async (
  scenario: string,
  label: string,
  terminal: DeckTerminal,
  probe: Probe,
  { sizes = true }: { sizes?: boolean } = {},
): Promise<{ wide: string; small: string }> => {
  const seen = sizes ? await looks(terminal) : { wide: await calm(terminal, 600), small: "" }
  const detail = await terminal.detail()
  save(`${scenario}.${label}.screen-120x40.json`, screenRecord(seen.wide, { columns: 120 }))
  if (sizes)
    save(`${scenario}.${label}.screen-60x20.json`, screenRecord(seen.small, { columns: 60 }))
  if (existsSync(join(probe.dir, "status.jsonl")))
    save(
      `${scenario}.${label}.status-raw.jsonl`,
      readFileSync(join(probe.dir, "status.jsonl"), "utf8"),
    )
  record(`${scenario}.${label}`, {
    requests: detail.requests,
    activity: terminal.summary().activity ?? null,
    status: statuses(probe).slice(-6),
    hooks: probe.hooks().map((one) => {
      const { in: input, ...rest } = one as { in?: Record<string, unknown> }
      const {
        transcriptPath: _t,
        artifactDirectoryPath: _a,
        workspacePaths: _w,
        ...kept
      } = input ?? {}
      return { ...rest, in: kept }
    }),
    transcript: transcriptOf(probe),
  })
  return seen
}

const makeFile = (cwd: string) =>
  calls("Make the file", "write_to_file", {
    TargetFile: join(cwd, "probe.txt"),
    Overwrite: false,
    CodeContent: "hello\n",
    Description: "Makes the file",
    toolSummary: "Make file",
    toolAction: "Making file",
  })

const question = (options: string[], multi = false) =>
  calls("Ask me", "ask_question", {
    questions: [{ question: "Which colour?", options, is_multi_select: multi }],
    toolSummary: "Colour question",
    toolAction: "Asking colour",
  })

const run = (cwd: string, command = "echo approved") =>
  calls("Run it", "run_command", {
    CommandLine: command,
    Cwd: cwd,
    WaitMsBeforeAsync: 5000,
    toolSummary: "Echo",
    toolAction: "Echoing",
  })

const surfaces = process.env.AGY_PROBE_ONLY?.split(",")
const wants = (name: string): boolean => !surfaces || surfaces.some((one) => name.startsWith(one))
// Surface 3: plan feedback, an artifact written with RequestFeedback.
const plan = (probe: Probe): Rule =>
  own((call) => {
    if (!asked(call, "Plan it")) return undefined
    const dir = probe
      .hooks()
      .map(
        (one) => (one.in as { artifactDirectoryPath?: string } | undefined)?.artifactDirectoryPath,
      )
      .find((one) => one !== undefined)
    if (!dir) throw new Error("no artifact directory seen yet")
    return {
      calls: [
        {
          name: "write_to_file",
          input: {
            TargetFile: join(dir, "implementation_plan.md"),
            Overwrite: true,
            CodeContent: "# Plan\n\n1. Do the thing\n2. Test the thing\n",
            Description: "Writes the plan",
            ArtifactMetadata: {
              Summary: "A plan to do and test the thing",
              UserFacing: true,
              RequestFeedback: true,
            },
            toolSummary: "Plan",
            toolAction: "Planning",
          },
        },
      ],
    }
  })

describe.skipIf(!supported)("Antigravity ask surfaces (probe)", () => {
  const it = e2e(recording)
  const cases: [string, (r: E2E) => Promise<void>][] = []
  const probeIt = (name: string, body: (r: E2E) => Promise<void>) => {
    if (wants(name)) it(name, async ({ e2e: r }) => body(r))
  }
  void cases

  probeIt("0-discovery", async (r) => {
    r.model.use(own((call) => (asked(call, "Hello probe") ? { text: "Hi." } : undefined)))
    prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Hello probe")
    await t1.until("Hi.")
    const turn = raw.findLast((one) => JSON.stringify(one.body).includes("Hello probe"))
    const tools =
      (turn?.body as { tools?: { functionDeclarations?: unknown[] }[] } | undefined)?.tools ?? []
    save(
      "tools.json",
      tools.flatMap((tool) => tool.functionDeclarations ?? []),
    )
    expect(tools.length).toBeGreaterThan(0)
  })

  // Surface 1: run_command's confirmation, answered by digit (no Enter) and by Enter.
  for (const [label, keys, resolves] of [
    ["1-digit", "1", "Made it."],
    ["2-digit", "2", "Made it."],
    ["3-digit", "3", "Made it."],
    ["4-digit", "4", "Made it."],
    ["esc", "\x1b", "Made it."],
  ] as const)
    probeIt(`1-command-${label}`, async (r) => {
      const name = `1-command-${label}`
      r.model.use(run(r.sandbox.project), after(resolves))
      const probe = prepare(r)
      const t1 = await start(r, agy)
      await t1.submit("Run it")
      await t1.until(agy.approval!.shows)
      await capture(name, "pending", t1, probe, { sizes: label === "1-digit" })
      t1.press(keys)
      await sleep(4000)
      await capture(name, "after", t1, probe, { sizes: false })
    })

  probeIt("1-command-enter", async (r) => {
    const name = "1-command-enter"
    r.model.use(run(r.sandbox.project), after("Made it."))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Run it")
    await t1.until(agy.approval!.shows)
    t1.press("\x1b[B")
    await t1.until(/> 2\. Yes, and always/)
    // Enter, at the first option again.
    await t1.confirm(agy.approval!.shows, async () => t1.press("\x1b[A"))
    await sleep(4000)
    await capture(name, "after", t1, probe, { sizes: false })
  })

  probeIt("1-command-down-enter", async (r) => {
    const name = "1-command-down-enter"
    r.model.use(run(r.sandbox.project), after("Made it."))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Run it")
    await t1.until(agy.approval!.shows)
    await t1.confirm(/> 4\. No, cancel/, async () => {
      for (const _ of [1, 2, 3]) t1.press("\x1b[B")
    })
    await sleep(4000)
    await capture(name, "after", t1, probe, { sizes: false })
  })

  // Surface 1b: write_to_file of a plain file.
  for (const [label, keys] of [
    ["1-digit", "1"],
    ["4-digit", "4"],
  ] as const)
    probeIt(`1-write-${label}`, async (r) => {
      const name = `1-write-${label}`
      r.model.use(makeFile(r.sandbox.project), after("Made it."))
      const probe = prepare(r)
      const t1 = await start(r, agy)
      await t1.submit("Make the file")
      await sleep(5000)
      await capture(name, "pending", t1, probe, { sizes: label === "1-digit" })
      t1.press(keys)
      await sleep(4000)
      await capture(name, "after", t1, probe, { sizes: false })
    })

  // Surface 2: ask_question.
  probeIt("2-ask-pending", async (r) => {
    const name = "2-ask-pending"
    r.model.use(question(["Red", "Green", "Blue"]), after("Noted."))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Ask me")
    await sleep(6000)
    await capture(name, "pending", t1, probe)
  })

  for (const [label, keys] of [
    ["1", "1"],
    ["2", "2"],
  ] as const)
    probeIt(`2-ask-key-${label}`, async (r) => {
      const name = `2-ask-key-${label}`
      r.model.use(question(["Red", "Green", "Blue"]), after("Noted."))
      const probe = prepare(r)
      const t1 = await start(r, agy)
      await t1.submit("Ask me")
      await sleep(5000)
      t1.press(keys)
      await sleep(2500)
      await capture(name, "after-key", t1, probe, { sizes: false })
    })

  probeIt("2-ask-down-enter", async (r) => {
    const name = "2-ask-down-enter"
    r.model.use(question(["Red", "Green", "Blue"]), after("Noted."))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Ask me")
    await t1.until(/> 1\. Red/)
    await t1.confirm(/> 2\. Green/, async () => t1.press("\x1b[B"))
    await sleep(3000)
    await capture(name, "after", t1, probe, { sizes: false })
  })

  probeIt("2-ask-esc", async (r) => {
    const name = "2-ask-esc"
    r.model.use(question(["Red", "Green", "Blue"]), after("Noted."))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Ask me")
    await t1.until(/> 1\. Red/)
    t1.press("\x1b")
    await sleep(3000)
    await capture(name, "after", t1, probe, { sizes: false })
  })

  probeIt("2-ask-writein", async (r) => {
    const name = "2-ask-writein"
    r.model.use(question(["Red", "Green", "Blue"]), after("Noted."))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Ask me")
    await t1.until(/> 1\. Red/)
    await t1.confirm(/> 4\. Write-in/, async () => {
      for (const _ of [1, 2, 3]) t1.press("\x1b[B")
    })
    await sleep(1500)
    await capture(name, "writein-open", t1, probe, { sizes: false })
    await t1.submit("Purple")
    await sleep(3000)
    await capture(name, "after", t1, probe, { sizes: false })
  })

  probeIt("2-ask-writein-typed", async (r) => {
    const name = "2-ask-writein-typed"
    r.model.use(question(["Red", "Green", "Blue"]), after("Noted."))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Ask me")
    await t1.until(/> 1\. Red/)
    await t1.confirm(/> 4\. Write-in/, async () => {
      for (const _ of [1, 2, 3]) t1.press("\x1b[B")
    })
    await t1.until(/Your answer:/)
    t1.press("Purple")
    await sleep(1500)
    await capture(name, "typed", t1, probe, { sizes: false })
  })

  probeIt("3-plan-feedback-typed", async (r) => {
    const name = "3-plan-feedback-typed"
    const probe = prepare(r)
    r.model.use(plan(probe), after("Planned."), replies2("", "Reacted."))
    const t1 = await start(r, agy)
    await t1.submit("Plan it")
    await sleep(5000)
    t1.press("Use SQLite")
    await sleep(1500)
    await capture(name, "typed", t1, probe, { sizes: false })
  })

  probeIt("2-ask-multi", async (r) => {
    const name = "2-ask-multi"
    r.model.use(question(["Red", "Green", "Blue"], true), after("Noted."))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Ask me")
    await sleep(5000)
    await capture(name, "pending", t1, probe)
    t1.press(" ")
    await sleep(800)
    await capture(name, "space", t1, probe, { sizes: false })
    t1.press("\x1b[B")
    await sleep(500)
    t1.press(" ")
    await sleep(800)
    await capture(name, "space2", t1, probe, { sizes: false })
    t1.press("2")
    await sleep(800)
    await capture(name, "digit2", t1, probe, { sizes: false })
  })

  probeIt("2-ask-two", async (r) => {
    const name = "2-ask-two"
    r.model.use(
      calls("Ask me", "ask_question", {
        questions: [
          { question: "Which colour?", options: ["Red", "Green"], is_multi_select: false },
          { question: "Which size?", options: ["Small", "Large"], is_multi_select: false },
        ],
        toolSummary: "Two questions",
        toolAction: "Asking two",
      }),
      after("Noted."),
    )
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Ask me")
    await t1.until(/Question 1\/2/)
    await capture(name, "q1", t1, probe, { sizes: false })
    await t1.confirm(/> 2\. Green/, async () => t1.press("\x1b[B"))
    await sleep(1500)
    await capture(name, "q2", t1, probe, { sizes: false })
    await t1.confirm(/> 2\. Large/, async () => t1.press("\x1b[B"))
    await sleep(2500)
    await capture(name, "after", t1, probe, { sizes: false })
  })

  for (const [label, keys] of [
    ["none", ""],
    ["1", "1"],
    ["esc", "\x1b"],
    ["2", "2"],
  ] as const)
    probeIt(`3-plan-${label}`, async (r) => {
      const name = `3-plan-${label}`
      const probe = prepare(r)
      r.model.use(plan(probe), after("Planned."))
      const t1 = await start(r, agy)
      await t1.submit("Plan it")
      await sleep(6000)
      await capture(name, "pending", t1, probe, { sizes: label === "none" })
      if (keys) {
        t1.press(keys)
        await sleep(3000)
        await capture(name, "after", t1, probe, { sizes: false })
      }
    })

  probeIt("3-plan-artifact", async (r) => {
    const name = "3-plan-artifact"
    const probe = prepare(r)
    r.model.use(plan(probe), after("Planned."), replies2("Go ahead", "Proceeding."))
    const t1 = await start(r, agy)
    await t1.submit("Plan it")
    await sleep(5000)
    await t1.submit("/artifact")
    await sleep(2500)
    await capture(name, "review", t1, probe)
    for (const [label, keys] of [
      ["down", "\x1b[B"],
      ["tab", "\t"],
    ] as const) {
      t1.press(keys)
      // eslint-disable-next-line no-await-in-loop -- The keys are pressed in turn.
      await sleep(1000)
      // eslint-disable-next-line no-await-in-loop -- As above.
      await capture(name, label, t1, probe, { sizes: false })
    }
    t1.press("\x1b")
    await sleep(1500)
    await capture(name, "esc", t1, probe, { sizes: false })
  })

  for (const [label, keys] of [
    ["y", "y"],
    ["n", "n"],
    ["p", "p"],
  ] as const)
    probeIt(`3-plan-review-${label}`, async (r) => {
      const name = `3-plan-review-${label}`
      const probe = prepare(r)
      r.model.use(plan(probe), after("Planned."), replies2("", "Reacted."))
      const t1 = await start(r, agy)
      await t1.submit("Plan it")
      await sleep(5000)
      await t1.submit("/artifact")
      await sleep(2000)
      t1.press(keys)
      await sleep(4000)
      await capture(name, "after", t1, probe, { sizes: false })
      save(
        `${name}.model.json`,
        r.model.calls.map((call) => ({
          side: call.side,
          last: call.turns
            .slice(-3)
            .map((turn) => ({ role: turn.role, text: turn.text.slice(0, 600) })),
        })),
      )
    })

  // Feedback as a plain prompt while the review is pending, without y or n.
  probeIt("3-plan-feedback-prompt", async (r) => {
    const name = "3-plan-feedback-prompt"
    const probe = prepare(r)
    r.model.use(plan(probe), after("Planned."), replies2("", "Reacted."))
    const t1 = await start(r, agy)
    await t1.submit("Plan it")
    await sleep(5000)
    await t1.submit("Use SQLite instead")
    await sleep(4000)
    await capture(name, "after", t1, probe, { sizes: false })
    save(
      `${name}.model.json`,
      r.model.calls.map((call) => ({
        side: call.side,
        last: call.turns
          .slice(-3)
          .map((turn) => ({ role: turn.role, text: turn.text.slice(0, 600) })),
      })),
    )
  })

  // Parity features: "chat about this" for ask_question, and "No, and tell it what to do".
  const modelLog = (r: E2E, name: string, label: string): void =>
    save(
      `${name}.${label}.model.json`,
      r.model.calls.map((call) => ({
        side: call.side,
        last: call.turns
          .slice(-2)
          .map((turn) => ({ role: turn.role, text: turn.text.slice(0, 500) })),
      })),
    )

  probeIt("8-chat-writein", async (r) => {
    const name = "8-chat-writein"
    r.model.use(
      question(["Red", "Green", "Blue"]),
      own((call) =>
        call.turns.at(-1)?.role === "tool" ? { text: "Model saw the answer." } : undefined,
      ),
    )
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Ask me")
    await t1.until(/> 1\. Red/)
    await t1.confirm(/> 4\. Write-in/, async () => {
      for (const _ of [1, 2, 3]) t1.press("\x1b[B")
    })
    await t1.until(/Your answer:/)
    await t1.submit("Let's discuss this first: is Red accessible?")
    await sleep(4000)
    await capture(name, "after", t1, probe, { sizes: false })
    modelLog(r, name, "after")
  })

  probeIt("8-chat-skip-prompt", async (r) => {
    const name = "8-chat-skip-prompt"
    r.model.use(
      question(["Red", "Green", "Blue"]),
      own((call) => (asked(call, "Let's talk") ? { text: "Model saw the prompt." } : undefined)),
      own((call) =>
        call.turns.at(-1)?.role === "tool" ? { text: "Model saw the skip." } : undefined,
      ),
    )
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Ask me")
    await t1.until(/> 1\. Red/)
    t1.press("\x1b")
    await sleep(1500)
    await capture(name, "skipped", t1, probe, { sizes: false })
    modelLog(r, name, "skipped")
    await t1.submit("Let's talk about this first")
    await sleep(4000)
    await capture(name, "after", t1, probe, { sizes: false })
    modelLog(r, name, "after")
  })

  for (const [label, file] of [
    ["command", false],
    ["file", true],
  ] as const)
    probeIt(`8-deny-prompt-${label}`, async (r) => {
      const name = `8-deny-prompt-${label}`
      r.model.use(
        file ? makeFile(r.sandbox.project) : run(r.sandbox.project),
        own((call) =>
          asked(call, "Use another way") ? { text: "Model saw the prompt." } : undefined,
        ),
        own((call) =>
          call.turns.at(-1)?.role === "tool" ? { text: "Model saw the result." } : undefined,
        ),
      )
      const probe = prepare(r)
      const t1 = await start(r, agy)
      await t1.submit(file ? "Make the file" : "Run it")
      await t1.until(file ? /> 1\. Yes, allow creation/ : agy.approval!.shows)
      t1.press(file ? "2" : "4")
      await sleep(3000)
      await capture(name, "denied", t1, probe, { sizes: false })
      modelLog(r, name, "denied")
      await t1.submit("Use another way")
      await sleep(4000)
      await capture(name, "after", t1, probe, { sizes: false })
      modelLog(r, name, "after")
    })

  probeIt("8-amend-submit", async (r) => {
    const name = "8-amend-submit"
    r.model.use(
      run(r.sandbox.project),
      own((call) =>
        call.turns.at(-1)?.role === "tool" ? { text: "Model saw the result." } : undefined,
      ),
    )
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Run it")
    await t1.until(agy.approval!.shows)
    t1.press("\t")
    await sleep(1200)
    await t1.submit("and then say hello")
    await sleep(4000)
    await capture(name, "after", t1, probe, { sizes: false })
    modelLog(r, name, "after")
  })

  probeIt("8-bang", async (r) => {
    const name = "8-bang"
    r.model.use(own((call) => (asked(call, "Hello") ? { text: "Hi." } : undefined)))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    t1.press("!")
    await sleep(1000)
    await capture(name, "bang", t1, probe, { sizes: false })
    await t1.submit("echo bang-ran > bang.txt")
    await sleep(3000)
    await capture(name, "after", t1, probe, { sizes: false })
    save(
      `${name}.file.txt`,
      existsSync(join(r.sandbox.project, "bang.txt")) ? "bang.txt EXISTS" : "no file",
    )
    modelLog(r, name, "after")
  })

  probeIt("8-at", async (r) => {
    const name = "8-at"
    writeFileSync(join(r.sandbox.project, "notes.txt"), "x\n")
    r.model.use(own((call) => (asked(call, "fix") ? { text: "Hi." } : undefined)))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    t1.press("@")
    await sleep(1200)
    await capture(name, "lead", t1, probe, { sizes: false })
    t1.press("not")
    await sleep(1200)
    await capture(name, "lead-typed", t1, probe, { sizes: false })
    await capture(name, "lead-end", t1, probe, { sizes: false })
  })

  probeIt("8-at-inner", async (r) => {
    const name = "8-at-inner"
    writeFileSync(join(r.sandbox.project, "notes.txt"), "x\n")
    r.model.use(own((call) => (asked(call, "fix") ? { text: "Hi." } : undefined)))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    t1.press("fix the @no")
    await sleep(1200)
    await capture(name, "inner", t1, probe, { sizes: false })
  })

  probeIt("8-amend", async (r) => {
    const name = "8-amend"
    r.model.use(
      run(r.sandbox.project),
      own((call) =>
        call.turns.at(-1)?.role === "tool" ? { text: "Model saw the result." } : undefined,
      ),
    )
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Run it")
    await t1.until(agy.approval!.shows)
    t1.press("\t")
    await sleep(1200)
    await capture(name, "tab", t1, probe, { sizes: false })
    t1.press("and also say hello")
    await sleep(1000)
    await capture(name, "typed", t1, probe, { sizes: false })
    t1.press("\x1b")
    await sleep(1200)
    await capture(name, "esc", t1, probe, { sizes: false })
    modelLog(r, name, "esc")
  })

  // The (H) route: what a PreToolUse answer does to the confirmation.
  for (const [label, answer] of [
    ["allow", '{"decision":"allow"}'],
    ["deny", '{"decision":"deny","reason":"Blocked by the probe hook"}'],
    ["force-ask", '{"decision":"force_ask"}'],
    ["empty", "{}"],
    ["allow-reason", '{"decision":"allow","reason":"Chat said yes"}'],
  ] as const)
    probeIt(`4-hook-command-${label}`, async (r) => {
      const name = `4-hook-command-${label}`
      r.model.use(run(r.sandbox.project), after("Made it."))
      const probe = prepare(r)
      probe.set("answer", answer)
      const t1 = await start(r, agy)
      await t1.submit("Run it")
      await sleep(5000)
      await capture(name, "after", t1, probe, { sizes: false })
      // If a confirmation is still up (force_ask), deny it so the run ends.
      if (agy.approval!.shows.test(await t1.screen())) {
        t1.press("4")
        await sleep(2000)
      }
    })

  for (const [label, answer] of [
    ["allow", '{"decision":"allow"}'],
    ["deny", '{"decision":"deny","reason":"Blocked by the probe hook"}'],
  ] as const)
    probeIt(`4-hook-ask-${label}`, async (r) => {
      const name = `4-hook-ask-${label}`
      r.model.use(question(["Red", "Green", "Blue"]), after("Noted."))
      const probe = prepare(r)
      probe.set("answer", answer)
      const t1 = await start(r, agy)
      await t1.submit("Ask me")
      await sleep(5000)
      await capture(name, "after", t1, probe, { sizes: false })
      t1.press("\x1b")
      await sleep(1500)
    })

  probeIt("4-hook-ask-overwrite", async (r) => {
    const name = "4-hook-ask-overwrite"
    r.model.use(question(["Red", "Green", "Blue"]), after("Noted."))
    const probe = prepare(r)
    probe.set(
      "answer",
      JSON.stringify({
        decision: "allow",
        overwrite: { questions: [{ question: "Which shape?", options: ["Circle", "Square"] }] },
      }),
    )
    const t1 = await start(r, agy)
    await t1.submit("Ask me")
    await sleep(5000)
    await capture(name, "after", t1, probe, { sizes: false })
    t1.press("\x1b")
    await sleep(1500)
  })

  // A hook that waits: what the TUI shows meanwhile, whether keys reach it, what each
  // answer on release does.
  for (const [label, release, keysDuringHold] of [
    ["allow", '{"decision":"allow"}', ""],
    ["ask", '{"decision":"ask"}', ""],
    ["empty", "{}", ""],
    ["deny", '{"decision":"deny","reason":"Chat said no"}', ""],
    ["allow-keys-4", '{"decision":"allow"}', "4"],
    ["ask-keys-1", '{"decision":"ask"}', "1"],
  ] as const)
    probeIt(`5-hold-${label}`, async (r) => {
      const name = `5-hold-${label}`
      r.model.use(run(r.sandbox.project), after("Made it."))
      const probe = prepare(r, { timeout: 60 })
      probe.set("hold")
      const t1 = await start(r, agy)
      await t1.submit("Run it")
      await sleep(5000)
      await capture(name, "holding", t1, probe, { sizes: false })
      if (keysDuringHold) {
        t1.press(keysDuringHold)
        await sleep(2500)
        await capture(name, "holding-after-keys", t1, probe, { sizes: false })
      }
      probe.set("answer", release)
      probe.clear("hold")
      await sleep(4000)
      await capture(name, "released", t1, probe, { sizes: false })
      if (agy.approval!.shows.test(await t1.screen())) {
        save(`${name}.confirm-after-release`, "yes")
        t1.press("4")
        await sleep(2000)
      }
    })

  probeIt("5-hold-timeout", async (r) => {
    const name = "5-hold-timeout"
    r.model.use(run(r.sandbox.project), after("Made it."))
    const probe = prepare(r, { timeout: 4 })
    probe.set("hold")
    const t1 = await start(r, agy)
    await t1.submit("Run it")
    await sleep(2500)
    await capture(name, "holding", t1, probe, { sizes: false })
    await sleep(5000)
    await capture(name, "after-timeout", t1, probe, { sizes: false })
    if (agy.approval!.shows.test(await t1.screen())) {
      save(`${name}.confirm-after-timeout`, "yes")
      t1.press("4")
      await sleep(2000)
    }
    probe.clear("hold")
  })

  probeIt("5-hold-ask", async (r) => {
    const name = "5-hold-ask"
    r.model.use(question(["Red", "Green", "Blue"]), after("Noted."))
    const probe = prepare(r, { timeout: 60 })
    probe.set("hold")
    const t1 = await start(r, agy)
    await t1.submit("Ask me")
    await sleep(5000)
    await capture(name, "holding", t1, probe, { sizes: false })
    probe.set("answer", '{"decision":"allow"}')
    probe.clear("hold")
    await sleep(3000)
    await capture(name, "released", t1, probe, { sizes: false })
    t1.press("2")
    await sleep(2500)
    await capture(name, "answered", t1, probe, { sizes: false })
  })

  // permissionOverrides, the documented temporary grant a PreToolUse answer can carry.
  for (const [label, answer] of [
    ["exact", '{"decision":"allow","permissionOverrides":["command(echo approved)"]}'],
    ["prefix", '{"decision":"allow","permissionOverrides":["command(echo)"]}'],
    ["ask-exact", '{"decision":"ask","permissionOverrides":["command(echo approved)"]}'],
    ["noallow", '{"permissionOverrides":["command(echo approved)"]}'],
  ] as const)
    probeIt(`4-override-command-${label}`, async (r) => {
      const name = `4-override-command-${label}`
      r.model.use(run(r.sandbox.project), after("Made it."))
      const probe = prepare(r)
      probe.set("answer", answer)
      const t1 = await start(r, agy)
      await t1.submit("Run it")
      await sleep(5000)
      await capture(name, "after", t1, probe, { sizes: false })
      if (agy.approval!.shows.test(await t1.screen())) {
        save(`${name}.confirm-still-shown`, "yes")
        t1.press("4")
        await sleep(2000)
      }
    })

  for (const [label, answer] of [
    ["allow", '{"decision":"allow"}'],
    ["write-path", "WRITE"],
    ["deny", '{"decision":"deny","reason":"Blocked"}'],
  ] as const)
    probeIt(`4-hook-write-${label}`, async (r) => {
      const name = `4-hook-write-${label}`
      r.model.use(makeFile(r.sandbox.project), after("Made it."))
      const probe = prepare(r)
      probe.set(
        "answer",
        answer === "WRITE"
          ? JSON.stringify({
              decision: "allow",
              permissionOverrides: [
                `write(${r.sandbox.project}/probe.txt)`,
                `edit(${r.sandbox.project}/probe.txt)`,
                `file(${r.sandbox.project}/probe.txt)`,
              ],
            })
          : answer,
      )
      const t1 = await start(r, agy)
      await t1.submit("Make the file")
      await sleep(5000)
      await capture(name, "after", t1, probe, { sizes: false })
      if (/Allow creation of this file\?/.test(await t1.screen())) {
        save(`${name}.confirm-still-shown`, "yes")
        t1.press("2")
        await sleep(2000)
      }
    })

  probeIt("6-write-file-override", async (r) => {
    const name = "6-write-file-override"
    r.model.use(makeFile(r.sandbox.project), after("Made it."))
    const probe = prepare(r)
    probe.set(
      "answer",
      JSON.stringify({
        decision: "allow",
        permissionOverrides: [`write_file(${r.sandbox.project}/probe.txt)`],
      }),
    )
    const t1 = await start(r, agy)
    await t1.submit("Make the file")
    await sleep(5000)
    await capture(name, "after", t1, probe, { sizes: false })
    if (/Allow creation of this file\?/.test(await t1.screen())) {
      save(`${name}.confirm-still-shown`, "yes")
      t1.press("2")
      await sleep(2000)
    }
  })

  probeIt("6-command-y", async (r) => {
    const name = "6-command-y"
    r.model.use(run(r.sandbox.project), after("Made it."))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Run it")
    await t1.until(agy.approval!.shows)
    t1.press("y")
    await sleep(3500)
    await capture(name, "after", t1, probe, { sizes: false })
  })

  // The person answers in the TUI at the same moment a hook answer is released.
  probeIt("6-override-regex", async (r) => {
    const name = "6-override-regex"
    r.model.use(run(r.sandbox.project), after("Made it."))
    const probe = prepare(r)
    probe.set("answer", '{"decision":"allow","permissionOverrides":["command(*)"]}')
    const t1 = await start(r, agy)
    await t1.submit("Run it")
    await sleep(5000)
    await capture(name, "after", t1, probe, { sizes: false })
    if (agy.approval!.shows.test(await t1.screen())) {
      save(`${name}.confirm-still-shown`, "yes")
      t1.press("4")
      await sleep(2000)
    }
  })

  probeIt("7-long-command", async (r) => {
    const name = "7-long-command"
    const long = `echo ${"abcdefghij ".repeat(30)}&& echo "second line" && printf 'x\\ny\\n'`
    r.model.use(run(r.sandbox.project, long), after("Made it."))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Run it")
    await t1.until(agy.approval!.shows)
    await capture(name, "pending", t1, probe)
    t1.press("4")
    await sleep(1500)
  })

  probeIt("7-two-parallel", async (r) => {
    const name = "7-two-parallel"
    r.model.use(
      own((call) =>
        asked(call, "Run it")
          ? {
              calls: ["echo one", "echo two"].map((CommandLine) => ({
                name: "run_command",
                input: {
                  CommandLine,
                  Cwd: r.sandbox.project,
                  WaitMsBeforeAsync: 3000,
                  toolSummary: "Echo",
                  toolAction: "Echoing",
                },
              })),
            }
          : undefined,
      ),
      after("Made them."),
    )
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Run it")
    await t1.until(agy.approval!.shows)
    await capture(name, "first", t1, probe, { sizes: false })
    t1.press("1")
    await sleep(2500)
    await capture(name, "second", t1, probe, { sizes: false })
    t1.press("1")
    await sleep(3500)
    await capture(name, "after", t1, probe, { sizes: false })
  })

  probeIt("7-two-identical", async (r) => {
    const name = "7-two-identical"
    r.model.use(
      own((call) =>
        asked(call, "Run it")
          ? {
              calls: ["echo same", "echo same"].map((CommandLine) => ({
                name: "run_command",
                input: {
                  CommandLine,
                  Cwd: r.sandbox.project,
                  WaitMsBeforeAsync: 3000,
                  toolSummary: "Echo",
                  toolAction: "Echoing",
                },
              })),
            }
          : undefined,
      ),
      after("Made them."),
    )
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Run it")
    await t1.until(agy.approval!.shows)
    await capture(name, "first", t1, probe, { sizes: false })
    t1.press("1")
    await sleep(2500)
    await capture(name, "second", t1, probe, { sizes: false })
    t1.press("1")
    await sleep(3500)
    await capture(name, "after", t1, probe, { sizes: false })
  })
})

const replies2 = (text: string, reply: string): Rule =>
  own((call) => (asked(call, text) ? { text: reply } : undefined))
