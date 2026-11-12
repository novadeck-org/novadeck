// PROBE, not a test of Novadeck: where a background shell's output can be read while it runs,
// for each harness on each system, toward a companion-pane item that shows it. The agent starts
// three background commands as shells.e2e.ts does; the first two first source a script that
// records how the harness ran them (the shell's command line and parent, whether output is a
// terminal, the user, and which folders it may write to and run a program from), and the
// first then prints a line every 2 s. While it runs the probe samples the size of every log
// that may hold that output: Claude Code's `tasks/<id>.output` (the path its tool result
// names), Antigravity's `task-N.log`, and for Codex, which writes its output nowhere, the log
// of a capture hook. Codex runs with its sandbox on (`workspace-write`), as people run it.
//
// The Codex hook, on Linux and macOS: BASH_ENV (bash) or ZDOTDIR's .zshenv (zsh), set through
// its `shell_environment_policy`, copies a command's output to a log with `tee` where it has no
// terminal, in the first folder it may write: a folder in the real home (as Novadeck's data
// folder is), the system's temp folder, the project. On Windows Codex runs PowerShell, which
// no variable hooks: the probe records only what a pass-through on PATH would meet there
// (its sandbox's user, what it may write and run, whether output is redirected), with the
// second command run in a terminal (`tty`), as a pass-through can't read a pseudoconsole.
//
// It records rather than checks: everything goes to $PROBE_OUT/shell-output-<agent>-<system>/.
// Runs only with NOVADECK_E2E_PROBES=1, by path (.github/workflows/shell-output-probe.yml).
/* eslint-disable no-await-in-loop -- A probe samples one moment after another. */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { setups } from "../agents/index.js"
import type { DeckTerminal } from "../deck.js"
import { describe, e2e, supported } from "../fixture.js"
import { asked, type Call, type Reply } from "../model/script.js"
import { allowClaude, openCodex } from "../outcomes.js"
import { own, start } from "../scenarios.js"
import { probing, sleep } from "./support.js"

const windows = process.platform === "win32"
const system = windows ? "windows" : process.platform === "darwin" ? "macos" : "linux"
// Claude Code on Windows runs Git Bash; Codex and Antigravity run PowerShell there.
const powershell = (agent: string) => windows && agent !== "claude"

// A folder in the real home, as Novadeck's data folder is, and one in the system's temp folder.
const homeDir = join(homedir(), ".novadeck-shell-probe")
const tempDir = join(tmpdir(), "novadeck-shell-probe")
// A folder in the real home that Codex's sandbox is told it may write (`writable_roots`).
const rootDir = join(homedir(), ".novadeck-shell-root")

const commands = (agent: string) =>
  powershell(agent)
    ? [
        `. ./probe.ps1 ${agent}-1; 1..12 | ForEach-Object { "tick $_"; Start-Sleep 2 }; exit 3`,
        `. ./probe.ps1 ${agent}-2; sleep 30; exit 0`,
        "sleep 600",
      ]
    : [
        `. ./probe.sh ${agent}-1; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo tick $i; sleep 2; done; exit 3`,
        `. ./probe.sh ${agent}-2; sleep 30; exit 0`,
        agent === "claude" ? "while true; do sleep 1; done" : "sleep 600",
      ]

const launch = (agent: string, command: string, index: number): Reply => {
  if (agent === "claude")
    return {
      calls: [
        {
          name: "Bash",
          input: { command, description: `Probe ${index}`, run_in_background: true },
        },
      ],
    }
  if (agent === "codex")
    return {
      calls: [
        {
          name: "exec_command",
          input: { cmd: command, yield_time_ms: 500, ...(index === 1 ? { tty: true } : {}) },
        },
      ],
    }
  return {
    calls: [
      {
        name: "run_command",
        input: { CommandLine: command, WaitMsBeforeAsync: 500, toolSummary: `Probe ${index}` },
      },
    ],
  }
}

const started = (call: Call): string[] =>
  call.turns
    .filter((turn) => turn.role === "tool")
    .map((turn) => turn.text)
    .filter((text) => /background|session ID|Process exited/.test(text))

const stopping = (call: Call, agent: string): Reply => {
  const text = started(call)[2] ?? ""
  if (agent === "claude")
    return { calls: [{ name: "TaskStop", input: { task_id: /ID: (\w+)/.exec(text)?.[1] } }] }
  return {
    calls: [
      { name: "manage_task", input: { Action: "kill", TaskId: /task id: (\S+)/.exec(text)?.[1] } },
    ],
  }
}

const approve = async (t: DeckTerminal): Promise<void> => {
  const request = (await t.detail()).requests.find((each) => !each.answered)
  const { dialog } = request ?? {}
  const yes = dialog?.type === "choices" ? dialog.options[0] : undefined
  if (request && dialog?.type === "choices" && yes)
    await t
      .answer(request.ref, { dialog: dialog.id, type: "choice", option: yes.id })
      .catch(() => undefined)
}

// What a command sources first, in bash or zsh: how it was run, and what it may write and run.
const probeSh = (project: string) => `nd_label=$1
if [ -t 1 ]; then nd_t1=yes; else nd_t1=no; fi
if [ -t 0 ]; then nd_t0=yes; else nd_t0=no; fi
{
  echo "label=$nd_label flags=$- tty1=$nd_t1 tty0=$nd_t0 pid=$$ ppid=$PPID user=$(id -un 2>&1)"
  echo "self=$(ps -o args= -p $$ 2>&1 | cut -c1-400)"
  echo "parent=$(ps -o args= -p $PPID 2>&1 | cut -c1-300)"
  echo "BASH_ENV=\${BASH_ENV-unset} ZDOTDIR=\${ZDOTDIR-unset} SHELL=$SHELL TMPDIR=\${TMPDIR-unset} TERM=\${TERM-unset}"
  mkdir -p "\${TMPDIR:-/tmp}/novadeck-shell-probe" 2>&1
  for nd_d in "${rootDir}" "\${TMPDIR:-/tmp}/novadeck-shell-probe" "${homeDir}" "${tempDir}" "${project}"; do
    if : > "$nd_d/write-$nd_label" 2>/dev/null; then echo "write ok $nd_d"; else echo "write FAIL $nd_d"; fi
  done
  if nd_r=$("${join(homeDir, "bin", "nd-id")}" -un 2>&1); then echo "run ok from home: $nd_r"; else echo "run FAIL from home: $nd_r"; fi
} > "./probe-$nd_label.txt" 2>&1
`

const probePs1 = (project: string) => `param($label)
$lines = @()
try {
  $me = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($me.ParentProcessId)"
  $grand = Get-CimInstance Win32_Process -Filter "ProcessId=$($parent.ParentProcessId)"
  $lines += "self=$($me.CommandLine)"
  $lines += "parent=$($parent.Name) $($parent.CommandLine)"
  $lines += "grandparent=$($grand.Name) $($grand.CommandLine)"
} catch { $lines += "process tree FAIL $($_.Exception.Message)" }
$lines += "label=$label pid=$PID outRedirected=$([Console]::IsOutputRedirected) inRedirected=$([Console]::IsInputRedirected) ps=$($PSVersionTable.PSVersion) edition=$($PSVersionTable.PSEdition)"
$lines += "user=$([Security.Principal.WindowsIdentity]::GetCurrent().Name)"
$lines += "TEMP=$env:TEMP USERPROFILE=$env:USERPROFILE PATH0=$(($env:PATH -split ';')[0])"
try { New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP 'novadeck-shell-probe') -ErrorAction Stop | Out-Null } catch { $lines += "mkdir FAIL TEMP $($_.Exception.Message)" }
foreach ($d in @('${rootDir}', (Join-Path $env:TEMP 'novadeck-shell-probe'), '${homeDir}', '${tempDir}', '${project}')) {
  try { Set-Content -Path (Join-Path $d "write-$label") -Value x -ErrorAction Stop; $lines += "write ok $d" }
  catch { $lines += "write FAIL $d $($_.Exception.Message)" }
}
try { $r = & '${join(homeDir, "bin", "nd-whoami.exe")}' 2>&1; $lines += "run ok from home: $r" }
catch { $lines += "run FAIL from home: $($_.Exception.Message)" }
$lines | Set-Content -Path "./probe-$label.txt"
`

// Codex's capture hook (bash or zsh): its output, where it has no terminal, also to a log.
const hookSh = (project: string) => `unset BASH_ENV
nd_id=$(date +%s)-$$-$RANDOM
if [ -t 1 ]; then nd_t1=yes; else nd_t1=no; fi
nd_log=
mkdir -p "\${TMPDIR:-/tmp}/novadeck-shell-probe" 2>/dev/null
for nd_d in "${rootDir}" "\${TMPDIR:-/tmp}/novadeck-shell-probe" "${homeDir}" "${tempDir}" "${project}"; do
  if : > "$nd_d/out-$nd_id.log" 2>/dev/null; then nd_log=$nd_d/out-$nd_id.log; break; fi
done
{
  echo "id=$nd_id log=\${nd_log:-none} tty1=$nd_t1"
  echo "command:"
  printf '%s\\n' "\${BASH_EXECUTION_STRING:-$ZSH_EXECUTION_STRING}" | tail -n 3
} > "./hook-$nd_id.txt" 2>&1
if [ -n "$nd_log" ] && [ "$nd_t1" = no ]; then
  exec > >(tee -a "$nd_log") 2> >(tee -a "$nd_log" >&2)
  nd_rc=$?
  {
    echo "after exec rc=$nd_rc bash=$BASH_VERSION tee=$(command -v tee)"
    ls -l /dev/fd/ 2>&1
    echo probe-write >> "$nd_log" && echo "direct append ok"
  } >> "./hook-$nd_id.txt" 2>&1
  echo "hook-tee-test $nd_id"
fi
`

// Every log that may hold the first command's output, and how big each is now.
const logs = (
  home: string,
  claudeOutputs: ReadonlySet<string>,
  more: readonly string[] = [],
): string[] => {
  const found = [...claudeOutputs]
  for (const dir of [rootDir, homeDir, tempDir, ...more])
    if (existsSync(dir))
      for (const name of readdirSync(dir))
        if (/^out-.*\.log$/.test(name)) found.push(join(dir, name))
  const gemini = join(home, ".gemini")
  if (existsSync(gemini))
    for (const name of readdirSync(gemini, { recursive: true }) as string[])
      if (/task-\d+\.log$/.test(name)) found.push(join(gemini, name))
  return found
}

const sizeOf = (file: string): string => {
  try {
    return String(statSync(file).size)
  } catch {
    return "gone"
  }
}

for (const setup of setups) {
  describe.skipIf(!supported || !probing)(`probe: ${setup.name}'s background output`, () => {
    const it = e2e(setup)
    it(
      "records where a background shell's output can be read",
      { timeout: 300_000 },
      async ({ e2e: run }) => {
        const out = join(
          process.env.PROBE_OUT ?? join(run.sandbox.root, "probe-out"),
          `shell-output-${setup.agent}-${system}`,
        )
        mkdirSync(out, { recursive: true })
        const note = (file: string, text: string) => appendFileSync(join(out, file), `${text}\n`)
        const { project, home } = run.sandbox
        mkdirSync(join(homeDir, "bin"), { recursive: true })
        mkdirSync(tempDir, { recursive: true })
        mkdirSync(rootDir, { recursive: true })
        // The commands' own temp folder, as the sandbox gives it them.
        const commandTemp = join(
          run.sandbox.env.TMPDIR ?? run.sandbox.env.TEMP ?? tmpdir(),
          "novadeck-shell-probe",
        )
        if (windows)
          copyFileSync(
            join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
            join(homeDir, "bin", "nd-whoami.exe"),
          )
        else copyFileSync("/usr/bin/id", join(homeDir, "bin", "nd-id"))
        writeFileSync(join(project, "probe.sh"), probeSh(project))
        writeFileSync(join(project, "probe.ps1"), probePs1(project))

        if (setup.agent === "claude") allowClaude(run)
        if (setup.agent === "codex") {
          openCodex(run)
          const config = join(home, ".codex", "config.toml")
          const zdot = join(project, "zdot")
          mkdirSync(zdot, { recursive: true })
          writeFileSync(join(project, "hook.sh"), hookSh(project))
          writeFileSync(
            join(zdot, ".zshenv"),
            `unset ZDOTDIR\n[ -f "$HOME/.zshenv" ] && . "$HOME/.zshenv"\n. "${join(project, "hook.sh")}"\n`,
          )
          const hooks = windows
            ? ""
            : `shell_environment_policy = { set = { BASH_ENV = ${JSON.stringify(join(project, "hook.sh"))}, ZDOTDIR = ${JSON.stringify(zdot)} } }\n`
          writeFileSync(
            config,
            hooks +
              `sandbox_workspace_write = { writable_roots = [${JSON.stringify(rootDir)}] }\n` +
              readFileSync(config, "utf8").replace(
                'sandbox_mode = "danger-full-access"',
                'sandbox_mode = "workspace-write"',
              ),
          )
          note("codex-config.toml", readFileSync(config, "utf8"))
        }

        const claudeOutputs = new Set<string>()
        run.model.use(
          own((call) => {
            for (const text of started(call)) {
              const path = /Output is being written to: (.+?\.output)/.exec(text)?.[1]
              if (path) claudeOutputs.add(path)
            }
            const said = (text: string) =>
              call.turns.some((turn) => turn.role === "user" && turn.text.includes(text))
            const last = call.turns.at(-1)
            if (said("Stop the shell")) {
              if (last?.role === "tool") return { text: "Stopped." }
              return last?.text.includes("Stop the shell")
                ? stopping(call, setup.agent)
                : { text: "Noted." }
            }
            if (
              said("Start the shells") &&
              (last?.role === "tool" || asked(call, "Start the shells"))
            ) {
              const done = started(call).length
              return done < 3
                ? launch(setup.agent, commands(setup.agent)[done]!, done)
                : { text: "Shells started." }
            }
            return { text: "Noted." }
          }),
        )

        const collect = () => {
          for (const name of readdirSync(project))
            if (/^(probe-.*|hook-.*)\.txt$/.test(name))
              writeFileSync(join(out, name), readFileSync(join(project, name)))
          for (const file of logs(home, claudeOutputs, [commandTemp, project]))
            note(
              "logs.txt",
              `== ${file} (${sizeOf(file)} bytes)\n${existsSync(file) ? readFileSync(file, "utf8").slice(0, 2000) : ""}`,
            )
        }

        const t = await start(run, setup)
        const shells = () => t.summary().activity?.shells ?? []
        try {
          await t.submit("Start the shells")
          await t.poll(
            async () => {
              await approve(t)
              return shells().length === 3 && (await t.screen()).includes("Shells started.")
                ? true
                : undefined
            },
            "the three shells told",
            90_000,
          )
          note("shells.json", JSON.stringify(shells(), null, 2))
          // The first prints a line every 2 s for 24 s: a log that grows between samples is live.
          for (let i = 0; i < 8; i++) {
            const sizes = logs(home, claudeOutputs, [commandTemp, project]).map(
              (file) => `${file}=${sizeOf(file)}`,
            )
            note("sizes.txt", `${Date.now()} ${sizes.join(" ")}`)
            await sleep(2000)
          }
          collect()
          await t
            .poll(
              () => (shells().filter((shell) => shell.exit).length >= 2 ? true : undefined),
              "two shells to end",
              60_000,
            )
            .catch(() => undefined)
          note("shells.json", JSON.stringify(shells(), null, 2))
        } catch (error) {
          note("error.txt", String(error))
          note("screen.txt", await t.screen().catch(() => ""))
          collect()
          throw error
        } finally {
          if (setup.agent === "codex") await t.submit("/stop").catch(() => undefined)
          else await t.submit("Stop the shell").catch(() => undefined)
          await t
            .poll(
              async () => {
                await approve(t)
                return shells().filter((shell) => shell.exit).length === 3 ? true : undefined
              },
              "every shell to end",
              60_000,
            )
            .catch(() => undefined)
          note("shells.json", JSON.stringify(shells(), null, 2))
          note("logs.txt", "== after the end")
          collect()
        }
      },
    )
  })
}
