import type { Backend, CreateBackend } from "../port"
import { createDemoTerminal } from "./DemoTerminal"
import { createDemoEngine, type DemoEngine } from "./engine"
import { createMockTerminal, demoSeed } from "./samples"

// A self-contained backend with sample projects and simulated terminals.
export const demoBackend = (engine: DemoEngine): Backend => ({
  seed: demoSeed(Date.now()),
  newTerminal: ({ number, directory }) => createMockTerminal(number, directory),
  commit: engine.reconcile,
  TerminalSurface: createDemoTerminal(engine),
})

export const createDemoBackend: CreateBackend = () => demoBackend(createDemoEngine())
