// Some work reads text that people and programs wrote, with patterns that can take long on
// text built to make them. It is done in a thread of its own, with a deadline: the runner's
// event loop never runs it, and a job that takes too long costs the thread, not the runner.
// This is that thread's side of the runner: starting it, handing it one job at a time and
// ending it. What the jobs are is the caller's and its script's.
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"

export type ThreadOptions = {
  /** How long a job may take once the thread is up. */
  readonly deadlineMs: number
  /** How long the thread may take to come up. */
  readonly startMs?: number
  /** How long it is kept after its last job. */
  readonly idleMs?: number
  /** The thread's script, for a test to bring its own. */
  readonly script?: URL
}

/** Where a thread's script is, relative to the module that runs it. */
export type ThreadScript = {
  /** The module's own URL (`import.meta.url`). */
  readonly base: string
  /** The names it has when built, or in the desktop app's bundle, first found wins. */
  readonly built: readonly string[]
  /** The TypeScript file, for development and tests. */
  readonly source: string
}

/**
 * What a job comes to:
 * - `{ value }`: what the script answered;
 * - `"late"`: the thread did not answer in time and was ended;
 * - `"failed"`: the thread failed on this job (it said so, or it died);
 * - `"unavailable"`: no thread would start;
 * - `undefined`: nothing was asked of it in the end: the signal aborted, or the thread was
 *   stopped or closed.
 */
export type Outcome<Result> = { value: Result } | "late" | "failed" | "unavailable" | undefined

// A script that runs here, and the options to run it with.
const resolveScript = (where: ThreadScript): { url: URL; execArgv: string[] } => {
  // (Names are variables, so a bundler does not take them for assets to copy.)
  for (const name of where.built) {
    const url = new URL(name, where.base)
    if (existsSync(fileURLToPath(url))) return { url, execArgv: [] }
  }
  // From source, as in development and tests: the TypeScript file, through tsx, with the
  // workspace's packages read from their sources too.
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href
  return {
    url: new URL(where.source, where.base),
    execArgv: ["--conditions=development", "--import", loader],
  }
}

// The script posts `{ ready: true }` once, then answers each `{ id, request }` it is sent with
// `{ id, result }`, or `{ id, failed }` when the job threw.
type Reply = { id?: number; ready?: true; result?: unknown; failed?: string }

/**
 * The thread, started when first needed and ended after a while idle, on a timeout, and at
 * close. One job at a time.
 */
export class WorkerThread<Request, Result> {
  private worker: Worker | undefined
  private starting: Promise<Worker | "unavailable" | undefined> | undefined
  private idle: NodeJS.Timeout | undefined
  private closed = false
  private next = 0
  // Counts stops, so a thread that was launched before one is ended when it comes up.
  private generation = 0

  constructor(
    private readonly where: ThreadScript,
    private readonly options: ThreadOptions,
  ) {}

  /** Whether a thread is running now. */
  get running(): boolean {
    return this.worker !== undefined
  }

  /** What the thread makes of `request`, or why it makes nothing (see `Outcome`). */
  async run(request: Request, signal?: AbortSignal): Promise<Outcome<Result>> {
    const worker = await this.start()
    if (worker === "unavailable") return signal?.aborted ? undefined : worker
    if (worker === undefined || signal?.aborted) return undefined
    this.touch()
    const id = (this.next += 1)
    const generation = this.generation
    return new Promise((resolve) => {
      const done = (value: Outcome<Result>): void => {
        clearTimeout(timer)
        worker.off("message", onMessage)
        worker.off("error", onFailure)
        worker.off("exit", onFailure)
        signal?.removeEventListener("abort", onAbort)
        resolve(value)
      }
      const onMessage = (reply: Reply): void => {
        if (reply.id !== id) return
        done(reply.failed === undefined ? { value: reply.result as Result } : "failed")
      }
      const onFailure = (): void => {
        this.discard(worker)
        // Ended by a stop or close is no failure of the thread's.
        done(generation === this.generation && !this.closed ? "failed" : undefined)
      }
      // The thread may be in the middle of this job: ended, or it would go on spinning.
      const onAbort = (): void => {
        this.discard(worker)
        done(undefined)
      }
      const timer = setTimeout(() => {
        // Whatever it is doing is not stopped by asking: the thread is ended.
        this.discard(worker)
        done("late")
      }, this.options.deadlineMs)
      worker.on("message", onMessage)
      worker.once("error", onFailure)
      worker.once("exit", onFailure)
      signal?.addEventListener("abort", onAbort, { once: true })
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- A worker thread's port has no origin.
      worker.postMessage({ id, request })
    })
  }

  /** Ends the thread, and refuses to start another. */
  async close(): Promise<void> {
    this.closed = true
    await this.stop()
  }

  /** Ends the thread; the next job starts another. */
  async stop(): Promise<void> {
    clearTimeout(this.idle)
    this.generation += 1
    const worker = this.worker
    this.worker = undefined
    this.starting = undefined
    await worker?.terminate()
  }

  private discard(worker: Worker): void {
    if (this.worker === worker) this.worker = undefined
    void worker.terminate()
  }

  private touch(): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => void this.stop(), this.options.idleMs ?? 2 * 60 * 1000)
    this.idle.unref()
  }

  private start(): Promise<Worker | "unavailable" | undefined> {
    if (this.closed) return Promise.resolve(undefined)
    if (this.worker) return Promise.resolve(this.worker)
    this.starting ??= this.launch().then((worker) => {
      this.starting = undefined
      return worker
    })
    return this.starting
  }

  // A worker; `"unavailable"` when none would start; `undefined` when a stop or close came
  // first, so the one that came up is ended.
  private launch(): Promise<Worker | "unavailable" | undefined> {
    const generation = this.generation
    return new Promise((resolve) => {
      let worker: Worker
      try {
        const script = this.options.script
          ? { url: this.options.script, execArgv: [] }
          : resolveScript(this.where)
        worker = new Worker(script.url, { execArgv: script.execArgv })
      } catch {
        resolve("unavailable")
        return
      }
      const fail = (): void => {
        clearTimeout(timer)
        void worker.terminate()
        resolve(generation === this.generation && !this.closed ? "unavailable" : undefined)
      }
      const timer = setTimeout(fail, this.options.startMs ?? 20_000)
      worker.once("error", fail)
      worker.once("exit", fail)
      worker.once("message", (reply: Reply) => {
        if (!reply.ready) return fail()
        clearTimeout(timer)
        worker.off("error", fail)
        worker.off("exit", fail)
        if (this.closed || generation !== this.generation) {
          void worker.terminate()
          return resolve(undefined)
        }
        this.worker = worker
        worker.unref()
        worker.once("exit", () => {
          if (this.worker === worker) this.worker = undefined
        })
        // An error between jobs must not become an uncaught exception.
        worker.on("error", () => this.discard(worker))
        resolve(worker)
      })
    })
  }
}
