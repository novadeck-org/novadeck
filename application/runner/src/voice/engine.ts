import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { availableParallelism, tmpdir } from "node:os"
import { join } from "node:path"

import { z } from "zod"

import { languageCode } from "./languages.js"

/** Raised when the engine cannot be unpacked, started or used, in words for a person. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EngineError"
  }
}

/** The engine's program inside its folder. */
export const engineProgram = process.platform === "win32" ? "whisper-server.exe" : "whisper-server"

// On Windows the system's own tar: a GNU tar from Git or MSYS that comes first on the
// PATH reads `C:\\...` as a host name and fails.
const tarProgram =
  process.platform === "win32"
    ? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`
    : "tar"

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  )

/** Where engines unpacked from archives live, one folder per archive, under `directory`. */
export const enginesIn = (directory: string): string => join(directory, "engine")

/** The folder an archive with this checksum unpacks to. */
export const engineFolder = (directory: string, sha256: string): string =>
  join(enginesIn(directory), sha256.slice(0, 12))

// Beside the program, the interface the engine was unpacked for, as the manifest named it.
const interfaceMarker = ".interface"

/**
 * The interface of the engine in `folder`: what it was unpacked for, or the first when it
 * was unpacked before there was a marker. A marker that makes no sense matches nothing.
 */
export const engineInterface = async (folder: string): Promise<number> => {
  // Only a marker that is not there is the first interface; one that cannot be read matches nothing.
  const text = await readFile(join(folder, interfaceMarker), "utf8").catch((error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ENOENT" ? undefined : "",
  )
  if (text === undefined) return 1
  return /^\d+$/.test(text.trim()) ? Number(text) : 0
}

/**
 * Unpacks `archive` into its folder under `directory`, marked with the `version` of the
 * interface it speaks, and removes every other engine, which an update has replaced. The
 * system's `tar` does the unpacking, as Windows 10 and later have one too. It unpacks
 * beside the folder and renames it, so one that is there is whole.
 */
export const unpack = async (
  archive: string,
  directory: string,
  sha256: string,
  version: number,
  signal?: AbortSignal,
): Promise<string> => {
  const target = engineFolder(directory, sha256)
  const staging = join(enginesIn(directory), `.unpacking-${randomUUID()}`)
  await mkdir(staging, { recursive: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(tarProgram, ["-xzf", archive, "-C", staging], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        ...(signal && { signal }),
      })
      let errors = ""
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk: string) => (errors = (errors + chunk).slice(-500)))
      child.on("error", (error) =>
        reject(
          signal?.aborted
            ? error
            : new EngineError(`Could not unpack the engine: ${error.message}`),
        ),
      )
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(new EngineError(`Could not unpack the engine: ${errors.trim() || code}`)),
      )
    })
    if (!(await exists(join(staging, engineProgram))))
      throw new EngineError("The engine's archive does not hold the engine for this system.")
    if (process.platform !== "win32") await chmod(join(staging, engineProgram), 0o755)
    await writeFile(join(staging, interfaceMarker), `${version}\n`)
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  for (const entry of await readdir(enginesIn(directory)))
    if (join(enginesIn(directory), entry) !== target)
      await rm(join(enginesIn(directory), entry), { recursive: true, force: true })
  return target
}

/** What a running engine needs: its program, the speech model and the voice activity model. */
export type EngineConfig = {
  readonly folder: string
  readonly model: string
  readonly vad: string
  readonly language: string
}

/** How to run the engine's program; the program itself unless a test stands in for it. */
export type Launch = (
  program: string,
  args: readonly string[],
) => { readonly command: string; readonly args: readonly string[] }

type Running = {
  readonly key: string
  /** The path every request goes under, unguessable, so no web page can reach the engine. */
  readonly path: string
  readonly child: ChildProcess
  readonly output: string[]
  readonly exited: Promise<void>
  /** Whether the engine put the model on a GPU, from its log; unknown until it says. */
  gpu: boolean | undefined
  /** Resolves with the port once the server answers. */
  ready: Promise<number>
  stopped: boolean
}

const freePort = (): Promise<number> =>
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

const reply = z.looseObject({ text: z.string(), language: z.string().optional() })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The speech engine, `whisper-server` on a loopback port: started when first needed,
 * kept warm for a while, and started again after it stops or its model changes.
 */
export class Engine {
  private running: Running | undefined
  private idle: NodeJS.Timeout | undefined
  private closed = false
  private queue: Promise<void> = Promise.resolve()
  // Counts stops, so a start that began before one knows it must not outlive it.
  private generation = 0
  // The engine being started, which a stop ends without waiting for the queue.
  private starting: Running | undefined

  constructor(
    private readonly options: {
      launch?: Launch
      /** How long the engine stays loaded once nothing needs it. */
      idleMs?: number
      /** How long it may take to load its model. */
      startMs?: number
    } = {},
  ) {}

  /** Whether the running engine uses a GPU; `undefined` when none runs or it has not said. */
  get gpu(): boolean | undefined {
    return this.running?.gpu
  }

  /** Starts the engine, or finds it started, and answers when it can transcribe. */
  async start(config: EngineConfig): Promise<void> {
    await (
      await this.ensure(config)
    ).ready
  }

  /** Transcribes a WAV file; `language` of `auto` lets the engine tell. */
  async transcribe(
    config: EngineConfig,
    audio: Uint8Array,
    options: { language: string; prompt?: string | undefined; timeoutMs?: number },
  ): Promise<{ text: string; language: string }> {
    const running = await this.ensure(config)
    const port = await running.ready
    this.touch(running)
    const form = new FormData()
    form.set("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "clip.wav")
    form.set("response_format", "verbose_json")
    form.set("language", options.language)
    form.set("temperature", "0")
    // The server would otherwise detect the language again, to report odds nobody reads.
    form.set("no_language_probabilities", "true")
    if (options.prompt) form.set("prompt", options.prompt)
    let response: Response
    try {
      response = await fetch(`http://127.0.0.1:${port}${running.path}/inference`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      })
    } catch (error) {
      // A crashed engine has exited by the time its socket closes.
      await Promise.race([running.exited, sleep(200)])
      throw new EngineError(this.explain(running, "the engine did not answer", error))
    }
    if (!response.ok)
      throw new EngineError(this.explain(running, `the engine answered ${response.status}`))
    const body = reply.safeParse(await response.json().catch(() => undefined))
    if (!body.success)
      throw new EngineError(this.explain(running, "the engine's answer made no sense"))
    this.touch(running)
    return {
      text: body.data.text.trim(),
      language:
        options.language === "auto" ? languageCode(body.data.language ?? "") : options.language,
    }
  }

  /** Ends the engine, if it runs, once it has stopped. */
  async stop(): Promise<void> {
    this.generation += 1
    // An engine still loading would otherwise be ended only after it finished.
    if (this.starting) void this.end(this.starting)
    await this.enqueue(async () => {
      clearTimeout(this.idle)
      const running = this.running
      this.running = undefined
      if (running) await this.end(running)
    })
  }

  /** Ends the engine and refuses to start another. */
  async close(): Promise<void> {
    this.closed = true
    await this.stop()
  }

  // One at a time, so starting, stopping and a clip's warm-up never overlap and two
  // engines never run.
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    this.queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private ensure(config: EngineConfig): Promise<Running> {
    return this.enqueue(() => this.ensureNow(config))
  }

  private async ensureNow(config: EngineConfig): Promise<Running> {
    if (this.closed) throw new EngineError("Novadeck is closing.")
    const generation = this.generation
    const key = [config.folder, config.model].join("\n")
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

  private async launch(config: EngineConfig, key: string): Promise<Running> {
    const port = await freePort()
    const path = `/${randomUUID().replaceAll("-", "")}`
    const threads = Math.min(8, Math.max(2, Math.floor(availableParallelism() / 2)))
    const program = join(config.folder, engineProgram)
    // Changing these flags, or the requests this class makes of the server, changes the
    // interface: bump `engineInterface` in application/whisper/scripts/build.ts with it.
    const args = [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--request-path",
      path,
      "-m",
      config.model,
      "-l",
      config.language,
      "-nt",
      "-t",
      String(threads),
      "--vad",
      "-vm",
      config.vad,
      // Ends the engine once its stdin closes, which is when this runner is gone, however
      // it went: a runner killed outright never stops it otherwise (see whisper patches).
      "--exit-with-stdin",
    ]
    const { command, args: argv } = (this.options.launch ?? ((p, a) => ({ command: p, args: a })))(
      program,
      args,
    )
    const child = spawn(command, argv, {
      // Not the engine's folder: Windows can't remove a folder a process works in, which
      // would keep an update or uninstall from removing it. The engine finds its libraries
      // beside its program, whatever its working directory.
      cwd: tmpdir(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
    const running: Running = {
      key,
      path,
      child,
      output: [],
      exited,
      gpu: undefined,
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

  private collect(running: Running, stream: NodeJS.ReadableStream): void {
    let partial = ""
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
      const lines = (partial + chunk).split(/\r?\n/)
      partial = lines.pop() ?? ""
      for (const line of lines) {
        if (line.trim() === "") continue
        running.output.push(line)
        if (running.output.length > 40) running.output.shift()
        // The first of these is the speech model's: the voice model loads later.
        if (running.gpu !== undefined) continue
        const backend = /whisper_backend_init_gpu: using (\S+) backend/.exec(line)
        if (backend) running.gpu = !/^cpu/i.test(backend[1] ?? "cpu")
        else if (/whisper_backend_init_gpu: no GPU found/.test(line)) running.gpu = false
      }
    })
  }

  private async waitReady(running: Running, port: number): Promise<number> {
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
          const response = await fetch(`http://127.0.0.1:${port}${running.path}/health`, {
            signal: AbortSignal.timeout(2000),
          })
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

  /** A message for a person: what went wrong, and the last thing the engine said. */
  private explain(running: Running, what: string, cause?: unknown): string {
    const detail = running.output
      .filter((line) => !/^\s*$/.test(line))
      .slice(-2)
      .join(" ")
    const why = cause instanceof Error ? ` (${cause.message})` : ""
    const message = `Voice input failed: ${what}${why}. ${detail}`.trim()
    return message.length > 900 ? `${message.slice(0, 897)}...` : message
  }

  private touch(running: Running): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(
      () => {
        if (this.running === running && !this.starting) void this.stop()
      },
      this.options.idleMs ?? 10 * 60 * 1000,
    )
    this.idle.unref()
  }

  private async end(running: Running): Promise<void> {
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
