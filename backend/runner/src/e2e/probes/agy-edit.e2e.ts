import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { screenRecord } from "@novadeck/harness-core/testing/probes"

import { agy } from "../agents/agy.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, expect, supported, type E2E } from "../fixture.js"
import { gemini } from "../model/gemini.js"
import { asked, type Call, type Reply, type Rule } from "../model/script.js"
import { own, start } from "../scenarios.js"
import { sleep } from "./support.js"

// PROBE, not a regression test: Antigravity's edit tool (edit_file from 1.4,
// replace_file_content before), its
// "Accept this file edit?" confirmation, and the hooks it fires (does PostToolUse name the
// file?), plus the tools the model is offered. Everything it sees goes to a folder
// (AGY_PROBE_OUT, default <tmp>/agy-probe), one file per scenario.
// Run: NOVADECK_E2E_PROBES=1 NOVADECK_E2E_AGENTS=agy pnpm --filter @novadeck/runner exec vitest run \
//   --config vitest.e2e.config.ts src/e2e/probes/agy-edit.e2e.ts

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

const edit = (cwd: string) =>
  calls("Edit one", "edit_file", {
    Path: join(cwd, "probe.txt"),
    Target: "hello",
    Replacement: "goodbye",
  })

describe.skipIf(!supported)("Antigravity edit tools (probe)", () => {
  const it = e2e(recording)

  it("0-discovery", async ({ e2e: r }) => {
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

  // Its edit tool asks "Accept this file edit?" (probed 2026-10-15, 1.2.14 and 1.3.5), whose
  // PostToolUse names the file as TargetFile; it offers no multi_replace_file_content. From
  // 1.4 the tool is edit_file, naming the file as Path.
  it("1-replace", async ({ e2e: r }) => {
    writeFileSync(join(r.sandbox.project, "probe.txt"), "hello\n")
    r.model.use(edit(r.sandbox.project), after("Done."))
    const probe = prepare(r)
    const t1 = await start(r, agy)
    await t1.submit("Edit one")
    let seen = false
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- Polled one look after another.
      await sleep(1500)
      // eslint-disable-next-line no-await-in-loop -- As above.
      const shown = await t1.screen()
      if (/> 1\. Yes, accept this change/.test(shown)) {
        // Its confirmation, kept once, before it is answered.
        // eslint-disable-next-line no-await-in-loop -- As above.
        if (!seen) await capture("1-replace", "pending", t1, probe, { sizes: false })
        seen = true
        t1.press("1")
      }
      if (shown.includes("Done.")) break
    }
    await sleep(1500)
    await capture("1-replace", "after", t1, probe, { sizes: false })
    save("1-replace.file.txt", readFileSync(join(r.sandbox.project, "probe.txt"), "utf8"))
  })
})
