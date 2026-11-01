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
import { spawnSync } from "node:child_process"
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
import { afterAll, beforeAll, onTestFinished } from "vitest"

import { harnesses } from "../harnesses/registry.js"
import { parseAutoRun } from "../shell/autorun-relay.js"
import { encodeValue } from "../shell/autorun-value.js"
import type { AgentSetup } from "./agents/agent.js"
import { agy } from "./agents/agy.js"
import { codex } from "./agents/codex.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported, type E2E } from "./fixture.js"
import { installHarness } from "./install.js"
import { asked, record, tool, type Call, type Reply } from "./model/script.js"
import { delivered, messages, own, prompted, result, sends, sent, start } from "./scenarios.js"

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
exports.ancestry = (start = process.pid) => {
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"],
    { encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 })
  try {
    const all = [].concat(JSON.parse(ps.stdout))
    const byPid = new Map(all.map((p) => [p.ProcessId, p]))
    const chain = []
    let pid = start
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
const { existsSync, unlinkSync } = require("node:fs")
const record = { program: "argv", argv: process.argv.slice(2), cwd: process.cwd(), execPath: process.execPath }
console.log("ARGV " + JSON.stringify(record.argv))
appendFileSync(__dirname + "/programs.jsonl", JSON.stringify(record) + "\\n")
// Its ancestors once, when the flag file asks (a slow query must not hold the command).
if (existsSync(__dirname + "/ancestry")) {
  unlinkSync(__dirname + "/ancestry")
  appendFileSync(__dirname + "/programs.jsonl", JSON.stringify({ program: "argv", ancestry: ancestry() }) + "\\n")
}
`

// The marker program: appends a line to the file it is given, and logs its ancestors.
const markerProgram = `
const { appendFileSync } = require("node:fs")
const { ancestry } = require("./ancestry.cjs")
appendFileSync(process.argv[2], "ran " + JSON.stringify(process.argv.slice(3)) + "\\n")
appendFileSync(__dirname + "/programs.jsonl", JSON.stringify({ program: "marker", argv: process.argv.slice(2) }) + "\\n")
if (require("node:fs").existsSync(__dirname + "/ancestry-marker"))
  appendFileSync(__dirname + "/programs.jsonl", JSON.stringify({ program: "marker", ancestry: ancestry() }) + "\\n")
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
// The answer is out and the process ends at once; only a case that asks (the flag file) looks
// at its ancestors, after the answer, as a query there can hang.
const done = (code) => {
  log({ finished: true, exit: code })
  if (existsSync(dir + "/ancestry-hook")) log({ ancestry: ancestry() })
  process.exit(code)
}
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

/** The file (in the kit) Novadeck's cmd.exe pass-through appends the line it passed on to. */
const wrapperLog = "cmd-wrapper.log"

/** Writes the kit and puts its programs first on PATH. */
const withKit = (setup: AgentSetup, pathcmd = false): AgentSetup => ({
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
    const path = [bin, sandbox.env.PATH].join(delimiter)
    if (!pathcmd) {
      kits.set(sandbox.root, { dir, bin })
      return { ...env, PATH: path }
    }
    // Novadeck's own cmd.exe pass-through, through the product path: the runner starts under
    // a printing AutoRun (set before it does), installs the shipped novadeck-cmd.exe as
    // agy-cmd\cmd.exe in its shell folder, verifies it, and its agy shim puts that folder first
    // on PATH for Antigravity alone. NOVADECK_CMD_LOG makes the pass-through append the command
    // line it passed on, which a test reads back.
    kits.set(sandbox.root, { dir, bin })
    if (process.env.GITHUB_ACTIONS === "true") onTestFinished(printingAutoRun())
    return { ...env, PATH: path, NOVADECK_CMD_LOG: join(dir, wrapperLog) }
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

/** What the PATH cmd wrapper passed on, one command line per run. */
const passedOn = (kit: Kit): string[] => {
  const file = join(kit.dir, wrapperLog)
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []
}

/**
 * Antigravity did not get ready: prints what the wrapper passed on, the screen, and its own
 * logs, where the status line's error would be, so the next run says why.
 */
const notReady = async (
  label: string,
  kit: Kit,
  home: string,
  terminal: DeckTerminal | undefined,
): Promise<void> => {
  probe(`${label} wrapper log`, passedOn(kit))
  if (terminal) probe(`${label} not ready screen`, rows(await terminal.screen()))
  const gemini = join(home, ".gemini")
  if (!existsSync(gemini)) return
  for (const file of readdirSync(gemini, { recursive: true, encoding: "utf8" })) {
    if (!/(\.log|\.jsonl?)$/.test(file) || /plugins|brain/.test(file)) continue
    try {
      const text = readFileSync(join(gemini, file), "utf8")
      const errors = text.split("\n").filter((row) => /status.?line/i.test(row))
      probe(`${label} status line error`, {
        file,
        errors: errors.slice(-10),
        tail: text.slice(-2000),
      })
    } catch {
      // A folder, or a file in use.
    }
  }
}

const autoRunKey = "HKCU\\Software\\Microsoft\\Command Processor"
const reg = (...args: string[]) => spawnSync("reg.exe", args, { encoding: "utf8" })

/**
 * Makes cmd print a marker before every command it runs, and returns what puts the registry
 * back. It changes the runner's own registry, which no test may on a developer's machine:
 * only CI's runner.
 */
const printingAutoRun = (): (() => void) => {
  if (process.env.GITHUB_ACTIONS !== "true")
    throw new Error("an AutoRun is set on CI's runner only")
  const was = reg("query", autoRunKey, "/v", "AutoRun")
  const previous =
    was.status === 0 ? /AutoRun\s+REG_\w+\s+(.*)$/m.exec(was.stdout)?.[1]?.trim() : undefined
  // The exact bytes and type it held, through the relay, as reg.exe's text would lose a
  // trailing space or a character the console cannot show.
  const before = previous === undefined ? undefined : userAutoRun()
  const restore = () => {
    if (previous === undefined) {
      reg("delete", autoRunKey, "/v", "AutoRun", "/f")
      return
    }
    // From whatever it holds now to what it held: the relay compares and sets, same type.
    const now = userAutoRun()
    if (
      before?.found === "value" &&
      before.type !== "other" &&
      now?.found === "value" &&
      now.type === before.type
    ) {
      spawnSync(relayPath, ["autorun-set", before.type, now.encoded, before.encoded])
      const after = userAutoRun()
      if (after?.found === "value" && after.encoded === before.encoded) return
    }
    reg("add", autoRunKey, "/v", "AutoRun", "/t", "REG_SZ", "/d", previous, "/f")
  }
  const set = reg(
    "add",
    autoRunKey,
    "/v",
    "AutoRun",
    "/t",
    "REG_SZ",
    "/d",
    "echo novadeck-ci: an AutoRun printed this",
    "/f",
  )
  if (set.status !== 0) throw new Error(`AutoRun not set: ${set.stderr}`)
  const printed = spawnSync(process.env.COMSPEC || "cmd.exe", ["/c", "rem"], { encoding: "utf8" })
  if (!printed.stdout.includes("an AutoRun printed this")) {
    restore()
    throw new Error(`cmd printed nothing under the AutoRun: ${printed.stdout}`)
  }
  return restore
}

/** The person's AutoRun (HKCU) as the relay reads it: its type and raw bytes in base64. */
const userAutoRun = () => {
  const read = spawnSync(relayPath, ["autorun"], { encoding: "utf8" })
  return read.status === 0 ? parseAutoRun(read.stdout)?.user : undefined
}

/** Prints what the hooks and programs logged. */
const report = (label: string, kit: Kit) => {
  for (const event of lines(join(kit.dir, "events.jsonl"))) probe(`${label} hook`, event)
  for (const program of lines(join(kit.dir, "programs.jsonl"))) probe(`${label} program`, program)
}

const windows = process.platform === "win32" && supported

/** Whether this Antigravity takes launch settings, from 1.4.10 on; before it, `--settings` prints usage. */
const takesSettings = async (): Promise<boolean> => {
  const [major = 0, minor = 0, patch = 0] = (await installHarness("agy")).version
    .split(".")
    .map(Number)
  return major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 10)))
}
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

// Whole-word double quotes the lexer accepts: [name, the text after the program].
const quotedForms: readonly (readonly [string, string])[] = [
  ["spaced-path", '"C:\\Users\\Jan Kowalski\\note.md"'],
  ["title", '"Fix the bug"'],
  ["apostrophe-comma", `"it's, fine"`],
  ["adjacent-bare", '"a b" c'],
  ["flag-then-quoted", '--title "Fix the bug" --body-file "C:\\Users\\Jan Kowalski\\note.md"'],
  ["trailing-backslash", '"C:\\Users\\Jan Kowalski\\" next'],
]

describe.runIf(windows)("Codex on Windows (grants probe)", () => {
  const it = e2e(withKit(codex))

  it("records the hooks' payloads, the shell, and PowerShell's argv", async ({ e2e: run }) => {
    const kit = kitOf(run.sandbox.root)
    const script = join(kit.dir, "argv.cjs")
    const posix = script.replaceAll("\\", "/")
    const argv = (args: string) => `ndargv.exe ${script} ${args}`
    const words = "plain a,b %COMSPEC% a=b -R octo/repo x:y C:\\path --title=x 'a b'"
    const ps51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
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
      // Which words split the same in cmd and PowerShell: one line, its argv read whole.
      { name: "argv-words-default", cmd: argv(words) },
      { name: "argv-words-cmd", shell: "cmd", cmd: argv(words) },
      { name: "argv-words-pwsh", shell: "pwsh", cmd: argv(words) },
      { name: "argv-comma-cmd", shell: "cmd", cmd: argv("a,b") },
      { name: "argv-quoted-cmd", shell: "cmd", cmd: argv("'a''b' \"x y\"") },
      // The whole-word double-quoted forms the Windows dialect takes (design A1): each must
      // arrive as one argv entry, under Codex's default shell and under cmd.
      ...quotedForms.flatMap(([name, text]) => [
        { name: `argv-quoted-${name}`, cmd: argv(text) },
        { name: `argv-quoted-${name}-cmd`, shell: "cmd", cmd: argv(text) },
      ]),
      // Windows PowerShell 5.1 by its full path.
      {
        name: "ps51-version",
        shell: ps51,
        cmd: "$PSVersionTable.PSVersion.ToString(); $PSVersionTable.PSEdition",
      },
      { name: "ps51-argv-comma", shell: ps51, cmd: argv("a,b") },
      { name: "ps51-argv-sq-doubled", shell: ps51, cmd: argv("'a''b'") },
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
    // The first argv program also looks at its ancestors.
    writeFileSync(join(kit.dir, "ancestry"), "")
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
  readonly grant?: readonly string[] | ((line: string) => readonly string[])
  /** `--settings` content in place of the grant's. */
  readonly settings?: unknown
  /** Run under a cmd AutoRun that prints (CI's runner only), and print how the hook was spawned. */
  readonly autorun?: boolean
  /** Under Novadeck's own cmd.exe pass-through, installed by the runner, which logs and runs the real cmd with /d. */
  readonly pathcmd?: boolean
  /** The model's command line, given the marker program's script and the file it writes. */
  readonly line?: (script: string, marker: string) => string
  /** A program with no arguments: a batch file of the kit that writes the marker. */
  readonly noArgs?: boolean
  /** The hook (and, with `marker`, the marker program) also logs its ancestors, after its answer. */
  readonly ancestry?: boolean
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
  // How agy spawns the hook: the answer first, then the hook (and the command) look upward.
  {
    name: "a1-ancestry",
    form: "direct",
    grant: both,
    answer: decision("force_ask"),
    ancestry: true,
    press: "1",
  },
  // How agy spawns an exe-alone hook: through cmd, whose AutoRun output then breaks the
  // hook's JSON, or directly. The hook answers force_ask and the launch grant covers the
  // command: a dialog shows only where the answer was read (PROBE agy hook spawn verdict).
  {
    name: "z1-spawn-autorun",
    form: "direct",
    grant: both,
    answer: decision("force_ask"),
    autorun: true,
  },
  // If Antigravity finds cmd through PATH (Go does not read ComSpec), a wrapper that adds /d skips
  // the AutoRun, so the hook's JSON is read and force_ask's dialog shows.
  {
    name: "z1c-spawn-pathcmd",
    form: "direct",
    grant: both,
    answer: decision("force_ask"),
    autorun: true,
    pathcmd: true,
  },
  // Why the launch grant did not apply (n1..n3 still asked): do settings count at all, and
  // what spelling matches?
  {
    name: "s1-always-proceed",
    form: "none",
    settings: { toolPermission: "always-proceed" },
  },
  { name: "s2-grant-exact-line", form: "none", grant: (line) => [`command(${line})`] },
  {
    name: "s3-noargs-program",
    form: "none",
    noArgs: true,
    grant: ["command(ndnoarg)", "command(ndnoarg.cmd)"],
  },
  {
    name: "s4-forward-slash-exact",
    form: "none",
    line: (script, marker) =>
      `ndmarker.exe ${script.replaceAll("\\", "/")} ${marker.replaceAll("\\", "/")}`,
    grant: (line) => [`command(${line})`, "command(ndmarker.exe)"],
  },
  {
    name: "s4b-forward-slash-fullpath",
    form: "none",
    line: (script, marker) =>
      `${script.replace(/[\\/]argv\.cjs$|[\\/]marker\.cjs$/, "").replaceAll("\\", "/")}/bin/ndmarker.exe ${script.replaceAll("\\", "/")} ${marker.replaceAll("\\", "/")}`,
    grant: (line) => [`command(${line.split(" ")[0]})`],
  },
  { name: "s5-glob", form: "none", grant: ["command(ndmarker.exe *)", "command(ndmarker.exe:*)"] },
  // Probed 2026-11-01 (1.4.12): `--settings` takes a file path alone. Inline JSON, quoted for
  // PowerShell or cmd, fails to start ("reading --settings file: open '{permissions:...}'").
]
const only = process.env.WINDOWS_GRANTS_CASE?.split(",")

describe.runIf(windows)("Antigravity on Windows (grants probe)", () => {
  const plain = e2e(withKit(agy))
  const wrapped = e2e(withKit(agy, true))

  for (const c of agyCases) {
    if (only && !only.some((one) => c.name.startsWith(one))) continue
    const it = c.pathcmd ? wrapped : plain
    it(
      c.name,
      async ({ e2e: run, skip }) => {
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

        const marker = join(kit.dir, "ran.txt")
        const script = join(kit.dir, "marker.cjs")
        if (c.noArgs) writeFileSync(join(kit.bin, "ndnoarg.cmd"), `@echo ran>>"${marker}"\r\n`)
        const line = c.noArgs
          ? "ndnoarg.cmd"
          : (c.line?.(script, marker) ?? `${c.program ?? "ndmarker.exe"} ${script} ${marker}`)
        if (c.ancestry) {
          writeFileSync(join(kit.dir, "ancestry-hook"), "")
          writeFileSync(join(kit.dir, "ancestry-marker"), "")
        }
        const grants = typeof c.grant === "function" ? c.grant(line) : c.grant
        const settings =
          c.settings ?? (grants === undefined ? undefined : { permissions: { allow: grants } })
        let flags = ""
        if (settings !== undefined) {
          const file = join(kit.dir, "grant.json")
          const json = JSON.stringify(settings)
          writeFileSync(file, json)
          flags = ` --settings ${file}`
        }
        probe("agy settings", { flags, settings: settings ?? null })
        // Antigravity takes `--settings` from 1.4.10 on; before it, the launch prints its usage.
        if (flags !== "" && !(await takesSettings()))
          return skip("this Antigravity takes no --settings (before 1.4.10)")
        if (c.pathcmd && process.env.GITHUB_ACTIONS !== "true")
          return skip("the PATH cmd wrapper runs on CI's runner only")
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

        if (c.autorun && !c.pathcmd) onTestFinished(printingAutoRun())
        const t = await run.deck.open(`agy${flags}`)
        try {
          await t.reached("ready", { timeoutMs: 60_000 })
        } catch (error) {
          await notReady("agy pathcmd", kit, run.sandbox.home, t)
          throw error
        }
        await prompted(t, agy)
        await t.submit("Run it")
        await sleep(c.mode === "sleep" ? 14_000 : 12_000)
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
        if (c.autorun)
          console.log(
            `PROBE agy hook spawn verdict: ${
              // Read: force_ask's dialog. Through cmd: AutoRun's output breaks the JSON, and a
              // non-JSON answer fails the call (h3). A run with no dialog would be the hook
              // ignored under a launch grant: fail-open, to be raised at once.
              dialog
                ? "direct"
                : ranBeforeKeys
                  ? "FAIL-OPEN: ran with no dialog"
                  : "cmd (no dialog, the call failed)"
            }`,
          )
        if (c.pathcmd) {
          const wrapper = passedOn(kit)
          probe("agy pathcmd wrapper log", wrapper.slice(0, 10))
          const ran = wrapper.length > 0
          // Whether run_command went through it: the marker program's line is in a wrapper entry.
          const viaWrapper = wrapper.some((one) => one.includes("marker.cjs"))
          console.log(
            `PROBE agy pathcmd verdict: ${ran ? (dialog ? "works" : "wrapper ran but no dialog") : "wrapper never ran"}`,
          )
          console.log(`PROBE agy pathcmd run_command via wrapper: ${viaWrapper}`)
          // The product path works: the hook's force_ask was read (its dialog shows, the command
          // did not run unasked), and the pass-through Novadeck installed ran hooks.
          expect(dialog, "force_ask's dialog shows").toBe(true)
          expect(ranBeforeKeys, "the command ran with no dialog").toBe(false)
          expect(wrapper.length, "the pass-through's log").toBeGreaterThan(0)
          // /d only for Novadeck's own hooks: the agent's tools' cmd keeps the person's AutoRun.
          const hooks = wrapper.filter((one) => /if defined novadeck_hook/i.test(one))
          expect(hooks.length, "hooks went through the pass-through").toBeGreaterThan(0)
          expect(
            hooks.every((one) => one.startsWith("/d ")),
            "every hook got /d",
          ).toBe(true)
          expect(
            wrapper.filter((one) => !hooks.includes(one)).some((one) => one.startsWith("/d ")),
            "no other cmd got /d",
          ).toBe(false)
        }
        report(`agy ${c.name}`, kit)
        // Antigravity's own settings and logs, where the grants may have been read or refused.
        const gemini = join(run.sandbox.home, ".gemini")
        if (existsSync(gemini))
          for (const file of readdirSync(gemini, { recursive: true, encoding: "utf8" })) {
            if (!/(settings\.json|\.log|\.jsonl?)$/.test(file) || /plugins|brain/.test(file))
              continue
            try {
              const text = readFileSync(join(gemini, file), "utf8")
              probe("agy home file", { case: c.name, file, tail: text.slice(-3500) })
            } catch {
              // A folder, or a file in use.
            }
          }
      },
      240_000,
    )
  }
})

// Novadeck started under an AutoRun that prints, with a plain Antigravity (no launch grant):
// what its messaging does there today, as Novadeck's own hooks and relay are installed.
describe.runIf(windows && process.env.GITHUB_ACTIONS === "true")(
  "Antigravity on Windows under a printing AutoRun",
  () => {
    let restore: (() => void) | undefined
    beforeAll(() => {
      restore = printingAutoRun()
    })
    afterAll(() => restore?.())

    // Without and with the /d cmd wrapper first on PATH: is Novadeck's messaging delivered?
    for (const pathcmd of [false, true]) {
      const it = e2e(withKit(agy, pathcmd))
      it(
        pathcmd ? "z3-plain-messaging-pathcmd" : "z2-plain-messaging",
        async ({ e2e: run, skip }) => {
          if (pathcmd && !(await takesSettings())) return skip("the wrapper probes run on 1.4.10+")
          run.model.use(
            sends("Ask fox for its colour", "fox", "What is your colour?"),
            own((call) => (sent(call, "fox") ? { text: "Asked." } : undefined)),
            own((call) => (delivered(call, "moth") ? { text: "Mine is teal." } : undefined)),
          )
          const outcome: Record<string, unknown> = {}
          try {
            const t1 = await start(run, agy)
            const t2 = await start(run, agy)
            outcome.started = true
            await t1.submit("Ask fox for its colour")
            outcome.delivered = await run.model
              .waitFor((call) => delivered(call, "moth"), { timeoutMs: 45_000 })
              .then(
                () => true,
                () => false,
              )
            outcome.messages = messages(t1).map((one) => [one.from, one.to, one.state])
            outcome.t1 = rows(await t1.screen())
            outcome.t2 = rows(await t2.screen())
          } catch (error) {
            outcome.error = String(error).slice(0, 1500)
            if (pathcmd)
              await notReady("agy pathcmd", kitOf(run.sandbox.root), run.sandbox.home, undefined)
          }
          if (pathcmd) {
            outcome.wrapperRuns = passedOn(kitOf(run.sandbox.root)).length
          }
          probe(
            pathcmd
              ? "agy plain terminal under AutoRun with Novadeck's cmd.exe pass-through"
              : "agy plain terminal under AutoRun",
            outcome,
          )
          // With the pass-through, Novadeck's messaging is delivered and its log is not empty.
          if (pathcmd) {
            expect(outcome.error).toBeUndefined()
            expect(outcome.delivered, "the message was delivered").toBe(true)
            expect(outcome.wrapperRuns, "the pass-through's log").toBeGreaterThan(0)
          }
        },
        240_000,
      )
    }
  },
)

// ---- The grants themselves, through Novadeck's runner hooks (as approvals.e2e.ts does on
// Linux): a real `approval` ask the person approves, a `pr` team grant, and fake `gh` and
// `uberepo` batch files that append their command line to a marker file.

const granted = "gh pr ready 12 -R octo/repo"
const merge = "gh pr merge 12 -R octo/repo"
const grantedArgv = ["gh", "pr", "ready", "12", "-R", "octo/repo"]

type World = { readonly marker: string; readonly readme: string }
const worlds = new Map<string, World>()

const withFakes = (setup: AgentSetup): AgentSetup => ({
  ...setup,
  prepare: async (sandbox, model, installed, seed) => {
    const env = await setup.prepare(sandbox, model, installed, seed)
    const dir = mkdtempSync(join(tmpdir(), "ndg-"))
    const marker = join(dir, "ran.txt")
    // A space before `>>`: an argument ending in a digit would else read as a handle.
    for (const name of ["gh", "uberepo"])
      writeFileSync(join(dir, `${name}.cmd`), `@echo ${name} %* >> "${marker}"\r\n`)
    const readme = join(sandbox.project, "README.txt")
    writeFileSync(readme, "novadeck-approvals-readme\n")
    worlds.set(sandbox.root, { marker, readme })
    return { ...env, PATH: [dir, sandbox.env.PATH].join(delimiter) }
  },
})

const marksOf = (world: World): string[] =>
  existsSync(world.marker)
    ? readFileSync(world.marker, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : []

type Harness = {
  readonly setup: AgentSetup
  readonly command: string
  readonly shell: (command: string) => Reply
  readonly dialog: RegExp
  readonly refuse: string
}

const codexKit: Harness = {
  setup: withFakes(codex),
  command: "codex",
  shell: (command) => ({
    calls: [
      {
        name: "exec_command",
        input: {
          cmd: command,
          sandbox_permissions: "require_escalated",
          justification: "Run it outside the sandbox",
        },
      },
    ],
  }),
  dialog: /Would you like to run the following command\?/,
  refuse: "\x1b",
}

const agyKit: Harness = {
  setup: withFakes(agy),
  command: "agy",
  shell: (command) => ({
    calls: [
      {
        name: "run_command",
        input: { CommandLine: command, WaitMsBeforeAsync: 5000, toolSummary: "Run it" },
      },
    ],
  }),
  dialog: /> 1\. Yes, run command/,
  refuse: "4",
}

const waitScreen = async (
  terminal: DeckTerminal,
  what: string,
  check: (screen: string) => boolean,
  timeoutMs = 60_000,
): Promise<string> => {
  const end = Date.now() + timeoutMs
  for (;;) {
    const screen = await terminal.screen()
    if (check(screen)) return screen
    if (Date.now() > end)
      throw new Error(`${what}: not seen in ${timeoutMs} ms; screen:\n${screen}`)
    await sleep(250)
  }
}

const openKit = async (run: E2E, kit: Harness): Promise<DeckTerminal> => {
  const terminal = await run.deck.open(kit.command)
  await terminal.reached("ready", { timeoutMs: 60_000 })
  await prompted(terminal, kit.setup)
  return terminal
}

const approvalAsk = (call: Call): Reply | undefined => {
  const reading =
    call.turns.at(-1)?.role === "tool" &&
    call.turns
      .findLast((entry) => entry.role === "assistant")
      ?.calls.some(
        (entry) => entry.name === "read_file" && /[/\\]ask\.json$/.test(String(entry.input.Path)),
      ) === true
  if (asked(call, "get approval") && call.tools.includes("call_mcp_tool")) {
    const named = /directory `([^`]+)[/\\]<serverName>`/.exec(call.system)?.[1]
    if (!named) throw new Error("Antigravity named no MCP schema folder")
    const home = /^App Data Directory: (.+)$/m.exec(call.system)?.[1]?.trim()
    const folder =
      home && named.includes("<appDataDir>") ? named.replace("<appDataDir>", home) : named
    return {
      calls: [
        { name: "read_file", input: { Path: join(folder, "novadeck_novadeck", "ask.json") } },
      ],
    }
  }
  if (!asked(call, "get approval") && !reading) return undefined
  const name = tool(call, "ask")
  if (!name) throw new Error("Novadeck's ask tool is missing")
  return {
    calls: [
      {
        name,
        input: {
          subject: "May I run gh pr ready?",
          body: "I need to mark pull request 12 ready, and would like not to ask again.",
          hard_to_undo: "It tells the reviewers.",
          shape: { type: "approval", commands: [{ argv: grantedArgv, rest: false }] },
        },
      },
    ],
  }
}

for (const kit of [codexKit, agyKit]) {
  const { setup } = kit
  describe.runIf(windows)(`${setup.name} on Windows: a person's approval`, () => {
    const it = e2e(setup)
    it("a granted command runs unasked, and only that", async ({ e2e: run }) => {
      const world = () => worlds.get(run.sandbox.root)!
      const shellFor = (command: string) => kit.shell(command)
      run.model.use(
        own((call) => {
          const ask = approvalAsk(call)
          if (ask) return ask
          if (asked(call, "run granted") || asked(call, "run again")) return shellFor(granted)
          if (asked(call, "run merge")) return shellFor(merge)
          // Only Antigravity has a file-read tool and a launch-grant boundary to probe. Its prompt
          // avoids "read it", which the grant notice holds ("both read it alike").
          if (setup.agent === "agy" && asked(call, "run echo")) return shellFor("echo hi > hi.txt")
          if (setup.agent === "agy" && asked(call, "show readme"))
            return { calls: [{ name: "read_file", input: { Path: world().readme } }] }
          if (call.turns.at(-1)?.role === "tool") return { text: "Done." }
          return undefined
        }),
      )
      const [major = 0, minor = 0, patch = 0] = (await installHarness(setup.agent)).version
        .split(".")
        .map(Number)
      // Antigravity takes a grant as launch settings from 1.4.10 on.
      const launched =
        setup.agent !== "agy" ||
        major > 1 ||
        (major === 1 && (minor > 4 || (minor === 4 && patch >= 10)))
      probe("grants setup", { agent: setup.agent, launched })
      let terminal = await openKit(run, kit)
      const stopped = async (label: string, before: number) => {
        const screen = await waitScreen(terminal, label, (shown) => kit.dialog.test(shown))
        probe("grants dialog", { label, screen: rows(screen) })
        expect(marksOf(world()).length, label).toBe(before)
        terminal.press(kit.refuse)
        await sleep(2500)
      }

      await terminal.submit("run granted")
      await stopped("without a grant", 0)

      await terminal.submit("get approval")
      const entry = await (async () => {
        const end = Date.now() + 60_000
        for (;;) {
          const found = run.deck.terminals
            .inboxEntries()
            .find((each) => each.content.kind === "ask" && each.terminalId === terminal.id)
          if (found) return found
          if (Date.now() > end) throw new Error("no approval ask in the Inbox")
          await sleep(250)
        }
      })()
      expect(record(record(entry.content).ask).shape).toMatchObject({ type: "approval" })
      run.deck.terminals.answerAsk(entry.id, { type: "approve", lifetime: "until-done" })
      await sleep(2000)

      // A terminal started while the grant covers it takes the launch settings.
      if (setup.agent === "agy") {
        await run.deck.restart()
        terminal = await run.deck.restore(terminal, { resume: "agy" })
        await terminal.reached("ready", { timeoutMs: 60_000 })
        await prompted(terminal, setup)
      }

      await terminal.submit("run again")
      if (launched) {
        const end = Date.now() + 60_000
        while (marksOf(world()).length === 0 && Date.now() < end) await sleep(250)
        probe("grants granted-run", {
          marks: marksOf(world()),
          screen: rows(await terminal.screen()),
        })
        expect(marksOf(world())).toEqual([granted])
        expect(await terminal.screen()).not.toMatch(kit.dialog)
      } else {
        // Before 1.4.10 it restarts fine, its grant delivery says so, and the command still asks.
        await stopped("a grant it cannot take", 0)
        const text = run.model.calls
          .flatMap((call) => call.turns.map((turn) => turn.text))
          .join("\n")
        expect(text).toContain("<grant")
        expect(text).toContain("before 1.4.10 never takes it")
      }
      const ran = launched ? 1 : 0

      await terminal.submit("run merge")
      await stopped("merge", ran)
      if (setup.agent === "agy") {
        await terminal.submit("run echo")
        await stopped("echo", ran)
        await terminal.submit("show readme")
        await run.model.waitFor(
          (call) => result(call)?.includes("novadeck-approvals-readme") === true,
        )
        expect(await terminal.screen()).not.toMatch(kit.dialog)
      }
    }, 600_000)
  })
}

// A lead's `pr` team grant, then a Codex teammate runs the preset's commands unasked
// (the Windows dialect matches them, a spaced path in double quotes too), while a quoted body and a merge are asked.
describe.runIf(windows)("Codex on Windows: a pr team grant", () => {
  const it = e2e(codexKit.setup)
  it("the preset's commands run unasked, a spaced body-file path in double quotes too; a quoted body and a merge are asked", async ({
    e2e: run,
  }) => {
    const world = () => worlds.get(run.sandbox.root)!
    const repo = join(run.sandbox.project, "repo")
    mkdirSync(repo, { recursive: true })
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "origin", "https://github.com/octo/repo.git"],
    ])
      spawnSync("git", args, { cwd: repo })
    mkdirSync(join(run.sandbox.project, "notes"), { recursive: true })
    const body = join(run.sandbox.project, "notes", "body.md")
    writeFileSync(body, "A body.\n")
    // Codex's folder is unknown to the matcher, so a body file is a full path; and a project
    // path with a space (CI's is spaced) goes in whole-word double quotes, which the dialect takes.
    const spaced = /\s/.test(body)
    const steps = [
      granted,
      "gh pr create --fill --head feat -R octo/repo",
      `gh pr comment 12 -R octo/repo --body-file ${spaced ? `"${body}"` : body}`,
      "gh pr comment 12 -R octo/repo --body 'two words'",
      merge,
    ]
    const state = { done: false, issued: 0 }
    run.model.use(
      own((call) => {
        if (asked(call, "propose it")) {
          const name = tool(call, "propose_grant")
          if (!name) throw new Error("Novadeck's propose_grant tool is missing")
          return {
            calls: [{ name, input: { presets: ["pr"], reason: "Pull requests for octo/repo" } }],
          }
        }
        if (asked(call, "open the teammate")) {
          const name = tool(call, "open_agent")
          if (!name) throw new Error("Novadeck's open_agent tool is missing")
          return {
            calls: [
              { name, input: { agent: "codex", message: "tm-brief: run the pull requests" } },
            ],
          }
        }
        if (call.turns.some((turn) => turn.role === "user" && turn.text.includes("tm-brief"))) {
          // Refusing a dialog ends Codex's turn with no result, so the steps are counted as they
          // are issued, and a "go on" after each refusal asks for the next.
          const last = call.turns.at(-1)
          if (state.issued === 0) return codexKit.shell(steps[state.issued++]!)
          if (last?.role === "user" && last.text.includes("go on") && state.issued < steps.length)
            return codexKit.shell(steps[state.issued++]!)
          if (last?.role === "tool") {
            if (state.issued < steps.length) return codexKit.shell(steps[state.issued++]!)
            state.done = true
            return { text: "Teammate done." }
          }
        }
        if (call.turns.at(-1)?.role === "tool") return { text: "Done." }
        return undefined
      }),
    )
    const requests = run.deck.answerRequests()
    const lead = await openKit(run, codexKit)
    await lead.submit("propose it")
    const card = await (async () => {
      const end = Date.now() + 60_000
      for (;;) {
        const found = run.deck.terminals
          .inboxEntries()
          .find((each) => each.content.kind === "grant" && each.terminalId === lead.id)
        if (found) return found
        if (Date.now() > end) throw new Error("no Grant card in the Inbox")
        await sleep(250)
      }
    })()
    run.deck.terminals.answerAsk(card.id, {
      type: "grant",
      presets: ["pr"],
      commands: [],
      repos: ["github.com/octo/repo"],
      withLead: false,
      lifetime: "until-done",
    })
    await sleep(2000)
    await lead.submit("open the teammate")
    const teammate = await requests.next(60_000)

    const dialogs: string[] = []
    const end = Date.now() + 300_000
    while (!state.done && Date.now() < end) {
      const screen = await teammate.screen()
      if (codexKit.dialog.test(screen)) {
        dialogs.push(screen)
        probe("grants dialog", { at: marksOf(world()).length, screen: rows(screen) })
        teammate.press(codexKit.refuse)
        await sleep(2500)
        if (dialogs.length === 2) break
        await teammate.submit("go on")
      }
      await sleep(500)
    }
    probe("grants team run", { done: state.done, marks: marksOf(world()), dialogs: dialogs.length })
    expect(marksOf(world())).toEqual(steps.slice(0, 3))
    expect(dialogs.length).toBe(2)
    expect(dialogs.at(-2)).toMatch(/two\s+words/)
    expect(dialogs.at(-1)).toMatch(/merge/)
  }, 900_000)
})

/** HKCU's AutoRun as reg.exe prints it: its type and its text, or undefined where it is absent. */
const autoRunValue = (): { readonly type: string; readonly text: string } | undefined => {
  const found = reg("query", autoRunKey, "/v", "AutoRun")
  const match = found.status === 0 ? /AutoRun\s+(REG_\w+)\s+(.*)$/m.exec(found.stdout) : null
  return match ? { type: match[1]!, text: match[2]!.trim() } : undefined
}

// ---- The one-click fix for a printing AutoRun (approvals-design.md, Appendix F): under the
// printing AutoRun the runner offers to silence it, the person's click writes exactly the
// wrapped value, the plugin is installed again in the same runner, a granted command runs
// unasked in an Antigravity opened afterwards, and Undo puts the original back byte for byte.
// CI's runner only; the AutoRun is restored whatever happens.

/** Sets the printing AutoRun before the runner starts, and has it put back as the test ends. */
const withPrintingAutoRun = (setup: AgentSetup): AgentSetup => ({
  ...setup,
  prepare: async (sandbox, model, installed, seed) => {
    const env = await setup.prepare(sandbox, model, installed, seed)
    onTestFinished(printingAutoRun())
    return env
  },
})

/** The runner's AutoRun state once `check` holds of it. */
const autoRunWhere = async (
  run: E2E,
  what: string,
  check: (state: { readonly state: string }) => boolean,
  timeoutMs = 60_000,
): Promise<Awaited<ReturnType<typeof stateNow>>> => {
  const end = Date.now() + timeoutMs
  for (;;) {
    const state = await stateNow(run)
    if (check(state)) return state
    if (Date.now() > end)
      throw new Error(`${what}: not seen in ${timeoutMs} ms; state: ${JSON.stringify(state)}`)
    await sleep(500)
  }
}

const stateNow = async (run: E2E) => {
  const controller = new AbortController()
  const stream = run.deck.autorun.watch(controller.signal)
  try {
    const first = await stream.next()
    if (first.done) throw new Error("the AutoRun's watch ended")
    return first.value
  } finally {
    controller.abort()
    await stream.return(undefined)
  }
}

describe.runIf(windows && process.env.GITHUB_ACTIONS === "true")(
  "Antigravity on Windows: silencing cmd's AutoRun",
  () => {
    const it = e2e(withPrintingAutoRun(agyKit.setup))
    it("is offered under a printing AutoRun, writes exactly the wrapped value, installs the plugin again, lets a granted command run unasked in a new Antigravity, and Undo restores the original bytes", async ({
      e2e: run,
      skip,
    }) => {
      if (!(await takesSettings()))
        return skip("this Antigravity takes no --settings (before 1.4.10)")
      const original = "echo novadeck-ci: an AutoRun printed this"
      const wrapped = `(${original}) >nul 2>&1`
      const world = () => worlds.get(run.sandbox.root)!
      const printed = () => {
        const rem = spawnSync(process.env.COMSPEC || "cmd.exe", ["/c", "rem"], {
          encoding: "utf8",
        })
        return `${rem.stdout}${rem.stderr}`
      }
      // The raw bytes the registry holds, from the relay.
      const bytes = () => {
        const user = userAutoRun()
        return user?.found === "value" ? `${user.type} ${user.encoded}` : undefined
      }
      const bytesOf = (text: string) => `sz ${encodeValue(text)}`
      // Antigravity's own copy of Novadeck's plugin, which its hooks run from.
      const installedHooks = () =>
        readFileSync(
          join(
            harnesses.agy.installed!.directory({
              env: run.sandbox.env,
              home: run.sandbox.home,
              platform: process.platform,
              plugin: run.deck.shell.plugins.agy,
            }),
            "hooks.json",
          ),
          "utf8",
        )
      const checked = "uberepo check one"
      run.model.use(
        own((call) => {
          if (asked(call, "propose it")) {
            const name = tool(call, "propose_grant")
            if (!name) throw new Error("Novadeck's propose_grant tool is missing")
            return {
              calls: [
                {
                  name,
                  input: {
                    presets: [],
                    commands: [{ argv: ["uberepo", "check"], rest: true }],
                    reason: "Checks for the repo",
                  },
                },
              ],
            }
          }
          if (asked(call, "open the teammate")) {
            const name = tool(call, "open_agent")
            if (!name) throw new Error("Novadeck's open_agent tool is missing")
            return {
              calls: [{ name, input: { agent: "agy", message: "tm-brief: run the check" } }],
            }
          }
          if (call.turns.some((turn) => turn.role === "user" && turn.text.includes("tm-brief"))) {
            if (call.turns.at(-1)?.role === "tool") return { text: "Teammate done." }
            return agyKit.shell(checked)
          }
          if (call.turns.at(-1)?.role === "tool") return { text: "Done." }
          return undefined
        }),
      )

      // The offer: the original prints, the wrapped value does not.
      const offer = await autoRunWhere(run, "the offer", ({ state }) => state === "offer")
      probe("autorun offer", offer)
      expect(offer).toMatchObject({ state: "offer", current: original, next: wrapped })
      expect(bytes()).toBe(bytesOf(original))
      expect(printed()).toContain("an AutoRun printed this")
      expect(installedHooks()).not.toContain("PreToolUse")

      // The person's click writes exactly that, and cmd is clean.
      await run.deck.autorun.silence(wrapped)
      expect(bytes()).toBe(bytesOf(wrapped))
      expect(autoRunValue()).toEqual({ type: "REG_SZ", text: wrapped })
      expect(printed()).toBe("")
      expect(run.deck.autorun.printing()).toBe(false)
      const silenced = await stateNow(run)
      probe("autorun silenced", silenced)
      expect(silenced).toMatchObject({
        state: "silenced",
        restores: original,
        outcome: { kind: "applied-clean", waiting: [], restart: false },
      })
      // Without a restart, Antigravity's installed plugin registers PreToolUse now.
      expect(installedHooks()).toContain("PreToolUse")

      // A lead's team grant, then an Antigravity it opens afterwards, in the same runner,
      // runs the granted command unasked.
      const requests = run.deck.answerRequests()
      const lead = await openKit(run, agyKit)
      await lead.submit("propose it")
      const card = await (async () => {
        const end = Date.now() + 60_000
        for (;;) {
          const found = run.deck.terminals
            .inboxEntries()
            .find((each) => each.content.kind === "grant" && each.terminalId === lead.id)
          if (found) return found
          if (Date.now() > end) throw new Error("no Grant card in the Inbox")
          await sleep(250)
        }
      })()
      run.deck.terminals.answerAsk(card.id, {
        type: "grant",
        presets: [],
        commands: [0],
        repos: [],
        withLead: false,
        lifetime: "until-done",
      })
      await sleep(2000)
      await lead.submit("open the teammate")
      // The teammate starts on its brief at once, so it may never show ready: its run is the mark.
      const teammate = await requests.next(60_000)
      const end = Date.now() + 90_000
      while (marksOf(world()).length === 0 && Date.now() < end) await sleep(250)
      probe("autorun granted-run", {
        marks: marksOf(world()),
        screen: rows(await teammate.screen()),
      })
      expect(marksOf(world())).toEqual([checked])
      expect(await teammate.screen()).not.toMatch(agyKit.dialog)

      // Undo is refused while an Antigravity of Novadeck's runs, and the value stays.
      await run.deck.autorun.undo()
      expect(await stateNow(run)).toMatchObject({
        state: "silenced",
        outcome: { kind: "undo-refused", restart: false },
      })
      expect(bytes()).toBe(bytesOf(wrapped))

      // Closed, Undo restores the original bytes exactly, and the plugin drops PreToolUse.
      await run.deck.terminals.close({ terminalId: teammate.id })
      await run.deck.terminals.close({ terminalId: lead.id })
      const closing = Date.now() + 30_000
      while (run.deck.terminals.approving.running("agy").length > 0 && Date.now() < closing)
        await sleep(250)
      await run.deck.autorun.undo()
      expect(bytes()).toBe(bytesOf(original))
      expect(installedHooks()).not.toContain("PreToolUse")
      expect(await stateNow(run)).toMatchObject({
        state: "offer",
        current: original,
        outcome: { kind: "undone" },
      })
      expect(run.deck.autorun.printing()).toBe(true)
    }, 900_000)
  },
)
