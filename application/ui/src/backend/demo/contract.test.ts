import { vi } from "vitest"

import { describeBackendContract } from "../../test/backend-contract"
import { createDemoEngine } from "./engine"
import { demoBackend } from "./index"

// jsdom has no resizes; the demo terminal watches for its output coming back on screen.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

// The demo simulates everything in memory, so it never starts I/O.
describeBackendContract("demo", {
  create: () => {
    const engine = createDemoEngine()
    return { backend: demoBackend(engine), probe: { holds: engine.has, io: () => [] } }
  },
})
