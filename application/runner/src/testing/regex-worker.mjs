/* eslint-disable unicorn/require-post-message-target-origin -- A worker thread's port has no origin. */
// Stands in for the thread that redacts digests: it answers at once, except a digest whose
// project is "regex", which it runs through a pattern that backtracks without end, as a
// regex on text built against it would. Only ending the thread stops it.
import { parentPort } from "node:worker_threads"

parentPort?.on("message", ({ id, digest }) => {
  if (digest.project === "regex") /(a+)+$/.test(`${"a".repeat(40)}b`)
  parentPort?.postMessage({ id, chat: [{ role: "user", content: `about ${digest.project}` }] })
})
parentPort?.postMessage({ ready: true })
