import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"
import { onTestFinished } from "vitest"

import type { Terminals } from "../terminals/index.js"
import { describe, expect } from "../test.js"
import {
  bash,
  create,
  it,
  open,
  reporter,
  screen,
  show,
  showStandIn,
  type Fixture,
} from "./integration.test-support.js"
import { driver, standIn } from "./stand-ins.test-support.js"

// How each agent resumes the session it had, as the stand-in prints it.
const resumed = {
  claude: "claude args: --resume s-worker",
  codex: "codex args: resume s-worker",
  agy: "agy args: --conversation s-worker",
}

const sample = 100

// Windows as the runner sees it: no sample names a foreground program, so the agent a
// session binds is the program a fresh shell resumes (see `boundProgram`).
const windows = () => {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!
  Object.defineProperty(process, "platform", { value: "win32" })
  const back = () => void Object.defineProperty(process, "platform", real)
  onTestFinished(back)
  return back
}

describe.skipIf(process.platform === "win32" || !existsSync(bash))(
  "restoring a lead's teammates after Windows ended their agents",
  () => {
    // A lead, moth, opens a teammate that binds and finishes a turn; its agent then ends
    // as Windows ends it at shutdown (killed, the person typing nothing, or something that
    // does not end it), or as the person ends it with Ctrl+C. With `gone` the agent's binding
    // ends first, its process found gone by a report, as the doorbell's probe finds it, and
    // the shell's prompt follows. The runner is told nothing, and keeps saving. A second
    // runner then restores the terminal as the app does: resuming only the agent the saved
    // row names.
    type How = "system" | "typed" | "gone" | "person"
    const quit = async (shell: Fixture, agent: AgentName, how: How) => {
      const bin = showStandIn(shell.home)
      const stand = standIn(shell.home)
      writeFileSync(
        join(stand, agent),
        '#!/bin/sh\nmkdir -p "$HOME/steps-$NOVADECK_TERMINAL_ID"\n' +
          'echo $$ > "$HOME/pid-$NOVADECK_TERMINAL_ID"\n' +
          // Long enough for the test to be on Windows when the session binds.
          'echo "' +
          agent +
          ' args: $*"\nsleep 1\n' +
          (how === "gone"
            ? "exec report\n"
            : `exec agent ${agent} s-worker "$HOME/steps-$NOVADECK_TERMINAL_ID"\n`),
        { mode: 0o755 },
      )
      // A process that is gone, which the reports of a session name as its agent's.
      const gone = String(spawnSync(process.execPath, ["-e", ""]).pid)
      if (how === "gone")
        reporter(shell.home, [
          { agent, sessionId: "s-worker", seq: 1, source: "startup", instance: gone },
          {
            agent,
            sessionId: "s-worker",
            seq: 2,
            source: "startup",
            event: "Stop",
            fields: agent === "agy" ? { fullyIdle: true } : {},
            instance: gone,
            wait: 100,
          },
        ])
      const options = {
        env: {
          HOME: shell.home,
          PS1: "$ ",
          PATH: `${bin}:${stand}:${process.env.PATH}`,
        },
        processPollMs: sample,
        saveMs: 50,
        install: (name: AgentName) =>
          Promise.resolve({
            env: {},
            home: shell.home,
            platform: process.platform,
            plugin: join(shell.plugins, name),
          }),
        models: () => Promise.resolve([{ id: "m", efforts: [] }]),
      }
      const manager = shell.manager(options)
      const lead = await create(manager, shell)
      const controller = new AbortController()
      const created: string[] = []
      const client = (async () => {
        for await (const asked of manager.requests("client", controller.signal)) {
          const id = randomUUID()
          created.push(id)
          // eslint-disable-next-line no-await-in-loop -- Requests are opened in turn.
          await manager.create(
            {
              id,
              sessionId: asked.sessionId,
              cwd: asked.cwd,
              cols: 100,
              rows: 20,
              ...(asked.command && { command: asked.command }),
              requestId: asked.requestId,
            },
            "client",
          )
          manager.answerRequest({ requestId: asked.requestId, terminalId: id }, "client")
        }
      })()
      const worker = await (async () => {
        const answered = show(shell, manager, lead.id, [
          { ...open({ agent, lead: true }), type: "open_agent" as "open" },
        ])
        await expect.poll(() => created.length).toBe(1)
        const back = windows()
        const [answer] = (await answered) as { ok: boolean }[]
        expect(answer!.ok).toBe(true)
        await shell.until(manager, created[0]!, how === "gone" ? "reports sent" : `${agent} ready`)
        return { id: created[0]!, back }
      })()
      if (how === "gone") {
        // The second report found the process gone: the binding ended, the agent still led.
        await expect.poll(() => manager.get(worker.id).agent, { timeout: 5000 }).toBeNull()
      } else {
        const { step } = driver(shell, manager)
        await step(worker.id, {
          hook: agent === "agy" ? "PreInvocation" : "UserPromptSubmit",
          payload: agent === "agy" ? { invocationNum: 1 } : { prompt: "go" },
        })
        await step(worker.id, {
          hook: "Stop",
          payload: agent === "agy" ? { fullyIdle: true } : {},
        })
        expect(manager.get(worker.id)).toMatchObject({ ledBy: "moth", agent })
      }
      const pid = Number(readFileSync(join(shell.home, `pid-${worker.id}`), "utf8"))
      // Text, arrows and the like are not what ends an agent.
      if (how === "typed")
        manager.write({ terminalId: worker.id, data: "keep going\x1b[A" }, "client")
      if (how === "person") manager.write({ terminalId: worker.id, data: "\x03" }, "client")
      else process.kill(pid, "SIGKILL")
      // The shell outlives its agent by more than a sample, and the runner goes on.
      await shell.until(manager, worker.id, "$ ")
      await new Promise((resolve) => setTimeout(resolve, sample * 10))
      worker.back()
      controller.abort()
      await client
      return { worker: worker.id, options }
    }

    // What the app asks of the runner for a terminal it lists: resume the agent the saved
    // row names as the program that was running, if one.
    const restore = async (shell: Fixture, id: string, options: object): Promise<Terminals> => {
      const row = shell.store.terminal(id)!
      const agent = (["claude", "codex", "agy"] as const).find((name) => name === row.lastProgram)
      const manager = shell.manager(options)
      await create(manager, shell, {
        id,
        restore: true,
        ...(agent && { resume: agent }),
      })
      return manager
    }

    for (const agent of ["claude", "codex", "agy"] as const) {
      for (const [how, when] of [
        ["system", "its agent was killed with nobody at the keys"],
        ["typed", "its agent was killed after the person typed into it"],
        ["gone", "its agent's binding ended before the shell's prompt"],
      ] as const)
        it(`resumes ${agent} in the teammate, still led, when ${when}`, async ({ shell }) => {
          const { worker, options } = await quit(shell, agent, how)
          const manager = await restore(shell, worker, options)
          await shell.until(manager, worker, resumed[agent])
          expect(manager.get(worker)).toMatchObject({ ledBy: "moth" })
        })

      it(`restores a plain shell for ${agent} the person ended, as they asked`, async ({
        shell,
      }) => {
        const { worker, options } = await quit(shell, agent, "person")
        const manager = await restore(shell, worker, options)
        await new Promise((resolve) => setTimeout(resolve, 500))
        expect(await screen(manager, worker)).not.toContain(resumed[agent])
        expect(manager.get(worker)).toMatchObject({ ledBy: null })
      })
    }
  },
)
