import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

import { readLock } from "@novadeck/harness-claude/daemon"
import { userScopes } from "@novadeck/terminal/pty"

import { harnesses } from "../harnesses/registry.js"
import type { AgentSetup } from "./agents/agent.js"
import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, gated, supported, type E2E } from "./fixture.js"
import { asked } from "./model/script.js"
import { lacking, own, prompted, replies, result, start, turn } from "./scenarios.js"

// How long a quit may take in all: the five seconds the app gives the runner.
const quitMs = 5_000

/** The ways a program leaves its shell's tree as the shell exits, each once. */
const variants = ["subshell", "nohup", "setsid", "disown"] as const

/** A program that runs until it is ended, and says it is up by its name and pid. */
const server = `
import { appendFileSync } from "node:fs"
appendFileSync("detached.pids", process.argv[2] + " " + process.pid + "\\n")
setInterval(() => {}, 1000)
`

// What the agent runs: each variant's server, started so that it outlives the script.
const script = (word: string): string => {
  const node = process.execPath
  const run = (name: string) => `${node} detached-server.mjs ${name} ${word} >/dev/null 2>&1`
  return `#!/bin/bash
(${run("subshell")} &)
nohup ${run("nohup")} &
setsid ${run("setsid")} &
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

/** A process's start, as /proc/<pid>/stat holds it; undefined once it has gone. */
const startOf = (pid: number): string | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]
  } catch {
    return undefined
  }
}

/** Has the agent run the script; answers its harness's question, should it ask. */
const launch = async (run: E2E, terminal: DeckTerminal, count: number): Promise<void> => {
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
          (each) => each.label.startsWith("Yes") && each.text === null,
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
    60_000,
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
// scopes and nothing changes; CI has one, and may not skip this for want of it.
const scoping = userScopes() !== undefined || process.env.GITHUB_ACTIONS === "true"

// Codex runs its commands in a sandbox of its own by default, which ends what they start as
// each command ends; without it they run as any harness's do.
const unsandboxed = "codex --dangerously-bypass-approvals-and-sandbox"

for (const setup of setups) {
  describe.skipIf(!supported || process.platform !== "linux" || !scoping)(setup.name, () => {
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
            await launch(run, terminal, variants.length)
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
        await launch(run, terminal, variants.length)
        const agent = agentOf(run, terminal)
        expect(agent).toBeDefined()
        // The agent dies without a word, as one killed or crashed: nothing of its own ends what
        // it started, and its session ends as its process goes. (Ending itself, as on a hangup,
        // Claude Code ends what it started detached too.)
        process.kill(agent!, "SIGKILL")
        await terminal.poll(
          () => (agentOf(run, terminal) === undefined ? true : undefined),
          "the agent's session to end",
          30_000,
        )
        await new Promise((resolve) => setTimeout(resolve, 500))
        // Antigravity ends its command's own group a moment after the command, so only what
        // left its session is still there under it; under the others, all of it.
        const survivors = await left(word)
        expect(survivors).toEqual(setup.agent === "agy" ? ["setsid"] : variants.toSorted())
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
            `#!/bin/bash\nXDG_RUNTIME_DIR=${runtime} DBUS_SESSION_BUS_ADDRESS=unix:path=${runtime}/bus PATH="$NOVADECK_BIN:$PWD/fake:$PATH" xdg-open "https://example.com/${word}"\nsleep 1; echo opened\n`,
          )
          const terminal = await run.deck.open(setup.agent === "codex" ? unsandboxed : setup.agent)
          await terminal.reached("ready", { timeoutMs: 60_000 })
          await prompted(terminal, setup)
          await turn(terminal, "Say ok", "Okay then.")
          await launch(run, terminal, 1)
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
        const scope = readFileSync(`/proc/${shellOf(run, terminal)}/cgroup`, "utf8")
        expect(readFileSync(`/proc/${lock.pid}/cgroup`, "utf8")).toBe(scope)
        expect(startOf(lock.pid)).toBe(lock.start)
        await run.deck.terminals.close({ terminalId: terminal.id })
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        // The same process, still running, which the fixture then ends as a logout would.
        expect(startOf(lock.pid)).toBe(lock.start)
      })
  })
}
