import { getPriority, setPriority } from "node:os"

import { relayPath } from "@novadeck/relay"
import { processesUnder, terminalForeground, terminalPriority, Trees } from "@novadeck/terminal/pty"

import { setups } from "./agents/index.js"
import { poll, type DeckTerminal } from "./deck.js"
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

      it("runs at a lowered priority, with its shell", async ({ e2e: run, skip }) => {
        // The shell inherits the suite's priority without any lowering, so the suite must
        // start at normal for what the shell has to be the runner's doing. CI's Windows runs it
        // below normal and its macOS above (nice -10); moving to normal lowers its priority,
        // which is allowed. A suite below normal (nice 10 on macOS, as one started from a
        // Novadeck terminal will be) can't raise itself: that case is skipped.
        try {
          if (getPriority(process.pid) !== 0) setPriority(process.pid, 0)
        } catch {
          // Left as it is, and skipped below.
        }
        if (getPriority(process.pid) !== 0)
          skip(`the suite runs at priority ${getPriority(process.pid)} and can't move to normal`)
        // Not in use, as a terminal in a window looking at another: it opens lowered.
        const terminal = await start(run, setup, { inUse: false })
        const shell = shellOf(run, terminal)
        expect(getPriority(shell)).toBe(terminalPriority)
        // Everything under the shell, the agent's launcher and the agent among them, and what
        // they started (on Windows Codex's npm chain is shell, node, codex). One that has
        // ended since the read is gone, not unlowered.
        let unlowered: readonly string[] = []
        await poll(
          async () => {
            const started = (await processesUnder(shell, { trees })) ?? []
            if (!started.some((each) => each.parent === shell)) {
              unlowered = ["no program under the shell"]
              return undefined
            }
            unlowered = started.flatMap((each) => {
              try {
                const priority = getPriority(each.pid)
                return priority === terminalPriority
                  ? []
                  : [`${each.name ?? each.pid}: ${priority}`]
              } catch {
                return []
              }
            })
            return unlowered.length === 0 ? true : undefined
          },
          () =>
            `every program under the shell ${shell} at priority ${terminalPriority}: ${unlowered.join(", ")}`,
          20_000,
        )
        // The foreground is the agent's, where the platform tells (macOS).
        if (process.platform === "darwin") {
          const agent = await poll(
            async () => {
              const found = await terminalForeground(shell)
              return found !== undefined && found !== shell ? found : undefined
            },
            "the agent in the terminal's foreground",
            10_000,
          )
          expect(getPriority(agent)).toBe(terminalPriority)
        }
      })
    },
  )
}
