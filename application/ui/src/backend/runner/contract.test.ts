import { afterAll, vi } from "vitest"

import { describeBackendContract } from "../../test/backend-contract"
import { runnerBackend, type RunnerBackend } from "./backend"
import { pause } from "./pause"
import { recordingRunner, startTestRunner } from "./testing"

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

let latest: RunnerBackend | undefined

describeBackendContract("runner", {
  create: () => {
    const io: string[] = []
    const created = runnerBackend(recordingRunner(runner.client, io), runner.listing, {
      saveDelay: 10,
    })
    latest = created
    return {
      backend: created.backend,
      probe: { holds: created.holds, io: () => io },
      driver: {
        // Ends the shell from this client, as the person could from inside it.
        status: async (key, status) => {
          await latest?.idle()
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
          // The adapter hears of the exit on its own subscription.
          await pause(100)
        },
      },
    }
  },
  settle: async () => {
    await latest?.idle()
  },
})
