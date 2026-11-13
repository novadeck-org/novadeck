import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported } from "./fixture.js"
import { asked, type Call, type Reply } from "./model/script.js"
import { allowClaude, openCodex } from "./outcomes.js"
import { own, start } from "./scenarios.js"

// The background shells an agent leaves running, the same for every harness (see
// messaging.e2e.ts for the rule on parity): the agent starts three in turn and ends its turn
// with all running; one exits 3, one exits 0, and one runs until it is stopped. The runner
// tells each with its id, command and start, and its exit while it lasts after the turn
// (`activity.shells`), and the file its output is in (`output`): Claude Code's and Antigravity's
// own, Codex's Novadeck's capture of its commands (shell/capture.ts), which holds what each
// printed while it runs. Probed 2026-11-10 on Claude Code 2.1.316, Codex 0.167.0, Antigravity 1.5.3.
// Long enough that a slow runner still sees all three running, and that Codex on Windows, which
// waits for a command longer than its yield, hands them to the background.
// Each prints its own word first, which reads the same in sh, PowerShell and Git Bash.
const words = ["shell-a", "shell-c", "shell-b"]
const commands = (agent: string) => [
  "echo shell-a; sleep 40; exit 3",
  "echo shell-c; sleep 30; exit 0",
  // Claude Code on Windows stops the loop but leaves the sleep it was in running: short ones.
  agent === "claude" ? "echo shell-b; while true; do sleep 1; done" : "echo shell-b; sleep 600",
]

// What a shell's output file holds now; nothing while it is not there yet.
const printed = (path: string | undefined): string => {
  try {
    return path === undefined ? "" : readFileSync(path, "utf8")
  } catch {
    return ""
  }
}

const launch = (agent: string, command: string, summary: string): Reply => {
  if (agent === "claude")
    return {
      calls: [{ name: "Bash", input: { command, description: summary, run_in_background: true } }],
    }
  if (agent === "codex")
    return { calls: [{ name: "exec_command", input: { cmd: command, yield_time_ms: 500 } }] }
  return {
    calls: [
      {
        name: "run_command",
        input: { CommandLine: command, WaitMsBeforeAsync: 500, toolSummary: summary },
      },
    ],
  }
}

// What the results of the shells started so far say, oldest first.
const started = (call: Call): string[] =>
  call.turns
    .filter((turn) => turn.role === "tool")
    .map((turn) => turn.text)
    .filter((text) => /background|session ID|Process exited/.test(text))

// The agent stopping the last shell it started; Codex's person stops theirs with /stop.
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

const shellsOf = (t: DeckTerminal) => t.summary().activity?.shells ?? []

for (const setup of setups) {
  describe.skipIf(!supported)(`${setup.name}'s background shells`, () => {
    const it = e2e(setup)
    it(
      "tells each shell it left running, and how each ended",
      { timeout: 240_000 },
      async ({ e2e: run }) => {
        if (setup.agent === "claude") allowClaude(run)
        if (setup.agent === "codex") openCodex(run)
        run.model.use(
          own((call) => {
            if (call.side) return undefined
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
                ? launch(
                    setup.agent,
                    commands(setup.agent)[done]!,
                    ["Server A", "Server C", "Server B"][done]!,
                  )
                : { text: "Shells started." }
            }
            return { text: "Noted." }
          }),
        )
        // Codex on Windows finds its shell on PATH: Novadeck's PowerShell is there once Codex
        // is connected, and its shim puts it first, or no command of its is captured.
        if (setup.agent === "codex" && process.platform === "win32") {
          const { pwshDir, bin } = run.deck.shell
          expect(existsSync(join(pwshDir, "pwsh.exe")), "Novadeck's pwsh.exe installed").toBe(true)
          expect(readFileSync(join(bin, "codex.cmd"), "utf8")).toMatch(/set "PATH=[^"]+;%PATH%"/)
        }
        const t = await start(run, setup)
        const before = Date.now()
        await t.submit("Start the shells")
        await t.poll(
          async () => {
            await approve(t)
            return shellsOf(t).length === 3 && (await t.screen()).includes("Shells started.")
              ? true
              : undefined
          },
          "the three shells told",
          90_000,
        )
        // Running: each with a harness id of its own, its command and when it started.
        const running = shellsOf(t)
        expect(running.map(({ command }) => command)).toEqual(commands(setup.agent))
        expect(new Set(running.map(({ id }) => id)).size).toBe(3)
        for (const shell of running) {
          expect(shell.exit).toBeNull()
          expect(shell.since).toBeGreaterThan(before - 5000)
          expect(shell.since).toBeLessThanOrEqual(Date.now())
        }
        const [a, c, b] = running.map(({ id }) => id) as [string, string, string]

        // Each tells the file its output is in, which holds what it printed while it runs.
        const told = await t.poll(
          () => {
            const now = shellsOf(t)
            return now.length === 3 &&
              now.every(({ output }, index) => printed(output).includes(words[index]!))
              ? now
              : undefined
          },
          "each shell's output",
          30_000,
        )
        expect(new Set(told.map(({ output }) => output)).size).toBe(3)

        // Whatever the outcome, the shell that runs on is stopped, so none outlives the test.
        const stop = async () => {
          if (setup.agent === "codex") await t.submit("/stop")
          else await t.submit("Stop the shell")
        }
        let finished = false
        try {
          // Two end by themselves, with the codes they exited with; the third runs on.
          const ended = await t.poll(
            () => {
              const now = shellsOf(t)
              return now.find((s) => s.id === a)?.exit && now.find((s) => s.id === c)?.exit
                ? now
                : undefined
            },
            "two shells to end",
            120_000,
          )
          expect(ended.find((s) => s.id === a)?.exit?.code).toBe(3)
          expect(ended.find((s) => s.id === c)?.exit?.code).toBe(0)
          expect(ended.find((s) => s.id === b)?.exit).toBeNull()
          for (const shell of ended)
            if (shell.exit) expect(shell.exit.at).toBeGreaterThanOrEqual(shell.since)

          // Stopped, the last ends with no code of its own.
          await stop()
          const stopped = await t.poll(
            async () => {
              await approve(t)
              return shellsOf(t).find((s) => s.id === b)?.exit ?? undefined
            },
            "the last shell to end",
            60_000,
          )
          expect(stopped.code).toBeNull()
          // Claude Code's loop ends within the second of its sleep it was in.
          await new Promise((resolve) => setTimeout(resolve, 3000))
          finished = true
        } finally {
          if (!finished) {
            await stop().catch(() => undefined)
            await t
              .poll(
                async () => {
                  await approve(t)
                  return shellsOf(t).find((s) => s.id === b)?.exit ?? undefined
                },
                "the last shell to end, after a failure",
                30_000,
              )
              .catch(() => undefined)
          }
        }
      },
    )
  })
}
