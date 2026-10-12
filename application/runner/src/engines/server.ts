import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { EngineError } from "./unpack.js"

/**
 * How to run an engine's program; the program itself unless a test stands in for it.
 * `env` is added to the environment the server asks for, which a test can use to steer
 * its stand-in.
 */
export type Launch = (
  program: string,
  args: readonly string[],
) => {
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

// What llama.cpp and its libraries read for every option the command line leaves unset:
// tools, MCP servers, cache types, endpoints and the port among them. Nothing of the
// person's shell may configure an engine. (GGML_* stays: it picks backends and devices.)
// Windows names its variables without regard to case.
const asIs: Launch = (command, args) => ({ command, args })

const engineOwn = /^(LLAMA_|LLAMACPP_|AIP_|HF_|LLGUIDANCE_)/i

/** The environment an engine runs in: this process's without the engines' own settings, plus `extra`. */
export const engineEnvironment = (
  extra?: Readonly<Record<string, string>>,
): Record<string, string> => {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !engineOwn.test(name)) environment[name] = value
  return { ...environment, ...extra }
}

/**
 * Runs an engine's program once to completion, started as a server is: through `launch`,
 * from the temporary folder and in the engine environment. Never rejects: it answers with
 * what it printed and its exit `code` (`null` when it did not exit by itself). `failure` says
 * in words why it could not run or finish (the spawn error, or that it timed out), and is
 * absent when it ran and exited, whatever its code, and when `signal` aborted it.
 */
export const runEngineOnce = (
  launch: Launch | undefined,
  program: string,
  args: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string>>
    readonly signal?: AbortSignal
    readonly timeoutMs?: number
  } = {},
): Promise<{ stdout: string; stderr: string; code: number | null; failure?: string }> => {
  const timeoutMs = options.timeoutMs ?? 30_000
  const launched = (launch ?? asIs)(program, args)
  return new Promise((resolve) => {
    execFile(
      launched.command,
      [...launched.args],
      {
        cwd: tmpdir(),
        timeout: timeoutMs,
        windowsHide: true,
        ...(options.signal && { signal: options.signal }),
        env: engineEnvironment({ ...options.env, ...launched.env }),
      },
      (error, stdout, stderr) => {
        const printed = { stdout: String(stdout), stderr: String(stderr) }
        if (error === null) return resolve({ ...printed, code: 0 })
        if (options.signal?.aborted) return resolve({ ...printed, code: null })
        // A number is the program's own exit status; anything else is why it did not get to one.
        if (typeof error.code === "number") return resolve({ ...printed, code: error.code })
        resolve({
          ...printed,
          code: null,
          failure:
            error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "printed more than its output may hold"
              : error.killed
                ? `timed out after ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}`
                : error.message,
        })
      },
    )
  })
}

// Lines that say a start failed without saying why: the engines end with them.
const generic = /failed to load model|exiting due to|cleaning up before exit|common_fit_params/i
const causeLine = /error|fail|out of memory|unable|cannot|invalid/i

// What servers print once they serve: llama.cpp's "listening on http://..." and whisper's
// "whisper server listening at http://...".
const serving = /listening (on|at) http/i
const prefix = /^\s*\d+(\.\d+)+ [A-Z] /

/**
 * What a failing server last said that a person can use. A server that never served failed
 * to start: its last two lines naming a cause (llama.cpp ends with generic lines, and the
 * real reason comes a few lines before them). One that did serve failed later, and what it
 * said while starting was no cause, so only its lines after that count. Without such lines,
 * its last two. Less its log prefix.
 */
const whatItSaid = (output: readonly string[]): string => {
  const lines = output.filter((line) => !/^\s*$/.test(line)).map((line) => line.replace(prefix, ""))
  const served = lines.findLastIndex((line) => serving.test(line))
  const causes = [
    ...new Set(
      lines.slice(served + 1).filter((line) => causeLine.test(line) && !generic.test(line)),
    ),
  ]
  return (causes.length > 0 ? causes.slice(-2) : lines.slice(-2)).join(" ")
}

/** What an engine's server is, and how it is run: everything its program does not share with the others. */
export type ServerSpec<Config extends { readonly folder: string }, Facts> = {
  /** The program's file name inside the config's folder. */
  readonly program: string
  /** The words that start its failures: "Voice input" in "Voice input failed: ...". */
  readonly subject: string
  /** Where the server answers once it can serve, under its request path. */
  readonly health: string
  /** What tells one start from another: the same key shares a process, a new one starts another. */
  key(config: Config): string
  /**
   * The server's arguments for `port`. A `path` is the unguessable prefix every request goes
   * under, so no web page can reach the server; `env` is added to the process's environment,
   * as a secret is better there than in arguments anyone can list; `headers` go with every
   * request made of it, as the credential that goes with that secret.
   */
  prepare(
    config: Config,
    port: number,
  ): {
    readonly args: readonly string[]
    readonly path?: string
    readonly env?: Readonly<Record<string, string>>
    readonly headers?: Readonly<Record<string, string>>
  }
  /** What it knows of a running server when it starts, to be filled in from its log. */
  facts(): Facts
  /** Hears each line the server logs, with the facts to fill in. */
  onLine?(line: string, facts: Facts): void
}

export type Running<Facts> = {
  readonly key: string
  /** The path every request goes under, empty when the server has no prefix. */
  readonly path: string
  readonly port: number
  /** Headers every request carries, from the spec. */
  readonly headers: Readonly<Record<string, string>>
  readonly child: ChildProcess
  readonly output: string[]
  readonly exited: Promise<void>
  readonly facts: Facts
  /** Resolves with the port once the server answers. */
  ready: Promise<number>
  stopped: boolean
}

export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port)
        else reject(new Error("No free port."))
      })
    })
  })

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * An engine's server on a loopback port: started when first needed, kept warm for a
 * while, and started again after it stops or its config changes. One runs at a time.
 */
export class Server<Config extends { readonly folder: string }, Facts> {
  private running: Running<Facts> | undefined
  private idle: NodeJS.Timeout | undefined
  private closed = false
  private queue: Promise<void> = Promise.resolve()
  // Counts stops, so a start that began before one knows it must not outlive it.
  private generation = 0
  // The server being started, which a stop ends without waiting for the queue.
  private starting: Running<Facts> | undefined

  constructor(
    private readonly spec: ServerSpec<Config, Facts>,
    private readonly options: {
      launch?: Launch | undefined
      /** How long the server stays loaded once nothing needs it. */
      idleMs?: number | undefined
      /** How long it may take to load its model. */
      startMs?: number | undefined
    } = {},
  ) {}

  /** What the running server has said of itself; `undefined` when none runs. */
  get facts(): Facts | undefined {
    return this.running?.facts
  }

  /** Starts the server, or finds it started, and answers when it serves. */
  async start(config: Config): Promise<void> {
    await this.acquire(config)
  }

  /** Starts the server, or finds it started, and answers with it once it serves; idle counts from now. */
  async acquire(config: Config): Promise<Running<Facts>> {
    const running = await this.enqueue(() => this.ensureNow(config))
    await running.ready
    this.touch(running)
    return running
  }

  /** Counts the server as used just now, so it stays loaded for another idle period. */
  touch(running: Running<Facts>): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(
      () => {
        if (this.running === running && !this.starting) void this.stop()
      },
      this.options.idleMs ?? 10 * 60 * 1000,
    )
    this.idle.unref()
  }

  /** A message for a person: what went wrong, and the last thing the server said. */
  explain(running: Running<Facts>, what: string, cause?: unknown): string {
    const detail = whatItSaid(running.output)
    const why = cause instanceof Error ? ` (${cause.message})` : ""
    const message = `${this.spec.subject} failed: ${what}${why}. ${detail}`.trim()
    return message.length > 900 ? `${message.slice(0, 897)}...` : message
  }

  /**
   * Makes a request of the running server: `path` goes after its request prefix, and the
   * headers its spec asked for go with it unless `init` sets them. A
   * server that did not answer is explained with what it last said, after a moment for
   * a crash to show.
   */
  async request(
    running: Running<Facts>,
    path: string,
    init: RequestInit & { signal: AbortSignal },
  ): Promise<Response> {
    try {
      const headers = new Headers(running.headers)
      for (const [name, value] of new Headers(init.headers)) headers.set(name, value)
      return await fetch(`http://127.0.0.1:${running.port}${running.path}${path}`, {
        ...init,
        headers,
      })
    } catch (error) {
      // A crashed server has exited by the time its socket closes.
      await Promise.race([running.exited, sleep(200)])
      throw new EngineError(this.explain(running, "the engine did not answer", error))
    }
  }

  /** Ends the server, if it runs, once it has stopped. */
  async stop(): Promise<void> {
    this.generation += 1
    // A server still loading would otherwise be ended only after it finished.
    if (this.starting) void this.end(this.starting)
    await this.enqueue(async () => {
      clearTimeout(this.idle)
      const running = this.running
      this.running = undefined
      if (running) await this.end(running)
    })
  }

  /** Ends the server and refuses to start another. */
  async close(): Promise<void> {
    this.closed = true
    await this.stop()
  }

  // One at a time, so starting, stopping and a clip's warm-up never overlap and two
  // servers never run.
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async ensureNow(config: Config): Promise<Running<Facts>> {
    if (this.closed) throw new EngineError("Novadeck is closing.")
    const generation = this.generation
    const key = this.spec.key(config)
    const current = this.running
    if (current?.key === key && !current.stopped) {
      this.touch(current)
      return current
    }
    if (current) {
      this.running = undefined
      await this.end(current)
    }
    const running = await this.launch(config, key)
    this.starting = running
    try {
      await running.ready
      // A stop or close that came while it loaded ended it, or must: nothing may outlive it.
      if (generation !== this.generation || this.closed)
        throw new EngineError("The engine was stopped while it started.")
      this.running = running
      // Idle from when it can answer, not from when it started loading.
      this.touch(running)
    } catch (error) {
      if (this.running === running) this.running = undefined
      await this.end(running)
      throw generation !== this.generation || this.closed
        ? new EngineError("The engine was stopped while it started.")
        : error
    } finally {
      if (this.starting === running) this.starting = undefined
    }
    return running
  }

  private async launch(config: Config, key: string): Promise<Running<Facts>> {
    const port = await freePort()
    const program = join(config.folder, this.spec.program)
    const prepared = this.spec.prepare(config, port)
    const launched = (this.options.launch ?? asIs)(program, prepared.args)
    const child = spawn(launched.command, [...launched.args], {
      // Not the engine's folder: Windows can't remove a folder a process works in, which
      // would keep an update or uninstall from removing it. The engine finds its libraries
      // beside its program, whatever its working directory.
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: engineEnvironment({ ...prepared.env, ...launched.env }),
    })
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
    const running: Running<Facts> = {
      key,
      path: prepared.path ?? "",
      port,
      headers: prepared.headers ?? {},
      child,
      output: [],
      exited,
      facts: this.spec.facts(),
      ready: Promise.resolve(port),
      stopped: false,
    }
    for (const stream of [child.stdout, child.stderr]) this.collect(running, stream)
    child.once("close", () => {
      running.stopped = true
      if (this.running === running) this.running = undefined
    })
    running.ready = this.waitReady(running, port)
    // The caller sees a failure through `ready`; this keeps an unwatched one from ending the runner.
    running.ready.catch(() => {})
    return running
  }

  private collect(running: Running<Facts>, stream: NodeJS.ReadableStream): void {
    let partial = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
      const lines = (partial + chunk).split(/\r?\n/)
      partial = lines.pop() ?? ""
      for (const line of lines) {
        if (line.trim() === "") continue
        running.output.push(line)
        if (running.output.length > 40) running.output.shift()
        this.spec.onLine?.(line, running.facts)
      }
    })
  }

  private async waitReady(running: Running<Facts>, port: number): Promise<number> {
    const failed = new Promise<never>((_, reject) => {
      running.child.once("error", (error) =>
        reject(new EngineError(`The engine could not start: ${error.message}`)),
      )
      running.child.once("close", () =>
        reject(new EngineError(this.explain(running, "the engine stopped while starting"))),
      )
    })
    failed.catch(() => {})
    const poll = async (): Promise<number> => {
      const deadline = Date.now() + (this.options.startMs ?? 120_000)
      while (Date.now() < deadline) {
        if (running.stopped) throw new EngineError(this.explain(running, "the engine stopped"))
        try {
          // eslint-disable-next-line no-await-in-loop -- One probe at a time.
          const response = await fetch(
            `http://127.0.0.1:${port}${running.path}${this.spec.health}`,
            { signal: AbortSignal.timeout(2000) },
          )
          if (response.ok) return port
          // Not answering yet, or a stranger on the port: the engine must say so itself.
          // eslint-disable-next-line no-await-in-loop -- Wait between probes.
          await sleep(100)
        } catch {
          // eslint-disable-next-line no-await-in-loop -- Wait between probes.
          await sleep(100)
        }
      }
      throw new EngineError(this.explain(running, "the engine took too long to start"))
    }
    return Promise.race([poll(), failed])
  }

  private async end(running: Running<Facts>): Promise<void> {
    running.stopped = true
    if (
      running.child.pid !== undefined &&
      running.child.exitCode === null &&
      running.child.signalCode === null
    ) {
      running.child.kill()
      // A program that ignores its end is ended for good.
      const force = setTimeout(() => running.child.kill("SIGKILL"), 3000)
      await running.exited
      clearTimeout(force)
    }
  }
}

/** A random hex token for a request path or a key: unguessable, fresh for each start. */
export const token = (): string => randomUUID().replaceAll("-", "")
