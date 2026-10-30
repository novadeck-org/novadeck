import { describeBackendContract } from "@novadeck/test-kit/backend-contract"
import { vi } from "vitest"

import { demoBackend } from "./index"
import { createDemoEngine } from "./terminals/engine"

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

// The demo simulates everything in memory, so it never starts I/O.
describeBackendContract("demo", {
  create: () => {
    const engine = createDemoEngine()
    return { backend: demoBackend(engine), probe: { holds: engine.has, io: () => [] } }
  },
})
