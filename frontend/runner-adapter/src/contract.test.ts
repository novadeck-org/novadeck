import type { Backend } from "@novadeck/core/port"
import { noTheme } from "@novadeck/terminal-views/theme"
import { parkMs } from "@novadeck/terminal/view"
import { describeBackendContract } from "@novadeck/test-kit/backend-contract"
import { afterAll, vi } from "vitest"

import { pause, runnerBackend, type RunnerBackend } from "./backend"
import { recordingRunner, startTestRunner } from "./testing/runner"

// jsdom has no layout observers, media queries or canvas; xterm falls back without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
})

vi.setConfig({ testTimeout: 10_000 })

// Started before the suite is collected: the contract creates a backend to see what it
// offers, and a backend needs the runner's listing.
const runner = await startTestRunner()
afterAll(() => runner.close())

// Each backend the contract made, by the port it was given, to settle the right one.
const made = new WeakMap<Backend, RunnerBackend>()

// The contract closes every terminal it opened: none may still run a shell once it is done.
// Runs before the runner closes, which afterAll hooks registered earlier do last.
afterAll(async () => {
  const sessionIds = runner.listing.flatMap(({ sessions }) =>
    sessions.map(({ session }) => session.id),
  )
  const listed = await Promise.all(
    sessionIds.map((sessionId) => runner.client.terminals.list({ sessionId })),
  )
  const running = listed.flat().filter((terminal) => terminal.started && terminal.exit === null)
  if (running.length)
    throw new Error(
      `The contract left ${running.length} shells running (a test that failed after stopping ` +
        `its backend can't close its own): ${JSON.stringify(running)}`,
    )
})

describeBackendContract("runner", {
  create: () => {
    const io: string[] = []
    const created = runnerBackend(recordingRunner(runner.client, io), runner.listing, {
      theme: noTheme,
      saveDelay: 10,
      transcripts: true,
    })
    made.set(created.backend, created)
    return {
      backend: created.backend,
      probe: { holds: created.holds, io: () => io },
      driver: {
        // Ends the shell from this client, as the person could from inside it.
        status: async (key, status) => {
          await created.idle()
          const attached = await runner.client.terminals
            .attach(key.terminalId)
            .catch(() => undefined)
          if (!attached) return
          if (status.state === "exited") {
            // A shell that exits sooner counts as failing to start.
            await pause(2_100)
            await attached.write(`exit ${status.exitCode}\r`)
          } else await runner.client.terminals.close(key.terminalId).catch(() => {})
          for await (const event of attached) if (event.type === "exited") break
          // The adapter hears of the exit on its own stream.
          await pause(100)
        },
      },
    }
  },
  settle: async (backend) => {
    await made.get(backend)?.idle()
  },
  parkMs,
})
