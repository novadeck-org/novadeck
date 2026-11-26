import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

import { readLock } from "@novadeck/harness-claude/daemon"
import { anyRunning, userScopes } from "@novadeck/terminal/pty"

import { harnesses } from "../harnesses/registry.js"
import type { AgentSetup } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, gated, supported, type E2E } from "./fixture.js"
import { asked } from "./model/script.js"
import { allowLabel, lacking, own, prompted, replies, result, start, turn } from "./scenarios.js"

// How long a quit may take in all: the five seconds the app gives the runner.
const quitMs = 5_000

const macOS = process.platform === "darwin"

/** Detaches a command into a session of its own: macOS has no `setsid` program. */
const setsid = macOS ? `perl -MPOSIX -e 'fork and exit; POSIX::setsid(); exec @ARGV'` : "setsid"

/** The ways a program leaves its shell's tree as the shell exits, each once. */
const variants = ["subshell", "nohup", "setsid", "disown"] as const

/**
 * A program that runs until it is ended, and says it is up by its name and pid, beside itself
 * whatever folder it runs in, as an app launchd starts runs in `/`.
 */
const server = `
import { appendFileSync } from "node:fs"
appendFileSync(new URL("detached.pids", import.meta.url), process.argv[2] + " " + process.pid + "\\n")
setInterval(() => {}, 1000)
`

// What the agent runs: each variant's server, started so that it outlives the script.
const script = (word: string): string => {
  const node = process.execPath
  const run = (name: string) => `${node} detached-server.mjs ${name} ${word} >/dev/null 2>&1`
  return `#!/bin/bash
(${run("subshell")} &)
nohup ${run("nohup")} &
${setsid} ${run("setsid")} &
${run("disown")} & disown
sleep 1; echo launched
`
}

/** The servers of this test that still run, by name, from outside, by the word in their command. */
const left = async (word: string): Promise<readonly string[]> => {
  const { stdout } = await promisify(execFile)("ps", ["-axww", "-o", "pid=,stat=,args="], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
    .split("\n")
    .flatMap((line) => {
      const row = /^\s*(\d+)\s+(\S+)\s+.*detached-server\.mjs (\S+) (\S+)/.exec(line)
      return row && !row[2]!.startsWith("Z") && row[4] === word ? [row[3]!] : []
    })
    .toSorted()
}

/** Ends what of this test's servers still runs, by its exact pid, as a failed test leaves them. */
const endServers = async (word: string): Promise<void> => {
  const { stdout } = await promisify(execFile)("ps", ["-axww", "-o", "pid=,args="], {
    maxBuffer: 64 * 1024 * 1024,
  })
  for (const line of stdout.split("\n"))
    if (line.includes("detached-server.mjs") && line.includes(word))
      try {
        process.kill(Number(line.trim().split(/\s+/)[0]), "SIGKILL")
      } catch {
        // Gone.
      }
}

type Inside = {
  records: Map<
    string,
    {
      bound: { binding: { instance: string | null } } | null
      terminal: { pty: { pid: number | undefined } }
    }
  >
}

/** The pid of the agent bound to `terminal`, as its hooks told it. */
const agentOf = (run: E2E, terminal: Pick<DeckTerminal, "id">): number | undefined => {
  const inside = run.deck.terminals as unknown as Inside
  const instance = inside.records.get(terminal.id)?.bound?.binding.instance
  return instance ? Number(instance) : undefined
}

/** The pid of `terminal`'s shell. */
const shellOf = (run: E2E, terminal: Pick<DeckTerminal, "id">): number => {
  const inside = run.deck.terminals as unknown as Inside
  const shell = inside.records.get(terminal.id)?.terminal.pty.pid
  if (shell === undefined) throw new Error("The terminal has no shell")
  return shell
}

/**
 * A process's start, as /proc/<pid>/stat holds it, or macOS's `ps -o lstart` in UTC, as Claude
 * Code's lock records it; undefined once it has gone.
 */
const startOf = async (pid: number): Promise<string | undefined> => {
  try {
    if (macOS)
      return (
        (
          await promisify(execFile)("ps", ["-o", "lstart=", "-p", String(pid)], {
            env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
          })
        ).stdout
          .trim()
          .replace(/\s+/g, " ") || undefined
      )
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  } catch {
    return undefined
  }
}

/** The `caffeinate` programs right under `pid`, by their pids. */
const caffeinated = async (pid: number): Promise<readonly number[]> => {
  if (!macOS) return []
  const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,ppid=,comm="], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.split("\n").flatMap((line) => {
    const [child, parent, command] = line.trim().split(/\s+/)
    return Number(parent) === pid && command?.endsWith("caffeinate") ? [Number(child)] : []
  })
}

/**
 * Has the agent run the script; allows it once where its harness asks, in that harness's words.
 * `timeoutMs` is how long the servers have to be up. On Windows the `Start-Process` launcher
 * (a fresh `powershell.exe`) is the slow one: in Claude Code's trace its command ran 61 s, and
 * in pi's five it was still running when the minute ran out, so those tests give it twice that.
 * What makes a PowerShell start take a minute on the runner is not known.
 */
const launch = async (
  run: E2E,
  setup: AgentSetup,
  terminal: DeckTerminal,
  count: number,
  timeoutMs = 60_000,
): Promise<void> => {
  const pids = join(run.sandbox.project, "detached.pids")
  const answered = new Set<string>()
  await terminal.prompt("Run the detach script")
  await terminal.poll(
    async () => {
      if (existsSync(pids) && readFileSync(pids, "utf8").trim().split("\n").length >= count)
        return true
      const [request] = (await terminal.detail()).requests
      if (request?.dialog?.type === "choices" && !answered.has(request.ref)) {
        answered.add(request.ref)
        const yes = request.dialog.options.find(
          (each) => allowLabel(setup).test(each.label) && each.text === null,
        )
        if (yes)
          await terminal.answer(request.ref, {
            dialog: request.dialog.id,
            type: "choice",
            option: yes.id,
          })
      }
      return undefined
    },
    "the servers to start",
    timeoutMs,
  )
}

// The scripted model: a first turn binds every harness to its terminal, then the script runs.
const scripted = (run: E2E, setup: AgentSetup, word: string, ran = script(word)) => {
  const { shell } = setup
  run.model.use(
    replies("Say ok", "Okay then."),
    own((call) =>
      asked(call, "Run the detach script") ? shell!.run(call, "bash detach.sh") : undefined,
    ),
    own((call) => (result(call) !== undefined ? { text: "Done." } : undefined)),
  )
  writeFileSync(join(run.sandbox.project, "detach.sh"), ran)
  writeFileSync(join(run.sandbox.project, "detached-server.mjs"), server)
  rmSync(join(run.sandbox.project, "detached.pids"), { force: true })
}

// Each terminal runs in a systemd scope of its own on Linux, which a program that left its
// shell's tree stays in: an agent's servers started detached used to outlive its terminal and
// Novadeck itself (#751's "What stays, not by choice"). Without the user's bus there are no
// scopes and nothing changes; CI has one, and may not skip this for want of it. On macOS each
// such program names its terminal in the environment it started with, which the relay reads.
const scoping = macOS || userScopes() !== undefined || process.env.GITHUB_ACTIONS === "true"

// Codex runs its commands in a sandbox of its own by default, which ends what they start as
// each command ends; without it they run as any harness's do.
const unsandboxed = "codex --dangerously-bypass-approvals-and-sandbox"

for (const setup of setups) {
  describe.skipIf(!supported || process.platform === "win32" || !scoping)(setup.name, () => {
    const it = e2e(setup)
    const opens: readonly (string | undefined)[] =
      setup.agent === "codex" ? [undefined, unsandboxed] : [undefined]

    for (const command of opens)
      for (const end of ["close", "quit"] as const)
        gated(it, lacking(setup, "shell"))(
          `ends what its agent started detached as ${end === "quit" ? "Novadeck quits" : "its terminal closes"}${command ? ", its sandbox off" : ""}`,
          async ({ e2e: run, onTestFinished }) => {
            const word = randomUUID()
            onTestFinished(() => endServers(word))
            scripted(run, setup, word)
            const terminal = command
              ? await run.deck.open(command).then(async (opened) => {
                  await opened.reached("ready", { timeoutMs: 60_000 })
                  await prompted(opened, setup)
                  return opened
                })
              : await start(run, setup)
            await turn(terminal, "Say ok", "Okay then.")
            await launch(run, setup, terminal, variants.length)
            // Codex's sandbox has ended them all already, as its command ended; Antigravity ends
            // its command's own group a moment after it, leaving what left its session.
            const before = await left(word)
            if (setup.agent === "agy") expect(before).toContain("setsid")
            else if (setup.agent !== "codex" || command) expect(before).toEqual(variants.toSorted())

            const began = performance.now()
            await run.model.ending(() =>
              end === "quit"
                ? run.deck.terminals.shutdown()
                : run.deck.terminals.close({ terminalId: terminal.id }),
            )
            if (end === "quit") expect(performance.now() - began).toBeLessThan(quitMs)
            await expect.poll(() => left(word), { timeout: 2_000 }).toEqual([])
            await run.deck.restart()
          },
        )

    gated(it, lacking(setup, "shell"))(
      "leaves what the person starts in its terminal once the agent has left, ending the agent's",
      async ({ e2e: run, onTestFinished }) => {
        const word = randomUUID()
        onTestFinished(() => endServers(word))
        scripted(run, setup, word)
        const terminal = await run.deck.open(setup.agent === "codex" ? unsandboxed : setup.agent)
        await terminal.reached("ready", { timeoutMs: 60_000 })
        await prompted(terminal, setup)
        await turn(terminal, "Say ok", "Okay then.")
        await launch(run, setup, terminal, variants.length)
        const agent = agentOf(run, terminal)
        expect(agent).toBeDefined()
        // The agent dies without a word, as one killed or crashed: nothing of its own ends what
        // it started, and its session ends as its process goes. (Ending itself, as on a hangup,
        // Claude Code ends what it started detached too.) On macOS Claude Code keeps the Mac
        // awake while it works with Apple's `caffeinate`, which no listing of Novadeck's sees and
        // the kill leaves it no chance to end: the test ends it, as the kill is the test's.
        const awake = await caffeinated(agent!)
        process.kill(agent!, "SIGKILL")
        for (const pid of awake)
          try {
            process.kill(pid, "SIGTERM")
          } catch {
            // Gone with it.
          }
        await terminal.poll(
          () => (agentOf(run, terminal) === undefined ? true : undefined),
          "the agent's session to end",
          30_000,
        )
        await new Promise((resolve) => setTimeout(resolve, 500))
        // Antigravity ends its command's own group a moment after the command, so what left
        // its session is still there under it (on macOS a `nohup` too); under the others, all.
        const survivors = await left(word)
        if (setup.agent !== "agy") expect(survivors).toEqual(variants.toSorted())
        else if (macOS) expect(survivors).toContain("setsid")
        else expect(survivors).toEqual(["setsid"])
        // Short, as a command the screen wraps never shows once more as typed.
        writeFileSync(
          join(run.sandbox.project, "person.sh"),
          `nohup ${process.execPath} detached-server.mjs person ${word} >/dev/null 2>&1 &\n`,
        )
        await terminal.submit("bash person.sh")
        await expect
          .poll(() => left(word), { timeout: 10_000 })
          .toEqual([...survivors, "person"].toSorted())

        await run.deck.terminals.close({ terminalId: terminal.id })
        await expect.poll(() => left(word), { timeout: 2_000 }).toEqual(["person"])
        // The person's own, which the leftover check would rightly count.
        await endServers(word)
      },
    )

    // An app the agent opens for the person, as `xdg-open` starts a browser's first window,
    // outlives the terminal: Novadeck's shim gives it a scope of its own. A stand-in plays the
    // real xdg-open, later on PATH than the shim and ahead of the system's, so no real app opens.
    if (!macOS)
      for (const end of ["close", "quit"] as const)
        gated(it, lacking(setup, "shell"))(
          `leaves an app its agent opened as ${end === "quit" ? "Novadeck quits" : "its terminal closes"}`,
          async ({ e2e: run, onTestFinished }) => {
            const word = randomUUID()
            onTestFinished(() => endServers(word))
            const node = process.execPath
            const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}`
            const fake = join(run.sandbox.project, "fake")
            mkdirSync(fake, { recursive: true })
            // As a launcher starts an app: apart from itself, which exits at once.
            writeFileSync(
              join(fake, "xdg-open"),
              `#!/bin/sh\nsetsid ${node} detached-server.mjs app ${word} >/dev/null 2>&1 &\nexit 0\n`,
            )
            chmodSync(join(fake, "xdg-open"), 0o755)
            scripted(
              run,
              setup,
              word,
              // The sandbox gives its terminals a runtime folder and a bus of their own, which no
              // systemd answers on; a desktop's terminal reaches the person's, as this does.
              `#!/bin/bash\nXDG_RUNTIME_DIR=${runtime} DBUS_SESSION_BUS_ADDRESS=unix:path=${runtime}/bus PATH="$NOVADECK_OPEN:$PWD/fake:$PATH" xdg-open "https://example.com/${word}"\nsleep 1; echo opened\n`,
            )
            const terminal = await run.deck.open(
              setup.agent === "codex" ? unsandboxed : setup.agent,
            )
            await terminal.reached("ready", { timeoutMs: 60_000 })
            await prompted(terminal, setup)
            await turn(terminal, "Say ok", "Okay then.")
            await launch(run, setup, terminal, 1)
            const [app] = readFileSync(join(run.sandbox.project, "detached.pids"), "utf8")
              .trim()
              .split(" ")
              .slice(1)
              .map(Number)
            // In a scope of its own, not its terminal's.
            const scope = readFileSync(`/proc/${shellOf(run, terminal)}/cgroup`, "utf8")
            expect(readFileSync(`/proc/${app}/cgroup`, "utf8")).not.toBe(scope)

            await run.model.ending(() =>
              end === "quit"
                ? run.deck.terminals.shutdown()
                : run.deck.terminals.close({ terminalId: terminal.id }),
            )
            await new Promise((resolve) => setTimeout(resolve, 1_500))
            expect(await left(word)).toEqual(["app"])
            // The test's own app, which the leftover check would rightly count.
            await endServers(word)
            await run.deck.restart()
          },
        )

    // On macOS an app the agent opens is launchd's, in a coalition of its own, though `open`
    // gives it the caller's environment, the terminal named in it: it outlives the terminal. A
    // bundle of the test's own plays the app, node its program, with no window or Dock icon.
    if (macOS)
      for (const end of ["close", "quit"] as const)
        gated(it, lacking(setup, "shell"))(
          `leaves an app its agent opened as ${end === "quit" ? "Novadeck quits" : "its terminal closes"}`,
          async ({ e2e: run, onTestFinished }) => {
            const word = randomUUID()
            onTestFinished(() => endServers(word))
            const { project } = run.sandbox
            const app = join(project, `Detached ${word}.app`)
            mkdirSync(join(app, "Contents", "MacOS"), { recursive: true })
            writeFileSync(
              join(app, "Contents", "Info.plist"),
              `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>run</string>
<key>CFBundleIdentifier</key><string>dev.novadeck.e2e.detached-${word}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
            )
            // LaunchServices starts no script, so node is the app's program.
            symlinkSync(process.execPath, join(app, "Contents", "MacOS", "run"))
            const serverFile = join(project, "detached-server.mjs")
            scripted(
              run,
              setup,
              word,
              `#!/bin/bash\nopen -g -j ${JSON.stringify(app)} --args ${JSON.stringify(serverFile)} app ${word}\nsleep 1; echo opened\n`,
            )
            const terminal = await run.deck.open(
              setup.agent === "codex" ? unsandboxed : setup.agent,
            )
            await terminal.reached("ready", { timeoutMs: 60_000 })
            await prompted(terminal, setup)
            await turn(terminal, "Say ok", "Okay then.")
            await launch(run, setup, terminal, 1)

            await run.model.ending(() =>
              end === "quit"
                ? run.deck.terminals.shutdown()
                : run.deck.terminals.close({ terminalId: terminal.id }),
            )
            await new Promise((resolve) => setTimeout(resolve, 1_500))
            expect(await left(word)).toEqual(["app"])
            // The test's own app, which the leftover check would rightly count.
            await endServers(word)
            await run.deck.restart()
          },
        )

    // Claude Code's background service, which its agents view (←) starts detached, sits in the
    // scope of the terminal that started it, and the person's other sessions share it.
    if (setup.agent === "claude")
      it("leaves Claude Code's background service as the terminal that started it closes", async ({
        e2e: run,
      }) => {
        run.model.use(replies("Warm up", "Warmed up."))
        const terminal = await start(run, setup)
        await turn(terminal, "Warm up", "Warmed up.")
        terminal.press("\x1b[D")
        await terminal.until("describe a task")
        const home = harnesses.claude.home({
          env: run.sandbox.env,
          home: run.sandbox.home,
          platform: process.platform,
          plugin: "",
        })
        const lock = await terminal.poll(
          async () => (await readLock(home)) ?? undefined,
          "the background service's lock",
          30_000,
        )
        // In the scope of the terminal that started it, among what its agent left there.
        if (!macOS) {
          const scope = readFileSync(`/proc/${shellOf(run, terminal)}/cgroup`, "utf8")
          expect(readFileSync(`/proc/${lock.pid}/cgroup`, "utf8")).toBe(scope)
        }
        expect(await startOf(lock.pid)).toBe(lock.start)
        await run.deck.terminals.close({ terminalId: terminal.id })
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        // The same process, still running, which the fixture then ends as a logout would.
        expect(await startOf(lock.pid)).toBe(lock.start)
      })
  })
}

// On Windows a terminal's job object holds what a program started there, however it started it:
// through a launcher that exits at once, as `start /b`, `Start-Process` or a detached child of a
// short-lived process, it has left the shell's tree, whose walk can't reach it, but stays in the
// job (libraries/terminal/src/pty/jobs.ts).
const windowsVariants = ["detached", "start", "startProcess"] as const

/** How long the Windows tests give their servers to start (see `launch`). */
const windowsLaunchMs = 120_000

/**
 * What the agent runs on Windows, as `node detach.mjs <word> [<name>...]`: each named server, by
 * a launcher that exits at once, then a word once all are up. Node runs in every harness's
 * shell, and takes no shell's quoting.
 */
const windowsScript = `
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
const [word, ...names] = process.argv.slice(2)
const node = process.execPath
const apart = (name) =>
  "require('child_process').spawn(process.execPath, ['detached-server.mjs', '" + name + "', '" + word + "'], { detached: true, stdio: 'ignore' }).unref()"
const launchers = {
  start: ["cmd.exe", ['/d /s /c "start "" /b "' + node + '" detached-server.mjs start ' + word + '"'], true],
  startProcess: [
    "powershell.exe",
    ["-NoProfile", "-Command", "Start-Process -WindowStyle Hidden -FilePath '" + node + "' -ArgumentList 'detached-server.mjs','startProcess','" + word + "'"],
  ],
  detached: [node, ["-e", apart("detached")]],
  person: [node, ["-e", apart("person")]],
}
const told = () => (existsSync("detached.pids") ? readFileSync("detached.pids", "utf8").trim().split("\\n").length : 0)
const before = told()
for (const name of names) {
  const [file, args, verbatim] = launchers[name]
  spawn(file, args, { stdio: "ignore", windowsHide: true, windowsVerbatimArguments: verbatim === true })
}
const up = setInterval(() => {
  if (told() < before + names.length) return
  clearInterval(up)
  console.log("launched")
}, 50)
`

/**
 * A word for one Windows test's servers, short enough that the person's line, after a long
 * temporary folder's prompt, stays on one row for the terminal to show it typed.
 */
const shortWord = (): string => randomUUID().slice(0, 8)

/** This test's servers on Windows, by name and pid, as each told it. */
const toldServers = (run: E2E): readonly (readonly [string, number])[] => {
  const pids = join(run.sandbox.project, "detached.pids")
  if (!existsSync(pids)) return []
  return readFileSync(pids, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, pid] = line.split(" ")
      return [name!, Number(pid)] as const
    })
}

/** Which of this test's servers still run on Windows, by name. */
const windowsLeft = (run: E2E): readonly string[] =>
  toldServers(run)
    .filter(([, pid]) => anyRunning([{ pid, startedAt: 0 }]))
    .map(([name]) => name)
    .toSorted()

/** Ends what of this test's servers still runs on Windows, as a failed test leaves them. */
const endWindowsServers = (run: E2E): void => {
  for (const [, pid] of toldServers(run))
    try {
      process.kill(pid)
    } catch {
      // Gone.
    }
}

// The scripted model on Windows: a first turn binds every harness, then the agent runs `line`.
const scriptedWindows = (run: E2E, setup: AgentSetup, line: string) => {
  const { shell } = setup
  run.model.use(
    replies("Say ok", "Okay then."),
    own((call) => (asked(call, "Run the detach script") ? shell!.run(call, line) : undefined)),
    own((call) => (result(call) !== undefined ? { text: "Done." } : undefined)),
  )
  writeFileSync(join(run.sandbox.project, "detach.mjs"), windowsScript)
  writeFileSync(join(run.sandbox.project, "detached-server.mjs"), server)
  rmSync(join(run.sandbox.project, "detached.pids"), { force: true })
}

/** A terminal opened with `command`, its agent ready for a prompt. */
const opened = async (run: E2E, setup: AgentSetup, command: string): Promise<DeckTerminal> => {
  const terminal = await run.deck.open(command)
  await terminal.reached("ready", { timeoutMs: 60_000 })
  await prompted(terminal, setup)
  return terminal
}

for (const setup of setups) {
  describe.skipIf(!supported || process.platform !== "win32")(`${setup.name} (Windows)`, () => {
    const it = e2e(setup)
    const opens: readonly (string | undefined)[] =
      setup.agent === "codex" ? [undefined, unsandboxed] : [undefined]
    const itsCommand = setup.agent === "codex" ? unsandboxed : setup.agent

    // Antigravity ends what its command started, detached or not, about a second after the
    // command ends (measured on 1.5.13), so on Windows none of it is left for a close or a quit.
    if (setup.agent === "agy")
      gated(it, lacking(setup, "shell"))(
        "has nothing its agent started detached left to end, as Antigravity ends it with the command",
        async ({ e2e: run, onTestFinished }) => {
          onTestFinished(() => endWindowsServers(run))
          const word = shortWord()
          scriptedWindows(run, setup, `node detach.mjs ${word} ${windowsVariants.join(" ")}`)
          const terminal = await start(run, setup)
          await turn(terminal, "Say ok", "Okay then.")
          await launch(run, setup, terminal, windowsVariants.length, windowsLaunchMs)
          await expect.poll(() => windowsLeft(run), { timeout: 5_000 }).toEqual([])
        },
      )

    for (const command of setup.agent === "agy" ? [] : opens)
      for (const end of ["close", "quit"] as const)
        gated(it, lacking(setup, "shell"))(
          `ends what its agent started detached as ${end === "quit" ? "Novadeck quits" : "its terminal closes"}${command ? ", its sandbox off" : ""}`,
          async ({ e2e: run, onTestFinished }) => {
            onTestFinished(() => endWindowsServers(run))
            const word = shortWord()
            scriptedWindows(run, setup, `node detach.mjs ${word} ${windowsVariants.join(" ")}`)
            const terminal = command ? await opened(run, setup, command) : await start(run, setup)
            await turn(terminal, "Say ok", "Okay then.")
            await launch(run, setup, terminal, windowsVariants.length, windowsLaunchMs)
            expect(windowsLeft(run)).toEqual(windowsVariants.toSorted())

            const began = performance.now()
            await run.model.ending(() =>
              end === "quit"
                ? run.deck.terminals.shutdown()
                : run.deck.terminals.close({ terminalId: terminal.id }),
            )
            if (end === "quit") expect(performance.now() - began).toBeLessThan(quitMs)
            await expect.poll(() => windowsLeft(run), { timeout: 2_000 }).toEqual([])
            await run.deck.restart()
          },
        )

    gated(it, lacking(setup, "shell"))(
      "leaves what the person starts in its terminal once the agent has left, ending the agent's",
      async ({ e2e: run, onTestFinished }) => {
        onTestFinished(() => endWindowsServers(run))
        const word = shortWord()
        scriptedWindows(run, setup, `node detach.mjs ${word} ${windowsVariants.join(" ")}`)
        const terminal = await opened(run, setup, itsCommand)
        await turn(terminal, "Say ok", "Okay then.")
        await launch(run, setup, terminal, windowsVariants.length, windowsLaunchMs)
        const agent = agentOf(run, terminal)
        expect(agent).toBeDefined()
        // The agent dies without a word, as one killed or crashed.
        process.kill(agent!)
        await terminal.poll(
          () => (agentOf(run, terminal) === undefined ? true : undefined),
          "the agent's session to end",
          30_000,
        )
        // Antigravity has ended what its commands left already; Claude Code, opencode and pi
        // don't as they die (pi ends only a command still running, on a signal, in its print
        // and RPC modes: dist/utils/shell.js, 1.6.0); Codex (its sandbox off too) mostly does,
        // a moment on, but not always.
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        const survivors = windowsLeft(run)
        if (setup.agent === "codex")
          expect([[], windowsVariants.toSorted()]).toContainEqual(survivors)
        else
          expect(survivors).toEqual(
            setup.agent === "claude" || setup.agent === "opencode" || setup.agent === "pi"
              ? windowsVariants.toSorted()
              : [],
          )
        await terminal.submit(`node detach.mjs ${word} person`)
        await expect
          .poll(() => windowsLeft(run), { timeout: 10_000 })
          .toEqual([...survivors, "person"].toSorted())

        await run.deck.terminals.close({ terminalId: terminal.id })
        await expect.poll(() => windowsLeft(run), { timeout: 2_000 }).toEqual(["person"])
        // The person's own, which the leftover check would rightly count.
        endWindowsServers(run)
      },
    )

    // Claude Code starts its background service through WMI on Windows: in no terminal's job,
    // so a close leaves it.
    if (setup.agent === "claude")
      it("leaves Claude Code's background service as the terminal that started it closes", async ({
        e2e: run,
      }) => {
        run.model.use(replies("Warm up", "Warmed up."))
        const terminal = await start(run, setup)
        await turn(terminal, "Warm up", "Warmed up.")
        terminal.press("\x1b[D")
        await terminal.until("describe a task")
        const home = harnesses.claude.home({
          env: run.sandbox.env,
          home: run.sandbox.home,
          platform: process.platform,
          plugin: "",
        })
        const lock = await terminal.poll(
          async () => (await readLock(home)) ?? undefined,
          "the background service's lock",
          30_000,
        )
        const service = [{ pid: lock.pid, startedAt: 0 }]
        expect(anyRunning(service)).toBe(true)
        await run.deck.terminals.close({ terminalId: terminal.id })
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        expect(anyRunning(service)).toBe(true)
      })
  })
}
