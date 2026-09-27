import { describeBackendContract } from "../../test/backend-contract"
import { createDemoEngine } from "./engine"
import { demoBackend } from "./index"

// The demo simulates everything in memory, so it never starts I/O.
describeBackendContract("demo", {
  create: () => {
    const engine = createDemoEngine()
    return { backend: demoBackend(engine), probe: { holds: engine.has, io: () => [] } }
  },
})
