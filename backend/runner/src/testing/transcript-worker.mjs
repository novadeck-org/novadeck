/* eslint-disable unicorn/require-post-message-target-origin -- A worker thread's port has no origin. */
// Stands in for the thread that masks a transcript's secrets (terminals/redactionWorker.ts) in
// tests: it answers every transcript with its text in capitals, except "hang", which it never
// finishes, as a pattern stuck on text built to stall it would, and "fail", which it throws on.
import { parentPort } from "node:worker_threads"

parentPort?.on("message", ({ id, request }) => {
  if (request.text === "hang") for (;;);
  if (request.text === "fail") {
    parentPort?.postMessage({ id, failed: "boom" })
    return
  }
  parentPort?.postMessage({ id, result: request.text.toUpperCase() })
})
parentPort?.postMessage({ ready: true })
