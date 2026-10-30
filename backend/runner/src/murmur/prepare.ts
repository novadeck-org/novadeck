// Redacting a digest reads text that people and programs wrote, with patterns that can take
// long on text built to make them. So it is done in a thread of its own, with a deadline (see
// thread.ts): the runner's event loop never runs it, and a digest that takes too long costs
// the thread, not the runner.
import { WorkerThread } from "../thread.js"
import type { Digest } from "./describer.js"
import type { Message } from "./prompt.js"

type PrepareOptions = {
  /** How long a digest may take once the thread is up. */
  readonly deadlineMs?: number
  /** How long the thread may take to come up. */
  readonly startMs?: number
  /** How long it is kept after its last digest. */
  readonly idleMs?: number
  /** The thread's script, for a test to bring its own. */
  readonly script?: URL
}

// Built, the worker is a file beside this one; in the desktop app's bundle it is
// `murmurWorker.js` beside the bundle (see the desktop app's build).
const where = {
  base: import.meta.url,
  built: ["./murmurWorker.js", "./worker.js"],
  source: "./worker.ts",
}

/**
 * What `prepare` answers:
 * - the chat;
 * - `"late"`: the thread did not answer in time and was ended;
 * - `"failed"`: the thread failed on this digest (it said so, or it died);
 * - `"unavailable"`: no thread would start;
 * - `undefined`: nothing was asked of it in the end: the signal aborted, or the preparer was
 *   stopped or closed.
 */
type Prepared = Message[] | "late" | "failed" | "unavailable" | undefined

/**
 * The thread, started when first needed and ended after a while idle, on a timeout, and at
 * close. One digest at a time.
 */
export class Preparer {
  private readonly thread: WorkerThread<Digest, Message[]>

  constructor(options: PrepareOptions = {}) {
    this.thread = new WorkerThread(where, { ...options, deadlineMs: options.deadlineMs ?? 1500 })
  }

  /** Whether a thread is running now. */
  get running(): boolean {
    return this.thread.running
  }

  /** The chat for `digest`, or why there is none (see `Prepared`). */
  async prepare(digest: Digest, signal?: AbortSignal): Promise<Prepared> {
    const outcome = await this.thread.run(digest, signal)
    return typeof outcome === "object" ? outcome.value : outcome
  }

  /** Ends the thread, and refuses to start another. */
  close(): Promise<void> {
    return this.thread.close()
  }

  /** Ends the thread; the next digest starts another. */
  stop(): Promise<void> {
    return this.thread.stop()
  }
}
