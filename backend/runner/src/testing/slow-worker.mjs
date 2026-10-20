/* eslint-disable unicorn/require-post-message-target-origin -- A worker thread's port has no origin. */
// Stands in for the thread that redacts digests (murmur/worker.ts) in tests: it answers every
// digest at once, except one whose project is "hang", which it never finishes, as a pattern
// stuck on text built to stall it would.
import { parentPort } from "node:worker_threads"

parentPort?.on("message", ({ id, request: digest }) => {
  if (digest.project === "hang") {
    if (digest.redactionProbe instanceof SharedArrayBuffer) {
      const progress = new Int32Array(digest.redactionProbe)
      Atomics.store(progress, 0, 1)
      Atomics.notify(progress, 0)
      // A real main-thread callback must run while this worker is spinning.
      while (Atomics.load(progress, 1) === 0);
      Atomics.store(progress, 0, 2)
      Atomics.notify(progress, 0)
    }
    // Acknowledging the callback never completes the hanging redaction.
    for (;;);
  }
  parentPort?.postMessage({
    id,
    result: [
      { role: "system", content: "system" },
      { role: "user", content: `about ${digest.project}` },
    ],
  })
})
parentPort?.postMessage({ ready: true })
