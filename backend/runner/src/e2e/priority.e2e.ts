import { getPriority, setPriority } from "node:os"

import { relayPath } from "@novadeck/relay"
import { processesUnder, terminalForeground, terminalPriority, Trees } from "@novadeck/terminal/pty"

import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported, type E2E } from "./fixture.js"
import { start } from "./scenarios.js"

const trees = new Trees(async () => relayPath)

const shellOf = (run: E2E, terminal: Pick<DeckTerminal, "id">): number => {
  const inside = run.deck.terminals as unknown as {
    records: Map<string, { terminal: { pty: { pid: number | undefined } } }>
  }
  const shell = inside.records.get(terminal.id)?.terminal.pty.pid
  if (shell === undefined) throw new Error("The terminal has no shell")
  return shell
}

// The programs below a terminal's shell run below the app's priority, the shell's own and
// the agent it started as the terminal opened, which on Windows starts before the shell's
// pid is known. Linux weighs its terminals' scopes instead (scope.e2e.ts).
for (const setup of setups) {
  describe.skipIf(!supported || process.platform === "linux")(
    `An agent started as its terminal opens in ${setup.name}`,
    () => {
      const it = e2e(setup)

      it("runs at a lowered priority, with its shell", async ({ e2e: run, onTestFinished }) => {
        // CI's Windows runs the suite itself below normal, which a shell inherits without
        // any lowering: this run starts at normal, so what the shell has is its doing.
        const own = getPriority(process.pid)
        setPriority(process.pid, 0)
        onTestFinished(() => setPriority(process.pid, own))
        expect(getPriority(process.pid)).toBe(0)
        const terminal = await start(run, setup)
        const shell = shellOf(run, terminal)
        expect(getPriority(shell)).toBe(terminalPriority)
        // What the shell started: the agent's launcher, and the agent where it has its own
        // process.
        const started = (await processesUnder(shell, { trees })) ?? []
        const children = started.filter((each) => each.parent === shell)
        expect(children).not.toHaveLength(0)
        for (const child of children) expect(getPriority(child.pid)).toBe(terminalPriority)
        // The foreground is the agent's, where the platform tells (macOS).
        const agent = await terminalForeground(shell)
        if (agent !== undefined && agent !== shell)
          expect(getPriority(agent)).toBe(terminalPriority)
        else expect(process.platform).toBe("win32")
      })
    },
  )
}
