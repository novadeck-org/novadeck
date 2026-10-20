/* eslint-disable unicorn/require-post-message-target-origin -- A worker thread's port has no origin. */
// The thread that masks the secrets in a transcript (see redaction.ts). It shares nothing with
// the runner but the jobs it is sent and the answers it posts.
import { parentPort } from "node:worker_threads"

import { redactTranscript, type TranscriptInput } from "./transcriptRedaction.js"

parentPort?.on("message", (job: { id: number; request: TranscriptInput }) => {
  redactTranscript(job.request).then(
    (result) => parentPort?.postMessage({ id: job.id, result }),
    (error: unknown) => parentPort?.postMessage({ id: job.id, failed: String(error) }),
  )
})
parentPort?.postMessage({ ready: true })
