/* eslint-disable unicorn/require-post-message-target-origin -- A worker thread's port has no origin. */
// The thread that redacts a digest and writes the chat for the model (see prepare.ts). It
// shares nothing with the runner but the messages it is sent and the answers it posts.
import { parentPort } from "node:worker_threads"

import type { Digest } from "./describer.js"
import { messages } from "./prompt.js"
import { redactDigest } from "./redact.js"

parentPort?.on("message", (request: { id: number; digest: Digest }) => {
  try {
    parentPort?.postMessage({ id: request.id, chat: messages(redactDigest(request.digest)) })
  } catch (error) {
    parentPort?.postMessage({ id: request.id, failed: String(error) })
  }
})
parentPort?.postMessage({ ready: true })
