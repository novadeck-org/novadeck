import { readFileSync } from "node:fs"

import { terminalForeground, userScopes } from "@novadeck/terminal/pty"

import { setups } from "./agents/index.js"
import type { DeckTerminal } from "./deck.js"
import { describe, e2e, expect, supported, type E2E } from "./fixture.js"
import { start } from "./scenarios.js"

const cgroupOf = (pid: number): string => readFileSync(`/proc/${pid}/cgroup`, "utf8").trim()

const shellOf = (run: E2E, terminal: Pick<DeckTerminal, "id">): number => {
  const inside = run.deck.terminals as unknown as {
    records: Map<string, { terminal: { pty: { pid: number | undefined } } }>
  }
  const shell = inside.records.get(terminal.id)?.terminal.pty.pid
  if (shell === undefined) throw new Error("The terminal has no shell")
  return shell
}

// A shell with nothing in its rc reaches its first prompt in milliseconds, sooner than systemd
// moves it to its scope, and the move takes only the shell: without the wait, its agent stays in
// the app's scope, where running out of memory takes the app and every other terminal with it.
// A run without the user's bus has no scopes to go to; CI has, and may not skip this for want
// of them.
const scoping = userScopes() !== undefined || process.env.GITHUB_ACTIONS === "true"

for (const setup of setups) {
  describe.skipIf(!supported || process.platform !== "linux" || !scoping)(
    `An agent started as its terminal opens in ${setup.name}`,
    () => {
      const it = e2e(setup)

      it("runs in its terminal's own scope", async ({ e2e: run }) => {
        const terminal = await start(run, setup)
        const shell = shellOf(run, terminal)
        expect(cgroupOf(shell)).toMatch(new RegExp(`-term${shell}\\.scope$`))
        const agent = await terminalForeground(shell)
        expect(agent).toBeDefined()
        expect(agent).not.toBe(shell)
        expect(cgroupOf(agent!)).toBe(cgroupOf(shell))
      })
    },
  )
}
