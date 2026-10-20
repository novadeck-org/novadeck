/* eslint-disable unicorn/require-post-message-target-origin -- A worker thread's port has no origin. */
// The thread that redacts a digest and writes the chat for the model (see prepare.ts). It
// shares nothing with the runner but the messages it is sent and the answers it posts.
import { parentPort } from "node:worker_threads"

import type { Input } from "./describer.js"
import { messages } from "./prompt.js"
import { redactDigest } from "./redact.js"

parentPort?.on("message", (job: { id: number; request: Input }) => {
  try {
    parentPort?.postMessage({ id: job.id, result: messages(redactDigest(job.request)) })
  } catch (error) {
    parentPort?.postMessage({ id: job.id, failed: String(error) })
  }
})
parentPort?.postMessage({ ready: true })
