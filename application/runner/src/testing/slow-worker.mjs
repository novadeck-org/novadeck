/* eslint-disable unicorn/require-post-message-target-origin -- A worker thread's port has no origin. */
// Stands in for the thread that redacts digests (murmur/worker.ts) in tests: it answers every
// digest at once, except one whose project is "hang", which it never finishes, as a pattern
// stuck on text built to stall it would.
import { parentPort } from "node:worker_threads"

parentPort?.on("message", ({ id, digest }) => {
  if (digest.project === "hang") for (;;);
  parentPort?.postMessage({
    id,
    chat: [
      { role: "system", content: "system" },
      { role: "user", content: `about ${digest.project}` },
    ],
  })
})
parentPort?.postMessage({ ready: true })
