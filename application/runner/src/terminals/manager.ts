import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import { delimiter, isAbsolute, resolve as resolvePath } from "node:path"

import type { TerminalAttached, TerminalEvent, TerminalSummary } from "@novadeck/protocol"
import { SerializeAddon } from "@xterm/addon-serialize"
import type { SerializeAddon as Serializer } from "@xterm/addon-serialize"
import headless from "@xterm/headless"
import type { Terminal as Screen } from "@xterm/headless"
import * as pty from "node-pty"

import { DomainError } from "../errors.js"
import { snapshot } from "./snapshot.js"
import { Subscription } from "./subscription.js"

const { Terminal } = headless
const OUTPUT_CHARS = 4096

export type TerminalOptions = {
  shell?: string
  shellArgs?: readonly string[]
  env?: NodeJS.ProcessEnv
  maxTerminals?: number
  historyBytes?: number
  subscriberBytes?: number
  snapshotBytes?: number
  ackWindowBytes?: number
}

type Create = { sessionId: string; cwd: string; cols: number; rows: number }
type Attach = { terminalId: string; afterSequence?: number; mode?: "control" | "observe" }
type Retained = { event: TerminalEvent; bytes: number }
type Record = {
  summary: TerminalSummary
  process: pty.IPty
  screen: Screen
  serializer: Serializer
  sequence: number
  history: Retained[]
  historyBytes: number
  subscribers: Map<string, Subscription>
  controller: string | undefined
  chain: Promise<void>
  pendingReads: number
  pendingAttachments: number
  exitQueued: boolean
  exited: Promise<void>
  resolveExit: () => void
  listeners: pty.IDisposable[]
  closing: Promise<void> | undefined
}

const positive = (value: number | undefined, fallback: number): number => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1)
    throw new RangeError("Terminal limits must be positive integers.")
  return result
}

/** Owns PTYs for one runner lifetime. Old exited, unattached records are evicted at capacity. */
export class Terminals {
  private readonly records = new Map<string, Record>()
  private readonly pendingOwners = new Map<string, Set<{ released: boolean }>>()
  private readonly options: Required<Omit<TerminalOptions, "env">> & {
    env: NodeJS.ProcessEnv
  }
  private creating = 0
  private stopping = false
  private shutdownPromise: Promise<void> | undefined

  constructor(options: TerminalOptions = {}) {
    this.options = {
      shell:
        options.shell ??
        (process.platform === "win32"
          ? (process.env.COMSPEC ?? "cmd.exe")
          : (process.env.SHELL ?? "/bin/sh")),
      shellArgs: options.shellArgs ?? [],
      env: { ...process.env, ...options.env, TERM: "xterm-256color" },
      maxTerminals: positive(options.maxTerminals, 32),
      historyBytes: positive(options.historyBytes, 1024 * 1024),
      subscriberBytes: positive(options.subscriberBytes, 4 * 1024 * 1024),
      snapshotBytes: positive(options.snapshotBytes, 32 * 1024 * 1024),
      ackWindowBytes: positive(options.ackWindowBytes, 256 * 1024),
    }
    // Child programs do not need the runner's network capability.
    delete this.options.env.NOVADECK_TOKEN
  }

  async create(input: Create, ownerId: string): Promise<TerminalSummary> {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    this.evict()
    if (this.records.size + this.creating >= this.options.maxTerminals)
      throw new DomainError("RESOURCE_LIMIT", "Terminal limit reached.")
    this.creating += 1
    const pending = this.pending(ownerId)
    try {
      const cwd = await this.directory(input.cwd)
      const shell = await this.executable(cwd)
      if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
      const screen = new Terminal({
        cols: input.cols,
        rows: input.rows,
        scrollback: 1000,
        allowProposedApi: true,
      })
      const serializer = new SerializeAddon()
      screen.loadAddon(serializer)
      let child: pty.IPty
      try {
        child = pty.spawn(shell, [...this.options.shellArgs], {
          name: "xterm-256color",
          cols: input.cols,
          rows: input.rows,
          cwd,
          env: this.options.env,
          // Windows' built-in console host can lose input; node-pty ships a newer one.
          useConptyDll: process.platform === "win32",
        })
      } catch {
        screen.dispose()
        throw new DomainError("SPAWN_FAILED", "Could not start the configured shell.")
      }
      let resolveExit: (() => void) | undefined
      const exited = new Promise<void>((resolve) => {
        resolveExit = resolve
      })
      const record: Record = {
        summary: {
          id: randomUUID(),
          sessionId: input.sessionId,
          cwd,
          cols: input.cols,
          rows: input.rows,
          status: "running",
          exitCode: null,
        },
        process: child,
        screen,
        serializer,
        sequence: 0,
        history: [],
        historyBytes: 0,
        subscribers: new Map(),
        controller: pending.released ? undefined : ownerId,
        chain: Promise.resolve(),
        pendingReads: 0,
        pendingAttachments: 0,
        exitQueued: false,
        exited,
        resolveExit: () => resolveExit?.(),
        listeners: [],
        closing: undefined,
      }
      this.records.set(record.summary.id, record)
      record.listeners.push(child.onData((data) => this.output(record, data)))
      record.listeners.push(
        // node-pty can report an exit before it learns the code, e.g. after ending a
        // Windows terminal whose input failed.
        child.onExit(({ exitCode, signal }) =>
          this.exit(record, signal ? null : (exitCode ?? null)),
        ),
      )
      // Device-status queries are answered by the runner's screen, even with no viewer.
      record.listeners.push(
        screen.onData((data) => {
          if (!record.exitQueued) child.write(data)
        }),
      )
      return { ...record.summary }
    } finally {
      this.creating -= 1
      this.complete(ownerId, pending)
    }
  }

  list(sessionId?: string): TerminalSummary[] {
    return [...this.records.values()]
      .filter((record) => sessionId === undefined || record.summary.sessionId === sessionId)
      .map((record) => ({ ...record.summary }))
  }

  get(terminalId: string): TerminalSummary {
    return { ...this.record(terminalId).summary }
  }

  write(input: { terminalId: string; data: string }, ownerId: string): void {
    const record = this.control(input.terminalId, ownerId)
    this.running(record)
    // node-pty accepts each write synchronously; no input is retried after an uncertain delivery.
    record.process.write(input.data)
  }

  resize(input: { terminalId: string; cols: number; rows: number }, ownerId: string): void {
    const record = this.control(input.terminalId, ownerId)
    this.running(record)
    record.process.resize(input.cols, input.rows)
    void this.enqueue(record, () => {
      record.screen.resize(input.cols, input.rows)
      record.summary = { ...record.summary, cols: input.cols, rows: input.rows }
      this.emit(record, { type: "resized", cols: input.cols, rows: input.rows })
    })
  }

  async close(input: { terminalId: string }, ownerId: string): Promise<void> {
    const record = this.control(input.terminalId, ownerId)
    if (record.summary.status === "exited") return
    await this.terminate(record)
  }

  /** Streams an `attached` marker once established, then snapshot or replay and live events. */
  async *attach(
    input: Attach,
    ownerId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TerminalAttached | TerminalEvent> {
    const record = this.record(input.terminalId)
    const pending = this.pending(ownerId)
    record.pendingAttachments += 1
    let subscription: Subscription | undefined
    const detach = () => {
      if (!subscription) {
        if (
          (signal?.aborted || pending.released) &&
          !record.subscribers.has(ownerId) &&
          record.controller === ownerId
        )
          record.controller = undefined
        return
      }
      if (record.subscribers.get(ownerId) !== subscription) return
      record.subscribers.delete(ownerId)
      if (record.controller === ownerId) record.controller = undefined
    }
    const abort = () => {
      subscription?.cancel()
      detach()
    }
    signal?.addEventListener("abort", abort, { once: true })
    try {
      await this.enqueue(record, () => {
        if (signal?.aborted || pending.released) return
        if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
        if (record.subscribers.has(ownerId)) throw new DomainError("ALREADY_ATTACHED")
        const mode = input.mode ?? "control"
        if (mode === "control" && record.controller !== undefined && record.controller !== ownerId)
          throw new DomainError("CONTROL_IN_USE")
        const cursor = input.afterSequence
        if (
          cursor !== undefined &&
          (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > record.sequence)
        )
          throw new DomainError("INVALID_CURSOR")
        subscription = new Subscription(
          mode,
          this.options.subscriberBytes,
          this.options.ackWindowBytes,
          detach,
          this.options.snapshotBytes,
        )
        record.subscribers.set(ownerId, subscription)
        if (mode === "control") record.controller = ownerId
        else if (record.controller === ownerId) record.controller = undefined
        const first = record.history[0]?.event.sequence ?? record.sequence + 1
        if (cursor !== undefined && cursor >= first - 1) {
          for (const { event } of record.history)
            if (event.sequence > cursor) subscription.push(event)
        } else {
          subscription.push(
            snapshot(
              record.screen,
              record.serializer,
              record.summary,
              record.sequence,
              this.options.snapshotBytes,
            ),
          )
        }
        if (record.summary.status === "exited") subscription.finish()
      }).finally(() => {
        record.pendingAttachments -= 1
      })
      if (!subscription) return
      // Tells the client that control or observation is established before any event arrives.
      yield { type: "attached", terminalId: input.terminalId, mode: subscription.mode }
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Each delivery waits for consumption ACKs.
        const event = await subscription.next()
        if (event === undefined) return
        yield event
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      subscription?.cancel()
      detach()
      this.complete(ownerId, pending)
    }
  }

  ack(input: { terminalId: string; sequence: number }, ownerId: string): void {
    const record = this.record(input.terminalId)
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0)
      throw new DomainError("INVALID_CURSOR")
    // A final ACK can arrive after natural stream completion or cancellation.
    record.subscribers.get(ownerId)?.ack(input.sequence)
  }

  release(ownerId: string): void {
    for (const pending of this.pendingOwners.get(ownerId) ?? []) pending.released = true
    for (const record of this.records.values()) {
      record.subscribers.get(ownerId)?.cancel()
      record.subscribers.delete(ownerId)
      if (record.controller === ownerId) record.controller = undefined
    }
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.stopping = true
    this.shutdownPromise = this.stop()
    return this.shutdownPromise
  }

  private async stop(): Promise<void> {
    await Promise.all([...this.records.values()].map((record) => this.terminate(record)))
    for (const record of this.records.values()) {
      for (const subscription of record.subscribers.values()) subscription.cancel()
      record.subscribers.clear()
      record.controller = undefined
      this.dispose(record)
    }
    this.records.clear()
    this.pendingOwners.clear()
  }

  private record(id: string): Record {
    const record = this.records.get(id)
    if (!record) throw new DomainError("TERMINAL_NOT_FOUND")
    return record
  }

  private pending(ownerId: string): { released: boolean } {
    const pending = { released: false }
    const entries = this.pendingOwners.get(ownerId) ?? new Set<{ released: boolean }>()
    entries.add(pending)
    this.pendingOwners.set(ownerId, entries)
    return pending
  }

  private complete(ownerId: string, pending: { released: boolean }): void {
    const entries = this.pendingOwners.get(ownerId)
    entries?.delete(pending)
    if (entries?.size === 0) this.pendingOwners.delete(ownerId)
  }

  private control(id: string, ownerId: string): Record {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    const record = this.record(id)
    if (record.controller !== ownerId) throw new DomainError("CONTROL_REQUIRED")
    return record
  }

  private running(record: Record): void {
    if (record.summary.status !== "running" || record.exitQueued || record.closing)
      throw new DomainError("TERMINAL_EXITED")
  }

  private async directory(cwd: string): Promise<string> {
    try {
      if (!isAbsolute(cwd)) throw new Error("Relative directory")
      const path = await realpath(cwd)
      if (!(await stat(path)).isDirectory()) throw new Error("Not a directory")
      await access(path, constants.R_OK | (process.platform === "win32" ? 0 : constants.X_OK))
      return path
    } catch {
      throw new DomainError(
        "INVALID_DIRECTORY",
        "Terminal working directory must be an accessible absolute directory.",
      )
    }
  }

  private async executable(cwd: string): Promise<string> {
    const shell = this.options.shell
    const paths =
      isAbsolute(shell) || shell.includes("/") || shell.includes("\\")
        ? [resolvePath(cwd, shell)]
        : (this.options.env.PATH ?? this.options.env.Path ?? "")
            .split(delimiter)
            .map((path) => resolvePath(cwd, path, shell))
    const suffixes =
      process.platform === "win32"
        ? ["", ...(this.options.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
        : [""]
    const candidates = paths.flatMap((path) => suffixes.map((suffix) => `${path}${suffix}`))
    const available = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          if (!(await stat(candidate)).isFile()) return undefined
          await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK)
          return candidate
        } catch {
          return undefined
        }
      }),
    )
    const executable = available.find((candidate) => candidate !== undefined)
    if (executable) return executable
    throw new DomainError("SPAWN_FAILED", "Configured shell must be an executable file.")
  }

  private enqueue<T>(record: Record, operation: () => T | Promise<T>): Promise<T> {
    const result = record.chain.then(operation)
    record.chain = result.then(
      () => {},
      () => {},
    )
    return result
  }

  private output(record: Record, data: string): void {
    record.process.pause()
    record.pendingReads += 1
    void this.enqueue(record, async () => {
      await new Promise<void>((resolve) => record.screen.write(data, resolve))
      for (let start = 0; start < data.length;) {
        let end = Math.min(start + OUTPUT_CHARS, data.length)
        const last = data.charCodeAt(end - 1)
        if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1
        const chunk = data.slice(start, end)
        this.emit(record, { type: "output", data: chunk })
        start = end
      }
    }).finally(() => {
      record.pendingReads -= 1
      if (record.pendingReads === 0 && !record.exitQueued) record.process.resume()
    })
  }

  private emit(
    record: Record,
    payload:
      | Omit<Extract<TerminalEvent, { type: "output" }>, "terminalId" | "sequence">
      | Omit<Extract<TerminalEvent, { type: "resized" }>, "terminalId" | "sequence">
      | Omit<Extract<TerminalEvent, { type: "exited" }>, "terminalId" | "sequence">,
  ): void {
    const event: TerminalEvent = {
      ...payload,
      terminalId: record.summary.id,
      sequence: ++record.sequence,
    }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    record.history.push({ event, bytes })
    record.historyBytes += bytes
    while (record.historyBytes > this.options.historyBytes)
      record.historyBytes -= record.history.shift()!.bytes
    for (const subscription of record.subscribers.values()) subscription.push(event)
  }

  private exit(record: Record, exitCode: number | null): void {
    if (record.exitQueued) return
    record.exitQueued = true
    void this.enqueue(record, () => {
      record.summary = { ...record.summary, status: "exited", exitCode }
      this.emit(record, { type: "exited", exitCode })
      for (const subscription of record.subscribers.values()) subscription.finish()
      record.resolveExit()
    })
  }

  private terminate(record: Record): Promise<void> {
    if (record.closing) return record.closing
    if (record.summary.status === "exited") return record.exited
    record.closing = this.kill(record)
    return record.closing
  }

  private async kill(record: Record): Promise<void> {
    // The second signal bounds shutdown even for shells that ignore SIGHUP.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      try {
        record.process.kill()
      } catch {
        this.exit(record, null)
      }
      timer = setTimeout(() => {
        try {
          record.process.kill("SIGKILL")
        } catch {
          this.exit(record, null)
        }
      }, 1000)
      await record.exited
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private evict(): void {
    for (const [id, record] of this.records) {
      if (this.records.size + this.creating < this.options.maxTerminals) return
      if (
        record.summary.status !== "exited" ||
        record.subscribers.size > 0 ||
        record.pendingAttachments > 0
      )
        continue
      this.dispose(record)
      this.records.delete(id)
    }
  }

  private dispose(record: Record): void {
    for (const listener of record.listeners) listener.dispose()
    record.screen.dispose()
  }
}
