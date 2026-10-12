/* eslint-disable unicorn/require-post-message-target-origin -- A worker thread's port has no origin. */
// Stands in for the thread that redacts digests: it answers, then fails a moment later,
// between two digests, as a crash in a callback would.
import { parentPort } from "node:worker_threads"

parentPort?.on("message", ({ id }) => {
  parentPort?.postMessage({ id, chat: [{ role: "user", content: "ok" }] })
  setTimeout(() => {
    throw new Error("boom later")
  }, 50)
})
parentPort?.postMessage({ ready: true })
