import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"

import { anyRunning } from "@novadeck/terminal/pty"

import { setups } from "./agents/index.js"
import { describe, e2e, expect, gated, supported, type E2E } from "./fixture.js"
import { asked } from "./model/script.js"
import { lacking, own, replies, result, start, turn } from "./scenarios.js"

// How long a quit may hold a terminal's agent and its tools: the five seconds the app gives it.
const quitMs = 5_000

/**
 * A tool that runs on until something ends it, with a child: `stays` has both ignore a hangup
 * and SIGTERM. It says so by a file once its child, the last to start, is up, with their pids.
 */
const tool = (stays: boolean) => {
  const ignoring = stays
    ? "for (const signal of ['SIGHUP', 'SIGTERM']) process.on(signal, () => {});"
    : ""
  const child = `${ignoring} require('node:fs').writeFileSync('quit-tool.up', process.pid + ' ' + process.ppid); setInterval(() => {}, 1000)`
  return `import { spawn } from "node:child_process"
${ignoring}
spawn(process.execPath, ["-e", ${JSON.stringify(child)}, process.argv[2]], { stdio: "ignore" })
setInterval(() => {}, 1000)
`
}

/**
 * What runs of the tool. From outside, by the word its command line holds, where Codex's
 * sandbox gives it pids of a namespace of its own; on Windows by the pids it told, as
 * nothing there tells a command line without the relay.
 */
const toolLeft = async (word: string, told: readonly number[]): Promise<readonly number[]> => {
  if (process.platform === "win32") return told.filter((pid) => anyRunning([{ pid, startedAt: 0 }]))
  const { stdout } = await promisify(execFile)("ps", ["-axww", "-o", "pid=,stat=,args="], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout.split("\n").flatMap((line) => {
    const row = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    return row && !row[2]!.startsWith("Z") && row[3]!.includes(word) ? [Number(row[1])] : []
  })
}

// A command no seed allows: the chat allows it, as the person would, where the harness asks;
// Codex's sandbox runs it unasked.
const running = async (
  run: E2E,
  terminal: Awaited<ReturnType<typeof start>>,
): Promise<readonly number[]> => {
  const up = join(run.sandbox.project, "quit-tool.up")
  const after = run.model.mark()
  await terminal.prompt("Run the quit tool")
  const started = () => {
    if (existsSync(up)) return true
    // The tool's end, as its harness's sandbox refusing it, ends the wait, in its words.
    const ended = run.model.calls.slice(after).map(result).find(Boolean)
    if (ended) throw new Error(`The tool ended: ${ended.slice(0, 500)}`)
    return false
  }
  const asking = await terminal.poll(
    async () => {
      if (started()) return "running"
      const [request] = (await terminal.detail()).requests
      return request?.dialog?.type === "choices"
        ? { ref: request.ref, dialog: request.dialog }
        : undefined
    },
    "its tool to run or ask",
    60_000,
  )
  if (asking !== "running") {
    const { ref, dialog } = asking
    const yes = dialog.options.find((each) => each.label.startsWith("Yes") && each.text === null)
    if (!yes) throw new Error(`No yes in ${JSON.stringify(dialog)}`)
    await terminal.answer(ref, { dialog: dialog.id, type: "choice", option: yes.id })
    await terminal.poll(() => (started() ? true : undefined), "its tool to start", 60_000)
  }
  return readFileSync(up, "utf8").split(" ").map(Number)
}

// What an agent started used to stay behind it: a hangup reaches its own group alone, tools run
// in groups of their own, and on macOS nothing ends Codex's with it (#721).
for (const setup of setups) {
  describe.skipIf(!supported)(setup.name, () => {
    const it = e2e(setup)
    const { shell } = setup

    for (const [what, stays] of [
      ["a tool that is running", false],
      ["a tool that ignores the hangup and SIGTERM", true],
    ] as const)
      gated(it, lacking(setup, "shell"))(
        `leaves nothing of ${what} after a quit`,
        async ({ e2e: run }) => {
          const word = randomUUID()
          run.model.use(
            replies("Say ok", "Okay then."),
            own((call) =>
              asked(call, "Run the quit tool")
                ? shell!.run(call, `node quit-tool.mjs ${word}`)
                : undefined,
            ),
            own((call) => (result(call) !== undefined ? { text: "Done." } : undefined)),
          )
          writeFileSync(join(run.sandbox.project, "quit-tool.mjs"), tool(stays))
          rmSync(join(run.sandbox.project, "quit-tool.up"), { force: true })
          const terminal = await start(run, setup)
          // Past a first turn, which binds every harness to its terminal.
          await turn(terminal, "Say ok", "Okay then.")
          const told = await running(run, terminal)
          expect((await toolLeft(word, told)).length).toBeGreaterThanOrEqual(2)

          const began = performance.now()
          await run.model.ending(() => run.deck.terminals.shutdown())
          expect(performance.now() - began).toBeLessThan(quitMs)
          await expect.poll(() => toolLeft(word, told), { timeout: 1_000 }).toEqual([])
          // Finds what the sandbox still holds, and throws.
          await run.deck.restart()
        },
      )
  })
}
