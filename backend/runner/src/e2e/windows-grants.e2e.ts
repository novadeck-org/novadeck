/* eslint-disable no-await-in-loop -- The probes poll and step through screens in turn. */
// WINDOWS PROBES for the grants feature (draft PR #615; architecture/team-issues/
// approvals-design.md, Appendix A1 and B). They run only on Windows, in the quirks lanes
// of the Codex and Antigravity jobs, and RECORD: every observation is printed with a
// `PROBE ` prefix (grep the job log for "PROBE "), and a case fails only when its setup
// does, never for what a harness did.
//
// Codex: what the hooks get for an escalated exec, which shell runs it, and what argv a
// real program sees from PowerShell's quoting. Antigravity: whether a hook that is an exe
// alone runs, what it does with its JSON, how a misbehaving hook (nothing, non-JSON,
// non-zero exit, timeout) fares, and how the hook is spawned.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { relayPath } from "@novadeck/relay"
import { onTestFinished } from "vitest"

import type { AgentSetup } from "./agents/agent.js"
import { agy } from "./agents/agy.js"
import { codex } from "./agents/codex.js"
import { describe, e2e, supported } from "./fixture.js"
import { asked, type Call, type Reply } from "./model/script.js"
import { own, prompted } from "./scenarios.js"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** One observation, as the job log is grepped for it. */
const probe = (what: string, value: unknown) => {
  console.log(`PROBE ${what}`, JSON.stringify(value))
}

// ---- the kit: programs and hooks the probes own, in a folder with no space in its path
// (cmd, which Antigravity runs its hooks in, reads a path with one badly).

// A node script that finds this process's ancestors (name, command line) the way a hook's or
// a program's parent chain is read on Windows: one PowerShell query of every process.
const ancestry = `
const { spawnSync } = require("node:child_process")
exports.ancestry = () => {
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
    { encoding: "utf8", timeout: 25000, maxBuffer: 64 * 1024 * 1024 })
  try {
    const all = [].concat(JSON.parse(ps.stdout))
    const byPid = new Map(all.map((p) => [p.ProcessId, p]))
    const chain = []
    let pid = process.pid
    for (let i = 0; i < 8 && byPid.has(pid); i++) {
      const p = byPid.get(pid)
      chain.push({ pid: p.ProcessId, name: p.Name, commandLine: String(p.CommandLine).slice(0, 600) })
      pid = p.ParentProcessId
    }
    return chain
  } catch (error) { return [{ failed: String(error), stderr: String(ps.stderr).slice(0, 300) }] }
}
`

// A program that logs the argv it receives and its ancestors to programs.jsonl, and prints
// the argv, so the model's tool result carries it too. Run as `ndargv.exe argv.cjs <args>`:
// a copy of node.exe, so the process is a real exe that parses its command line as Windows
// programs do (node reads the arguments after the script as its own, unparsed).
const argvProgram = `
const { appendFileSync } = require("node:fs")
const { ancestry } = require("./ancestry.cjs")
const record = { program: "argv", argv: process.argv.slice(2), cwd: process.cwd(), execPath: process.execPath }
console.log("ARGV " + JSON.stringify(record.argv))
appendFileSync(__dirname + "/programs.jsonl", JSON.stringify({ ...record, ancestry: ancestry() }) + "\\n")
`

// The marker program: appends a line to the file it is given, and logs its ancestors.
const markerProgram = `
const { appendFileSync } = require("node:fs")
const { ancestry } = require("./ancestry.cjs")
appendFileSync(process.argv[2], "ran " + JSON.stringify(process.argv.slice(3)) + "\\n")
appendFileSync(__dirname + "/programs.jsonl", JSON.stringify({ program: "marker", argv: process.argv.slice(2), ancestry: ancestry() }) + "\\n")
`

// The hook, run as \`standin.exe hook.cjs <dir> <event>\` (or by node). It logs what it is
// given (stdin, argv, environment) at once, then acts as <dir>/mode says for PreToolUse:
// none (prints nothing, exits 0), oops (non-JSON), exit1, dug-exit1, sleep (6 s); else it
// prints <dir>/<event>.out when there is one. A second record carries its ancestors.
const hookProgram = `
const { appendFileSync, existsSync, readFileSync, writeSync } = require("node:fs")
const { ancestry } = require("./ancestry.cjs")
const [dir, event] = process.argv.slice(2)
let input = ""
try { input = readFileSync(0, "utf8") } catch (error) { input = "<stdin unreadable: " + error + ">" }
let payload = input
try { payload = JSON.parse(input) } catch {}
const log = (extra) => appendFileSync(dir + "/events.jsonl", JSON.stringify({ t: Date.now(), event, ...extra }) + "\\n")
log({
  payload,
  argv: process.argv.slice(2),
  execPath: process.execPath,
  cwd: process.cwd(),
  ppid: process.ppid,
  narrow: process.env.NOVADECK_NARROW ?? null,
  hasHook: Boolean(process.env.NOVADECK_HOOK),
  stdinIsTTY: Boolean(process.stdin.isTTY),
})
const mode = event === "PreToolUse" && existsSync(dir + "/mode") ? readFileSync(dir + "/mode", "utf8").trim() : ""
const out = dir + "/" + event + ".out"
const say = (text) => writeSync(1, text)
const done = (code) => { log({ ancestry: ancestry(), finished: true, exit: code }); process.exit(code) }
if (mode === "none") done(0)
else if (mode === "oops") { say("oops"); done(0) }
else if (mode === "exit1") done(1)
else if (mode === "dug-exit1") { say('{"decision":"deny_unless_prior_grant"}'); done(1) }
else if (mode === "sleep") setTimeout(() => { log({ finished: true, slept: true }); process.exit(0) }, 6000)
else {
  if (existsSync(out)) say(readFileSync(out, "utf8"))
  done(0)
}
`

type Kit = {
  readonly dir: string
  /** A node.exe copy under another name, so it runs as a program of its own. */
  readonly bin: string
}

const kits = new Map<string, Kit>()

/** Writes the kit and puts its programs first on PATH. */
const withKit = (setup: AgentSetup): AgentSetup => ({
  ...setup,
  prepare: async (sandbox, model, installed, seed) => {
    const env = await setup.prepare(sandbox, model, installed, seed)
    const dir = mkdtempSync(join(tmpdir(), "ndp-"))
    const bin = join(dir, "bin")
    mkdirSync(bin)
    for (const name of ["ndargv.exe", "ndmarker.exe", "standin.exe"])
      copyFileSync(process.execPath, join(bin, name))
    writeFileSync(join(dir, "ancestry.cjs"), ancestry)
    writeFileSync(join(dir, "argv.cjs"), argvProgram)
    writeFileSync(join(dir, "marker.cjs"), markerProgram)
    writeFileSync(join(dir, "hook.cjs"), hookProgram)
    kits.set(sandbox.root, { dir, bin })
    return { ...env, PATH: [bin, sandbox.env.PATH].join(delimiter) }
  },
})

/** The kit of this run's sandbox; removed with the test. */
const kitOf = (root: string): Kit => {
  const kit = kits.get(root)
  if (kit === undefined) throw new Error("the probe kit was not prepared")
  onTestFinished(() => {
    try {
      rmSync(kit.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      // A program still held a file: it is a temp folder.
    }
  })
  return kit
}

const lines = (file: string): unknown[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as unknown
          } catch {
            return { unparsed: line }
          }
        })
    : []

/** Prints what the hooks and programs logged. */
const report = (label: string, kit: Kit) => {
  for (const event of lines(join(kit.dir, "events.jsonl"))) probe(`${label} hook`, event)
  for (const program of lines(join(kit.dir, "programs.jsonl"))) probe(`${label} program`, program)
}

const windows = process.platform === "win32" && supported
const rows = (screen: string) => screen.split("\n").filter((row) => row.trim() !== "")

// ---- Codex

type Command = {
  readonly name: string
  /** The `cmd` of the exec_command call. */
  readonly cmd: string
  /** The call's `shell` argument: a shell binary for the call to launch instead of the default. */
  readonly shell?: string
}

const gitBash = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
].find((path) => existsSync(path))

describe.runIf(windows)("Codex on Windows (grants probe)", () => {
  const it = e2e(withKit(codex))

  it("records the hooks' payloads, the shell, and PowerShell's argv", async ({ e2e: run }) => {
    const kit = kitOf(run.sandbox.root)
    const script = join(kit.dir, "argv.cjs")
    const posix = script.replaceAll("\\", "/")
    const argv = (args: string) => `ndargv.exe ${script} ${args}`
    const commands: Command[] = [
      // Which shell: PowerShell expands $PSVersionTable, bash $BASH_VERSION, cmd %COMSPEC%.
      {
        name: "which-shell",
        cmd: 'echo "PS=$PSVersionTable|BASH=$BASH_VERSION|COMSPEC=%COMSPEC%|0=$0"',
      },
      {
        name: "ps-version",
        cmd: "$PSVersionTable.PSVersion.ToString(); $PSVersionTable.PSEdition",
      },
      { name: "shell-env", cmd: "echo $env:SHELL $env:ComSpec $env:PSModulePath" },
      // PowerShell's own quoting, by what echo prints.
      { name: "echo-single-quote-doubled", cmd: "echo 'a''b'" },
      { name: "echo-double-quote", cmd: 'echo "x"' },
      { name: "echo-comma", cmd: "echo a,b" },
      // What argv a real program receives.
      { name: "argv-plain", cmd: argv("gh pr ready 12 -R octo/repo") },
      { name: "argv-single-quote-doubled", cmd: argv("'a''b'") },
      { name: "argv-double-quote", cmd: argv('"x"') },
      { name: "argv-comma", cmd: argv("a,b") },
      { name: "argv-stop-parsing", cmd: argv('--% "q" %COMSPEC% $env:COMSPEC') },
      { name: "argv-single-with-spaces", cmd: argv("'a b'") },
      { name: "argv-single-holding-double", cmd: argv(`'x "y" z'`) },
      { name: "argv-double-holding-apostrophe", cmd: argv(`"it's"`) },
      { name: "argv-dollar", cmd: argv(`'$HOME' "$HOME" $HOME`) },
      { name: "argv-tilde-star", cmd: argv("~ * ?") },
      { name: "argv-glued-quote", cmd: argv('x"y"z') },
      { name: "argv-empty-string", cmd: argv(`'' ""`) },
      { name: "argv-and-and", cmd: `${argv("one")} && ${argv("two")}` },
      { name: "argv-semicolon", cmd: `${argv("one")}; ${argv("two")}` },
      { name: "argv-backslash", cmd: argv("a\\b 'c\\'") },
      // A shell the model names: does the call take another, and does Git Bash run it?
      ...(gitBash === undefined
        ? []
        : [
            {
              name: "git-bash-which-shell",
              shell: gitBash,
              cmd: 'echo "PS=$PSVersionTable|BASH=$BASH_VERSION|0=$0"',
            },
            {
              name: "git-bash-argv-sq",
              shell: gitBash,
              cmd: `ndargv.exe ${posix} 'a b' "x" 'it'"'"'s'`,
            },
          ]),
      { name: "shell-bare-bash", shell: "bash", cmd: 'echo "BASH=$BASH_VERSION|0=$0"' },
      { name: "shell-cmd", shell: "cmd", cmd: "echo %COMSPEC% & ver" },
      { name: "shell-pwsh", shell: "pwsh", cmd: "$PSVersionTable.PSVersion.ToString()" },
      {
        name: "shell-powershell",
        shell: "powershell",
        cmd: "$PSVersionTable.PSVersion.ToString()",
      },
    ]
    probe("codex setup", {
      kit: kit.dir,
      node: process.execPath,
      gitBash: gitBash ?? null,
      pathExt: process.env.PATHEXT ?? null,
      names: commands.map((one) => one.name),
    })

    // The hooks log every payload; PermissionRequest allows the call, so the exec runs.
    const node = process.execPath.replaceAll("'", "''")
    const handler = (event: string) => ({
      type: "command",
      command: `& '${node}' '${join(kit.dir, "hook.cjs")}' '${kit.dir}' ${event}`,
      timeout: 60,
    })
    writeFileSync(
      join(run.sandbox.home, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [handler("PreToolUse")] }],
          PermissionRequest: [{ hooks: [handler("PermissionRequest")] }],
          PostToolUse: [{ hooks: [handler("PostToolUse")] }],
        },
      }),
    )
    writeFileSync(
      join(kit.dir, "PermissionRequest.out"),
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      }),
    )

    const results: string[] = []
    const state = { finished: false }
    const issue = (index: number): Reply => {
      const one = commands[index]!
      return {
        calls: [
          {
            name: "exec_command",
            input: {
              cmd: one.cmd,
              ...(one.shell === undefined ? {} : { shell: one.shell }),
              sandbox_permissions: "require_escalated",
              justification: "Probe Windows",
            },
          },
        ],
      }
    }
    run.model.use(
      own((call: Call) => {
        if (asked(call, "Run it")) return issue(0)
        const last = call.turns.at(-1)
        if (last?.role !== "tool") return undefined
        results.push(last.text)
        if (results.length < commands.length) return issue(results.length)
        state.finished = true
        return { text: "Probed." }
      }),
    )

    const t = await run.deck.open("codex --dangerously-bypass-hook-trust")
    await t.reached("ready", { timeoutMs: 60_000 })
    await prompted(t, codex)
    await t.submit("Run it")
    const until = Date.now() + commands.length * 60_000
    while (!state.finished && Date.now() < until) {
      await sleep(2000)
      const screen = await t.screen()
      if (/Would you like to run the following command\?/.test(screen)) {
        probe("codex dialog shown despite the PermissionRequest hook", {
          at: results.length,
          screen: rows(screen),
        })
        t.press("\x1b")
        await sleep(1500)
      }
    }
    probe("codex finished", {
      finished: state.finished,
      results: results.length,
      of: commands.length,
    })

    for (const [index, one] of commands.entries())
      probe("codex case", {
        name: one.name,
        shell: one.shell ?? null,
        cmd: one.cmd,
        result: results[index]?.slice(0, 1500) ?? null,
      })
    report("codex", kit)
    probe(
      "codex exec_command declaration",
      JSON.stringify(
        run.model.calls
          .flatMap((x) => x.rawTools ?? [])
          .find((x) => JSON.stringify(x).includes('"exec_command"')) ?? null,
      ).slice(0, 6000),
    )
    probe("codex final screen", rows(await t.screen()))
  }, 1_800_000)
})

// ---- Antigravity

type AgyCase = {
  readonly name: string
  /** What PreToolUse prints (the hook's answer file), unless `mode` says otherwise. */
  readonly answer?: unknown
  /** How the hook misbehaves: see the hook program. */
  readonly mode?: "none" | "oops" | "exit1" | "dug-exit1" | "sleep"
  /** How the PreToolUse command is written; none registers no PreToolUse hook. */
  readonly form?: "direct" | "node" | "relay" | "cmd-direct" | "none"
  /** The programs `--settings` allows, as `command(<name>)`; none passes no settings. */
  readonly grant?: readonly string[]
  /** The program name the model's command line uses. */
  readonly program?: "ndmarker.exe" | "ndmarker"
  /** The keys pressed once the dialog shows, else the dialog is dismissed with 4. */
  readonly press?: string
  readonly timeout?: number
}

const both = ["command(ndmarker)", "command(ndmarker.exe)"]
const decision = (name: string) => ({ decision: name })
const agyCases: AgyCase[] = [
  // The baseline: no PreToolUse hook at all. Does a launch grant by name work here?
  { name: "n0-nohook-nogrant", form: "none" },
  { name: "n1-nohook-grant-bare-name", form: "none", grant: ["command(ndmarker)"] },
  { name: "n2-nohook-grant-exe-name", form: "none", grant: ["command(ndmarker.exe)"] },
  { name: "n3-nohook-grant-both-cmdline-bare", form: "none", grant: both, program: "ndmarker" },
  // A PreToolUse hook that is an exe alone: run directly, and is its JSON read?
  {
    name: "d1-direct-dug",
    form: "direct",
    grant: both,
    answer: decision("deny_unless_prior_grant"),
  },
  {
    name: "d2-direct-force-ask",
    form: "direct",
    grant: both,
    answer: decision("force_ask"),
    press: "1",
  },
  { name: "d3-direct-dug-nogrant", form: "direct", answer: decision("deny_unless_prior_grant") },
  { name: "d4-node-dug", form: "node", grant: both, answer: decision("deny_unless_prior_grant") },
  {
    name: "d5-cmd-direct-dug",
    form: "cmd-direct",
    grant: both,
    answer: decision("deny_unless_prior_grant"),
  },
  { name: "d6-relay-alone", form: "relay", grant: both },
  // The misbehaving hook, as on Linux (h1..h6): the grant stays, the hook is the exe alone.
  { name: "h1-silent", form: "direct", grant: both, mode: "none" },
  { name: "h2-empty-object", form: "direct", grant: both, answer: {} },
  { name: "h3-non-json", form: "direct", grant: both, mode: "oops" },
  { name: "h4-exit1", form: "direct", grant: both, mode: "exit1" },
  { name: "h5-dug-exit1", form: "direct", grant: both, mode: "dug-exit1" },
  { name: "h6-timeout", form: "direct", grant: both, mode: "sleep", timeout: 1 },
  { name: "h1b-silent-nogrant", form: "direct", mode: "none" },
]
const only = process.env.WINDOWS_GRANTS_CASE?.split(",")

describe.runIf(windows)("Antigravity on Windows (grants probe)", () => {
  const it = e2e(withKit(agy))

  for (const c of agyCases) {
    if (only && !only.some((one) => c.name.startsWith(one))) continue
    it(
      c.name,
      async ({ e2e: run }) => {
        const kit = kitOf(run.sandbox.root)
        const form = c.form ?? "direct"
        const standin = join(kit.bin, "standin.exe")
        const hookFile = join(kit.dir, "hook.cjs")
        const command = (event: string) =>
          ({
            direct: `${standin} ${hookFile} ${kit.dir} ${event}`,
            node: `node ${hookFile} ${kit.dir} ${event}`,
            "cmd-direct": `cmd /d /c ${standin} ${hookFile} ${kit.dir} ${event}`,
            relay: `${relayPath} hook agy ${event}`,
            none: "",
          })[form]
        const handler = (event: string) => ({
          type: "command",
          command: command(event),
          timeout: event === "PreToolUse" && c.timeout ? c.timeout : 30,
        })
        probe("agy setup", {
          case: c.name,
          form,
          grant: c.grant ?? null,
          mode: c.mode ?? null,
          answer: c.answer ?? null,
          hookCommand: command("PreToolUse"),
          kit: kit.dir,
          relayPath,
        })

        // Novadeck's own plugin hooks are emptied, as on Linux, so only the probe's answers.
        const plugins = join(run.sandbox.home, ".gemini", "config", "plugins")
        if (existsSync(plugins))
          for (const file of readdirSync(plugins, { recursive: true, encoding: "utf8" }))
            if (/(^|[\\/])hooks\.json$/.test(file)) {
              const path = join(plugins, file)
              probe("agy plugin hooks.json emptied", { path, was: readFileSync(path, "utf8") })
              writeFileSync(path, "{}")
            }
        mkdirSync(join(run.sandbox.project, ".agents"), { recursive: true })
        writeFileSync(
          join(run.sandbox.project, ".agents", "hooks.json"),
          JSON.stringify({
            probe: {
              ...(form === "none"
                ? {}
                : { PreToolUse: [{ matcher: "*", hooks: [handler("PreToolUse")] }] }),
              PostToolUse: [{ matcher: "*", hooks: [handler("PostToolUse")] }],
              Stop: [handler("Stop")],
            },
          }),
        )
        // The hook prints these (PreToolUse's `{}` unless the case gives an answer).
        for (const event of ["PostToolUse", "Stop"])
          writeFileSync(join(kit.dir, `${event}.out`), "{}")
        writeFileSync(join(kit.dir, "PreToolUse.out"), JSON.stringify(c.answer ?? {}))
        if (c.mode) writeFileSync(join(kit.dir, "mode"), c.mode)

        let flags = ""
        if (c.grant) {
          const file = join(kit.dir, "grant.json")
          writeFileSync(file, JSON.stringify({ permissions: { allow: c.grant } }))
          flags = ` --settings ${file}`
        }
        const marker = join(kit.dir, "ran.txt")
        const line = `${c.program ?? "ndmarker.exe"} ${join(kit.dir, "marker.cjs")} ${marker}`
        probe("agy command", { line })
        run.model.use(
          (call: Call): Reply | undefined =>
            !call.side && asked(call, "Run it")
              ? {
                  calls: [
                    {
                      name: "run_command",
                      input: { CommandLine: line, WaitMsBeforeAsync: 5000, toolSummary: "Mark" },
                    },
                  ],
                }
              : undefined,
          own((call) => (call.turns.at(-1)?.role === "tool" ? { text: "Made it." } : undefined)),
        )

        const t = await run.deck.open(`agy${flags}`)
        await t.reached("ready", { timeoutMs: 60_000 })
        await prompted(t, agy)
        await t.submit("Run it")
        await sleep(c.mode === "sleep" ? 10_000 : 8000)
        const screen = await t.screen()
        const dialog = /Run this command\?|needs approval for/.test(screen)
        const ranBeforeKeys = existsSync(marker)
        let afterKey: string | undefined
        let ranAfterKeys: boolean | undefined
        if (dialog && c.press) {
          t.press(c.press)
          await sleep(4000)
          afterKey = await t.screen()
          ranAfterKeys = existsSync(marker)
        } else if (dialog) {
          t.press("4")
          await sleep(2000)
        }
        probe("agy outcome", {
          case: c.name,
          dialogShown: dialog,
          ranBeforeKeys,
          ranAfterKeys,
          markerContent: existsSync(marker) ? readFileSync(marker, "utf8") : null,
          screen: rows(screen),
          afterKey: afterKey === undefined ? null : rows(afterKey),
        })
        // A slept hook ends by itself before the deck closes.
        if (c.mode === "sleep") await sleep(6000)
        report(`agy ${c.name}`, kit)
      },
      240_000,
    )
  }
})
